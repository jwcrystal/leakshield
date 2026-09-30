import { createHash, createHmac, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Readonly env query service (opt-in `envQueries` plugin option).
 *
 * Lets an agent ask coarse questions about the files listed in
 * `settings.env_files` — which keys exist, whether a key is missing/empty/
 * nonempty, a coarse lexical shape, and whether two keys hold the same value —
 * without ever exposing raw values, lengths, previews, or fingerprints.
 *
 * Security contract:
 * - Only files in the setup-time `env_files` allowlist, resolved inside the
 *   workspace root frozen at construction (canonical path plus device/inode
 *   identity). No symlinks on any path component, regular files only, at
 *   most 16 files of 1 MiB.
 * - File access is best-effort pathname identity validation, not a sandbox.
 *   The root and every ancestor directory are lstat'd before the open and
 *   again after the read; the opened descriptor must be the exact inode the
 *   pre-open lstat authorized (dev/ino binding); the final component is
 *   never followed (O_NOFOLLOW); FIFOs cannot hang the event loop
 *   (O_NONBLOCK); and post-read size/mtime, ancestor-identity, and
 *   canonical-path checks reject observed changes. Stable symlink
 *   substitutions — final component or ancestor, resolving inside or
 *   outside the workspace — are rejected.
 * - What pathname checks cannot do, stated honestly: a concurrent
 *   same-owner mutation that substitutes a component (root, ancestor, or
 *   file) and restores it between the checks — an unobserved ABA race — is
 *   not detectable; hardlink provenance is not checked (a hardlink to an
 *   outside file is indistinguishable from the original); an in-place
 *   rewrite that preserves size and mtime is not distinguishable. This is
 *   not a claim of race-proofing against malicious concurrent mutation.
 * - Values are read fresh on every invocation and retained only for the
 *   duration of the call; nothing parsed is cached or persisted.
 * - File ids are opaque and session-local (HMAC of a per-setup key); they
 *   reveal no path or index and are invalid in other sessions.
 * - The allowlist and its authorization fingerprint come from one
 *   configuration read (see `loadConfigWithFingerprint`). If the
 *   configuration later changes, queries are disabled with a fixed sanitized
 *   error until OpenCode restarts — sticky even if the change is reverted,
 *   and never a silent fallback to the old or new authorization.
 * - This is not hostile-agent isolation and not a trusted baseline: the
 *   agent can modify the queried files through other tools, so results
 *   describe the current file state at query time, never a frozen snapshot
 *   that someone vouched for.
 */

export const MAX_ENV_QUERY_FILES = 16;
const MAX_ENV_QUERY_FILE_SIZE = 1024 * 1024;
export const MAX_FILE_ID_LENGTH = 64;
export const MAX_KEY_NAME_LENGTH = 512;

export type EnvFileUnavailability =
  | "outside_workspace"
  | "symlink"
  | "not_regular_file"
  | "oversize"
  | "unreadable"
  | "malformed";

export type EnvQueryShape = "boolean_like" | "number_like" | "multiline_text" | "text";

export interface EnvListEntry {
  /** Opaque session-local id; only valid in the session it was issued for. */
  file_id: string;
  available: boolean;
  /** Key names only, when available. Never values. */
  keys?: string[];
  /** Fixed sanitized reason code, when unavailable. */
  reason?: EnvFileUnavailability;
}

export type EnvInspectOutcome =
  | { ok: true; status: "unavailable"; reason: EnvFileUnavailability }
  | { ok: true; status: "missing" }
  | { ok: true; status: "empty" }
  | { ok: true; status: "nonempty"; shape: EnvQueryShape };

export type EnvCompareOutcome =
  | { ok: true; result: "equal" }
  | { ok: true; result: "different" }
  | { ok: true; result: "unavailable"; reason?: EnvFileUnavailability };

export type EnvQueryFailureCode = "invalid_arguments" | "unknown_file_id" | "disabled";

export type EnvQueryFailure = { ok: false; code: EnvQueryFailureCode };

export interface EnvQueryServiceOptions {
  /** Allowlist from `settings.env_files`; frozen at setup. */
  envFiles: readonly string[];
  /** Workspace root; frozen (realpath'd) at setup. */
  workspaceRoot: string;
  /**
   * Resolves the guard configuration path used at setup; re-invoked per call
   * to detect authorization drift. Should share the loader's search logic.
   */
  resolveConfigPath: () => string | undefined;
  /**
   * sha256 fingerprint of the exact configuration bytes the allowlist was
   * parsed from (see `loadConfigWithFingerprint`). The allowlist and the
   * fingerprint are provably one read: an edit between reading the allowlist
   * and fingerprinting could otherwise authorize against content that never
   * existed at a single point in time.
   */
  configFingerprint: string;
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Unescape a double-quoted env value body. Single-pass scan: `\n` `\r` `\t`
 * `\"` `\\` map to their character; any other backslash sequence stays
 * literal. (Unlike the exact-value scanner's chained replaces, this cannot
 * mis-handle `\\n`; the two services are independent by design.)
 */
function unescapeDoubleQuoted(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char !== "\\") {
      out += char;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      default:
        out += next === undefined ? "\\" : "\\" + next;
        break;
    }
  }
  return out;
}

/**
 * Parse the value part of one assignment, reading continuation lines from
 * `lines` when a quoted value spans physical lines. Returns the parsed value
 * and the index of the first unconsumed line, or undefined when the file is
 * malformed (unterminated quote, invalid tail after a closing quote, or an
 * escape sequence that can never be part of a valid value).
 *
 * The quoted forms are scanned incrementally — one pass over each appended
 * line, never a rescan of the whole accumulated value — so pathological
 * multiline values stay linear in the file size.
 */
type QuotedValueParse = { value: string; nextIndex: number } | undefined;

/** Tail after a closing quote: blank, whitespace, or a comment — nothing else. */
function isValidQuotedTail(tail: string): boolean {
  return /^\s*(?:#.*)?$/.test(tail);
}

/**
 * Unquoted single-line value: an initial `#`, or the first `#` preceded by
 * whitespace, starts a trailing comment; the remainder is trimmed once. The
 * scan is monotonic — the search cursor only moves forward, so every
 * character is examined at most once and whitespace-dense values without a
 * `#` stay linear in the value size.
 */
function parseUnquotedValue(value: string): string {
  if (value.startsWith("#")) return "";
  let cut = value.length;
  let index = 0;
  while (index < value.length) {
    const hash = value.indexOf("#", index);
    if (hash === -1) break;
    if (hash > 0 && /\s/.test(value[hash - 1])) {
      cut = hash;
      break;
    }
    index = hash + 1;
  }
  return value.slice(0, cut).trim();
}

class QuotedValueScanner {
  readonly #quote: string;
  readonly #parts: string[] = [];
  #pendingEscape = false;

  constructor(quote: string) {
    this.#quote = quote;
  }

  /**
   * Consumes one chunk (the first line's remainder, then each continuation
   * line prefixed with its joining newline) in a single monotonic pass: the
   * cursor only moves forward and every character is examined at most once
   * (the double-quote form steps over each escape pair in place), so
   * escape-dense values — e.g. a near-1 MiB run of `\x` with the closing
   * quote far away or missing — stay linear in the file size. Body
   * fragments are collected per chunk and joined exactly once at the close.
   */
  append(chunk: string): { status: "open" } | { status: "closed"; value: string } | { status: "invalid" } {
    let position = 0;
    if (this.#pendingEscape) {
      // A backslash ending the previous chunk escapes the chunk separator
      // newline (or, for the first chunk, ends the line): `\<newline>` and
      // `\<CR>` can never be part of a valid double-quoted body.
      const escaped = chunk[0];
      if (escaped === undefined) return { status: "open" };
      if (this.#quote === '"' && (escaped === "\n" || escaped === "\r")) return { status: "invalid" };
      this.#parts.push("\\" + escaped);
      position = 1;
      this.#pendingEscape = false;
    }
    const quote = this.#quote;
    let start = position;
    let index = position;
    while (index < chunk.length) {
      const char = chunk[index];
      if (char === quote) {
        this.#parts.push(chunk.slice(start, index));
        if (!isValidQuotedTail(chunk.slice(index + 1))) return { status: "invalid" };
        const body = this.#parts.join("");
        return { status: "closed", value: quote === '"' ? unescapeDoubleQuoted(body) : body };
      }
      if (quote === '"' && char === "\\") {
        if (index + 1 >= chunk.length) {
          // Backslash at the very end: the escaped char is the first char of
          // the next chunk (the joining newline) — decide on the next append.
          this.#parts.push(chunk.slice(start, index));
          this.#pendingEscape = true;
          return { status: "open" };
        }
        // Unknown escapes are preserved verbatim in the body (they are
        // resolved by the final unescape); only `\<newline>` and `\<CR>` are
        // rejected outright because they can never be part of a valid value.
        const escaped = chunk[index + 1];
        if (escaped === "\n" || escaped === "\r") return { status: "invalid" };
        index += 2;
        continue;
      }
      index++;
    }
    this.#parts.push(chunk.slice(start));
    return { status: "open" };
  }
}

function parseEnvValueFromLines(lines: string[], startIndex: number, rawValue: string): QuotedValueParse {
  const value = rawValue.trimStart();
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : undefined;
  if (quote === undefined) {
    return { value: parseUnquotedValue(value), nextIndex: startIndex + 1 };
  }
  const scanner = new QuotedValueScanner(quote);
  let scan = scanner.append(value.slice(1));
  let index = startIndex;
  while (scan.status === "open") {
    index++;
    if (index >= lines.length) return undefined; // quote never closed: malformed
    scan = scanner.append("\n" + lines[index]);
  }
  if (scan.status === "invalid") return undefined;
  return { value: scan.value, nextIndex: index + 1 };
}

/**
 * Strict dotenv parser for the query service. Returns undefined when the file
 * is malformed — the entire file is rejected rather than returning partial,
 * non-authoritative results. Divergences from the exact-value scanner are
 * intentional: all value lengths (including <8) are preserved, and files with
 * stray non-assignment lines or unterminated quotes are rejected wholesale.
 */
export function parseEnvFileContent(content: string): Map<string, string> | undefined {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const lines = text.split(/\r?\n/);
  const values = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      index++;
      continue;
    }
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!assignment) return undefined;
    // Quoted values may span physical lines; quoted scanning consumes whole
    // lines at a time. EOF inside a quote means the whole file is malformed.
    const parsed = parseEnvValueFromLines(lines, index, assignment[2]);
    if (parsed === undefined) return undefined;
    values.set(assignment[1], parsed.value);
    index = parsed.nextIndex;
  }
  return values;
}

/** Coarse lexical shape of a nonempty value. A shape is a hint, never a claim that the value is a valid boolean or number. */
export function classifyEnvValueShape(value: string): EnvQueryShape {
  if (/[\n\r]/.test(value)) return "multiline_text";
  if (/^(true|false)$/i.test(value)) return "boolean_like";
  if (/^[+-]?(0x[0-9a-f]+|\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i.test(value)) return "number_like";
  return "text";
}

// ─── File access ────────────────────────────────────────────────────────────

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, filePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

type EnvFileRead = { ok: true; content: string } | { ok: false; reason: Exclude<EnvFileUnavailability, "malformed"> };

/** dev/ino identity of a directory, for the pinned-root and ancestor checks. */
type DirectoryIdentity = { dev: number; ino: number };

/**
 * lstat one path and require it to currently be a real directory (not a
 * symlink). Returns undefined when it is missing, a symlink, or any other
 * type; callers map that to a fixed sanitized reason code.
 */
function directoryIdentity(dirPath: string): DirectoryIdentity | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dirPath);
  } catch {
    return undefined;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
  return { dev: stat.dev, ino: stat.ino };
}

/**
 * Ancestor directories of a workspace-contained `filePath`, from the
 * workspace root (inclusive) down to the file's parent directory.
 */
function ancestorDirectories(filePath: string, workspaceRoot: string): string[] {
  const segments = path.relative(workspaceRoot, filePath).split(path.sep);
  segments.pop(); // drop the file name
  const directories = [workspaceRoot];
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

/**
 * Fresh, bounded read of one allowlisted env file. No result is cached.
 *
 * Best-effort pathname identity validation, in order:
 * 1. Lexical containment: the entry must resolve, relative to the frozen
 *    workspace root, to a path inside the workspace.
 * 2. The final component must lstat as a regular file (symlinks, FIFOs,
 *    and directories are rejected by reason code before anything opens).
 * 3. The canonical (realpath-resolved) path must be inside the workspace
 *    and must agree with the lexically validated path. Any difference means
 *    some component is or became a symlink — including an ancestor
 *    directory symlinked to another location inside the workspace, which
 *    containment alone would miss.
 * 4. Pre-open walk: the root and every ancestor directory must currently be
 *    real directories, the root must still be the device/inode pinned at
 *    setup, and every ancestor's identity is snapshotted for step 7.
 * 5. The canonical path is lstat'd again immediately before the open and is
 *    opened at that exact path with O_NOFOLLOW|O_NONBLOCK; the descriptor
 *    must be the same dev/ino as that lstat (and a regular file in bounds).
 * 6. Post-read metadata: size and mtime must be unchanged by the read.
 * 7. Post-read re-validation: ancestors are re-lstat'd against the pre-open
 *    snapshot, the canonical path is re-resolved, and a final lstat of the
 *    canonical path must still name the descriptor's inode.
 *
 * Honest limits (also stated in the README): steps 4–7 reject *observed*
 * changes, but a concurrent same-owner attacker who substitutes a component
 * (root, ancestor, or file) and restores it between two checks — an
 * unobserved ABA race — is not detectable by pathname checks alone;
 * hardlinks to files outside the workspace are not distinguished from the
 * original file; and an in-place rewrite preserving size and mtime is not
 * distinguishable. This validates pathname identity; it is not a sandbox
 * and not a trusted baseline.
 */
function readEnvFileSnapshot(
  envFile: string,
  realWorkspaceRoot: string,
  pinnedRoot: DirectoryIdentity,
): EnvFileRead {
  if (path.isAbsolute(envFile)) return { ok: false, reason: "outside_workspace" };
  const candidate = path.resolve(realWorkspaceRoot, envFile);
  if (!isWithinWorkspace(candidate, realWorkspaceRoot)) return { ok: false, reason: "outside_workspace" };

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };

  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  // Containment plus agreement with the lexically validated path: any
  // difference means a symlink on the path, wherever it resolves.
  if (!isWithinWorkspace(canonical, realWorkspaceRoot)) return { ok: false, reason: "outside_workspace" };
  if (canonical !== candidate) return { ok: false, reason: "symlink" };

  // Pre-open ancestor walk. The root must still be the directory whose
  // identity was pinned at setup; each ancestor is snapshotted so the
  // post-read re-validation below can detect observed substitution.
  const ancestors = ancestorDirectories(canonical, realWorkspaceRoot);
  const ancestorIdentities: DirectoryIdentity[] = [];
  for (let index = 0; index < ancestors.length; index++) {
    const identity = directoryIdentity(ancestors[index]);
    if (!identity) return { ok: false, reason: "unreadable" };
    if (index === 0 && (identity.dev !== pinnedRoot.dev || identity.ino !== pinnedRoot.ino)) {
      return { ok: false, reason: "unreadable" };
    }
    ancestorIdentities.push(identity);
  }

  // Re-lstat the canonical path immediately before the open; the descriptor
  // is bound to this stat's dev/ino below.
  try {
    stat = fs.lstatSync(canonical);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!stat.isFile()) return { ok: false, reason: "not_regular_file" };

  let fd: number | undefined;
  try {
    // O_NOFOLLOW: a final component swapped to a symlink after the lstat
    // above fails with ELOOP instead of being followed. O_NONBLOCK: a FIFO
    // swapped in cannot hang the event loop (the regular-file check below
    // rejects it). Platforms without the flags fall back to 0; the dev/ino
    // binding below still anchors the descriptor to the lstat'd inode.
    fd = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const fdStat = fs.fstatSync(fd);
    if (!fdStat.isFile()) return { ok: false, reason: "not_regular_file" };
    // Bind the descriptor to the inode the pre-open lstat authorized: any
    // pathname race (final component or ancestor directory swapped between
    // the lstat and the open) resolves to a different dev/ino and is rejected.
    if (fdStat.dev !== stat.dev || fdStat.ino !== stat.ino) return { ok: false, reason: "unreadable" };
    if (fdStat.size > MAX_ENV_QUERY_FILE_SIZE) return { ok: false, reason: "oversize" };
    const buffer = Buffer.alloc(fdStat.size);
    let read = 0;
    while (read < fdStat.size) {
      const bytes = fs.readSync(fd, buffer, read, fdStat.size - read, read);
      if (bytes === 0) return { ok: false, reason: "unreadable" }; // shrank mid-read: not authoritative
      read += bytes;
    }
    // The snapshot must describe the file it started from: growth or any
    // metadata change during the read voids it (an appended tail would
    // otherwise be silently read as a stale prefix).
    const postStat = fs.fstatSync(fd);
    if (postStat.size !== fdStat.size || postStat.mtimeMs !== fdStat.mtimeMs) {
      return { ok: false, reason: "unreadable" };
    }
    // Post-read re-validation of everything the authorization relied on:
    // the root and every ancestor must still be the same real directories,
    // and the canonical path must still resolve to itself and still name
    // the descriptor's inode. Observed changes void the snapshot; an
    // unobserved ABA substitution between checks is not detectable here.
    for (let index = 0; index < ancestors.length; index++) {
      const identity = directoryIdentity(ancestors[index]);
      if (
        !identity ||
        identity.dev !== ancestorIdentities[index].dev ||
        identity.ino !== ancestorIdentities[index].ino
      ) {
        return { ok: false, reason: "unreadable" };
      }
    }
    if (fs.realpathSync(canonical) !== canonical) return { ok: false, reason: "unreadable" };
    const finalStat = fs.lstatSync(canonical);
    if (!finalStat.isFile() || finalStat.dev !== fdStat.dev || finalStat.ino !== fdStat.ino) {
      return { ok: false, reason: "unreadable" };
    }
    return { ok: true, content: buffer.toString("utf8") };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

type EnvFileSnapshot = { values: Map<string, string> } | { unavailable: EnvFileUnavailability };

// ─── Service ─────────────────────────────────────────────────────────────────

function hashConfigFile(configPath: string | undefined): string {
  if (!configPath) return "absent";
  try {
    return createHash("sha256").update(fs.readFileSync(configPath, "utf8")).digest("hex");
  } catch {
    return "unreadable";
  }
}

export class EnvQueryService {
  readonly #envFiles: readonly string[];
  readonly #realWorkspaceRoot: string;
  /** dev/ino of the workspace root pinned at construction (with its realpath). */
  readonly #pinnedRoot: DirectoryIdentity;
  readonly #setupKey: Buffer;
  readonly #resolveConfigPath: () => string | undefined;
  readonly #configFingerprint: string;
  #revoked = false;

  constructor(options: EnvQueryServiceOptions) {
    if (options.envFiles.length > MAX_ENV_QUERY_FILES) {
      throw new Error(`env_files supports at most ${MAX_ENV_QUERY_FILES} files`);
    }
    this.#envFiles = [...options.envFiles];
    // Freezes the workspace at setup; throws (fail-closed setup) if unreadable.
    this.#realWorkspaceRoot = fs.realpathSync(options.workspaceRoot);
    // The root's device/inode identity is pinned alongside its path, so a
    // substituted root (same path, different directory) is rejected on every
    // later read even though the path still lexically matches.
    const rootStat = fs.lstatSync(this.#realWorkspaceRoot);
    if (!rootStat.isDirectory()) {
      throw new Error("workspace root is not a directory");
    }
    this.#pinnedRoot = { dev: rootStat.dev, ino: rootStat.ino };
    this.#setupKey = randomBytes(32);
    this.#resolveConfigPath = options.resolveConfigPath;
    this.#configFingerprint = options.configFingerprint;
  }

  listFiles(sessionID: string): { ok: true; files: EnvListEntry[] } | EnvQueryFailure {
    if (!this.#authorize()) return { ok: false, code: "disabled" };
    const files = this.#envFiles.map((_, index) => {
      const fileId = this.#fileIdFor(sessionID, index);
      const snapshot = this.#snapshot(index);
      return "unavailable" in snapshot
        ? { file_id: fileId, available: false, reason: snapshot.unavailable }
        : { file_id: fileId, available: true, keys: [...snapshot.values.keys()] };
    });
    return { ok: true, files };
  }

  inspectKey(sessionID: string, fileId: string, key: string): EnvInspectOutcome | EnvQueryFailure {
    if (typeof sessionID !== "string" || !isValidKeyName(key)) return { ok: false, code: "invalid_arguments" };
    if (!this.#authorize()) return { ok: false, code: "disabled" };
    const index = this.#indexOfFileId(sessionID, fileId);
    if (index === undefined) return { ok: false, code: "unknown_file_id" };
    const snapshot = this.#snapshot(index);
    if ("unavailable" in snapshot) return { ok: true, status: "unavailable", reason: snapshot.unavailable };
    const value = snapshot.values.get(key);
    if (value === undefined) return { ok: true, status: "missing" };
    if (value === "") return { ok: true, status: "empty" };
    return { ok: true, status: "nonempty", shape: classifyEnvValueShape(value) };
  }

  compareKeys(
    sessionID: string,
    left: { fileId: string; key: string },
    right: { fileId: string; key: string },
  ): EnvCompareOutcome | EnvQueryFailure {
    if (
      typeof sessionID !== "string" ||
      !isValidKeyName(left.key) ||
      !isValidKeyName(right.key)
    ) {
      return { ok: false, code: "invalid_arguments" };
    }
    if (!this.#authorize()) return { ok: false, code: "disabled" };
    const leftIndex = this.#indexOfFileId(sessionID, left.fileId);
    if (leftIndex === undefined) return { ok: false, code: "unknown_file_id" };
    const rightIndex = this.#indexOfFileId(sessionID, right.fileId);
    if (rightIndex === undefined) return { ok: false, code: "unknown_file_id" };

    // Both operands are read within this call (one shared per-call snapshot;
    // the same file is read at most once even when compared with itself).
    const snapshots = new Map<number, EnvFileSnapshot>();
    const snapshotFor = (index: number): EnvFileSnapshot => {
      const existing = snapshots.get(index);
      if (existing) return existing;
      const snapshot = this.#snapshot(index);
      snapshots.set(index, snapshot);
      return snapshot;
    };
    const leftSnapshot = snapshotFor(leftIndex);
    if ("unavailable" in leftSnapshot) {
      return { ok: true, result: "unavailable", reason: leftSnapshot.unavailable };
    }
    const rightSnapshot = snapshotFor(rightIndex);
    if ("unavailable" in rightSnapshot) {
      return { ok: true, result: "unavailable", reason: rightSnapshot.unavailable };
    }

    const leftValue = leftSnapshot.values.get(left.key);
    if (leftValue === undefined) return { ok: true, result: "unavailable" };
    const rightValue = rightSnapshot.values.get(right.key);
    if (rightValue === undefined) return { ok: true, result: "unavailable" };
    return { ok: true, result: leftValue === rightValue ? "equal" : "different" };
  }

  /**
   * True while the guard configuration still matches the setup fingerprint.
   * Revocation is sticky: once a mismatch is seen, queries stay disabled for
   * the rest of this process even if the file is reverted — an agent must not
   * be able to re-enable authorization by restoring old bytes.
   */
  #authorize(): boolean {
    if (this.#revoked) return false;
    if (hashConfigFile(this.#resolveConfigPath()) !== this.#configFingerprint) {
      this.#revoked = true;
      return false;
    }
    return true;
  }

  #snapshot(index: number): EnvFileSnapshot {
    const read = readEnvFileSnapshot(this.#envFiles[index], this.#realWorkspaceRoot, this.#pinnedRoot);
    if (!read.ok) return { unavailable: read.reason };
    const values = parseEnvFileContent(read.content);
    return values ? { values } : { unavailable: "malformed" };
  }

  #fileIdFor(sessionID: string, index: number): string {
    return createHmac("sha256", this.#setupKey)
      .update(`session:${sessionID}\0env-file:${index}`)
      .digest("hex")
      .slice(0, 16);
  }

  #indexOfFileId(sessionID: string, fileId: string): number | undefined {
    if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > MAX_FILE_ID_LENGTH) {
      return undefined;
    }
    for (let index = 0; index < this.#envFiles.length; index++) {
      if (this.#fileIdFor(sessionID, index) === fileId) return index;
    }
    return undefined;
  }
}

function isValidKeyName(key: string): boolean {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_NAME_LENGTH;
}

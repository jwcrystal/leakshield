/**
 * W2 (B2) mapping-key providers — key custody for the encrypted mapping
 * store (decision `docs/plans/2026-10-07-persistence-decision-db-over-t2.md`
 * §10: keychain is the local-first equivalent of mainstream key custody;
 * none of the four reference integrations ship one).
 *
 * Resolution ladder (decision §4.6/§8 — degrade, never fail-closed):
 *   1. OS keychain — macOS Keychain (`security`), Linux libsecret
 *      (`secret-tool`), Windows DPAPI (ProtectedData, CurrentUser scope).
 *   2. 0600 keyfile — ONLY when explicitly opted in; documented weaker
 *      (a stolen directory/backup carries both secrets).
 *   3. null — the caller degrades that process to memory-only operation;
 *      conversations are never blocked.
 *
 * Threat-model boundary (documented in the decision and README): the
 * keychain defends OFFLINE file theft (disk, backups, a stolen SGP.db); it
 * does not defend malware already running inside the user's login session
 * (macOS authorization prompts can be social-engineered; DPAPI/libsecret
 * decrypt for the same user). This is the common OS-protection boundary,
 * not unique to this design.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { MappingKey, MappingKeyProvider } from "./mapping-store.js";

/** Platform keychain access. `read` returns null when the item is absent;
 * any other failure throws (= keychain unavailable, ladder steps down). */
export interface KeyStoreProbe {
  read(): string | null;
  write(hexKey: string): void;
}

const SERVICE = "sensitive-guard";
const ACCOUNT = "sgp-mapping-key";
const HEX_KEY = /^[0-9a-f]{64}$/;

function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
}

/** macOS Keychain generic-password probe. Exit 44 = item not found (null). */
export function createMacKeychainProbe(): KeyStoreProbe | null {
  if (process.platform !== "darwin") return null;
  return {
    read(): string | null {
      const result = run("security", [
        "find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w",
      ]);
      if (result.status === 44) return null;
      if (result.status !== 0 || typeof result.stdout !== "string") {
        throw new Error("macOS keychain read failed");
      }
      // R3-F5: rc=0 with EMPTY output means the item EXISTS but is empty —
      // surface that as "" (the resolver refuses malformed/empty values);
      // returning null here would make `add -U` overwrite a corrupt item.
      return result.stdout.trim();
    },
    write(hexKey: string): void {
      const result = run("security", [
        "add-generic-password", "-U", "-a", ACCOUNT, "-s", SERVICE, "-w", hexKey,
      ]);
      if (result.status !== 0) throw new Error("macOS keychain write failed");
    },
  };
}

/**
 * Linux libsecret probe via secret-tool.
 *
 * Exit-code semantics (R2-4): `secret-tool lookup` exits 1 BOTH when no item
 * matches (silent, empty stdout AND stderr) and on real errors (message on
 * stderr). Only the silent variant is "absent"; a read failure must never be
 * mistaken for absence, or the ladder would create/overwrite a key over an
 * unreadable keychain. ENOENT means secret-tool is not installed.
 */
export function interpretSecretToolLookup(result: {
  status: number | null;
  stdout: string;
  stderr?: string;
  error?: { code?: string };
}): string | null {
  if (result.error !== undefined && result.error.code === "ENOENT") {
    throw new Error("secret-tool not installed");
  }
  if (result.status === 0) {
    // R3-F5: rc=0 with empty output is a present-but-empty item, not absence.
    if (result.stdout.length === 0) throw new Error("keychain item present but empty");
    return result.stdout;
  }
  if (result.status === 1 && result.stdout.length === 0 && (result.stderr ?? "").length === 0) {
    return null; // absent — the only silent-nonzero case
  }
  throw new Error("libsecret lookup failed");
}

export function createLinuxSecretProbe(): KeyStoreProbe | null {
  if (process.platform !== "linux") return null;
  const attrs = ["attribute", "service", SERVICE, "attribute", "account", ACCOUNT];
  return {
    read(): string | null {
      const result = run("secret-tool", ["lookup", ...attrs]);
      return interpretSecretToolLookup({
        status: result.status,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: typeof result.stderr === "string" ? result.stderr : "",
        error: result.error as { code?: string } | undefined,
      });
    },
    write(hexKey: string): void {
      const result = run("secret-tool", ["store", "--label=sensitive-guard mappings", ...attrs], hexKey ?? "");
      if (result.status !== 0) throw new Error("libsecret store failed");
    },
  };
}

/**
 * Windows DPAPI probe. DPAPI protects data, not storage, so the encrypted
 * key blob lives in a 0600 file under the user's profile; it is decryptable
 * only by the same user on the same machine (offline theft fails).
 */
export function createWindowsDpapiProbe(): KeyStoreProbe | null {
  if (process.platform !== "win32") return null;
  const blobPath = join(homedir(), "AppData", "Local", "sensitive-guard", "sgp.key.dpapi");
  const ps = (script: string) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  return {
    read(): string | null {
      if (!existsSync(blobPath)) return null;
      const base64 = readFileSync(blobPath, "utf8").trim();
      // R3-F5: an existing-but-empty blob is corruption, not absence.
      if (base64.length === 0) throw new Error("DPAPI key blob present but empty");
      const result = ps(
        `[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${base64}'),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))`,
      );
      if (result.status !== 0) throw new Error("DPAPI unprotect failed");
      return result.stdout.trim();
    },
    write(hexKey: string): void {
      // R-round: Set-Content does not create parent directories.
      mkdirSync(dirname(blobPath), { recursive: true, mode: 0o700 });
      const result = ps(
        `[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([System.Text.Encoding]::UTF8.GetBytes('${hexKey}'),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)) | Set-Content -NoNewline -Path '${blobPath}'`,
      );
      if (result.status !== 0) throw new Error("DPAPI protect failed");
    },
  };
}

/** The platform's keychain probe, or null when unsupported. */
export function createPlatformKeychainProbe(): KeyStoreProbe | null {
  return createMacKeychainProbe() ?? createLinuxSecretProbe() ?? createWindowsDpapiProbe();
}

/**
 * 0600 keyfile provider — the documented-weaker ladder step. The key sits
 * next to the data's directory tree, so directory/backup theft carries both
 * secrets; it still enforces the two-file bar and never prompts.
 *
 * R-round guarantees:
 * - Creation uses exclusive (`wx`) semantics: two processes racing the first
 *   create converge on ONE key (the loser adopts the winner's file) instead
 *   of silently forking keys.
 * - An existing file with group/other permission bits is tightened to 0600;
 *   if tightening fails the provider refuses (ladder degrades, memory-only)
 *   rather than silently accepting a world-readable key.
 */
export class KeyfileMappingKeyProvider implements MappingKeyProvider {
  readonly source = "keyfile" as const;
  private key: MappingKey;
  constructor(private readonly path: string) {
    const existing = readKeyfile(this.path);
    if (existing !== null) {
      assertKeyfilePrivate(this.path);
      this.key = Buffer.from(existing, "hex");
      return;
    }
    const fresh = randomBytes(32);
    try {
      // Exclusive create: EEXIST means a concurrent creator won the race.
      const fd = openSync(this.path, "wx", 0o600);
      try {
        writeFileSync(fd, fresh.toString("hex"));
      } finally {
        // R2-6: writeFileSync(fd, …) does NOT close the descriptor.
        closeSync(fd);
      }
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Best effort on exotic filesystems; creation mode already applied.
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Lost the race: adopt the winner's key. The winner may still be
      // mid-write — retry briefly until the file holds a complete key.
      const winner = waitForKeyfile(this.path);
      if (winner === null) {
        throw new Error(`keyfile race at ${this.path}: concurrent creator did not finish`);
      }
      assertKeyfilePrivate(this.path);
      this.key = Buffer.from(winner, "hex");
      return;
    }
    this.key = fresh;
  }
  getOrCreateKey(): MappingKey {
    return this.key;
  }
}

/** Existing keyfile with loose permissions must tighten or refuse. */
function assertKeyfilePrivate(path: string): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    throw new Error(`keyfile disappeared: ${path}`);
  }
  if ((mode & 0o077) === 0) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    throw new Error(`keyfile ${path} is group/other readable and could not be tightened to 0600`);
  }
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`keyfile ${path} remains group/other readable after chmod 0600`);
  }
}

/** Retry-loop for a concurrent creator's partial write (~100ms budget). */
function waitForKeyfile(path: string): string | null {
  for (let attempt = 0; attempt < 10; attempt++) {
    const content = readKeyfile(path);
    if (content !== null) return content;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return null;
}

function readKeyfile(path: string): string | null {
  try {
    const content = readFileSync(path, "utf8").trim();
    return HEX_KEY.test(content) ? content : null;
  } catch {
    return null;
  }
}

export interface ResolveMappingKeyOptions {
  /** Explicit opt-in for the weaker keyfile ladder step. */
  keyFile: boolean;
  /** Overrides the default keyfile location. */
  keyfilePath?: string;
  /** Content-free degradation notice (the guard's WARN line). */
  warn: (message: string) => void;
}

/** Overridable for tests. */
export function resolveMappingKeyWithProbe(
  probe: KeyStoreProbe | null,
  options: ResolveMappingKeyOptions,
): MappingKeyProvider | null {
  if (probe !== null) {
    try {
      const existing = probe.read();
      if (existing !== null && !HEX_KEY.test(existing)) {
        // R2-5: a PRESENT but malformed item is corruption, not absence —
        // overwriting it would silently re-key (and orphan every persisted
        // mapping behind a keyId mismatch). Refuse; the ladder steps down.
        throw new Error("keychain item present but malformed or empty (not 64-hex)");
      }
      if (existing !== null) {
        const key = Buffer.from(existing, "hex");
        return { source: "os-keychain", getOrCreateKey: () => key };
      }
      // First creation. Keychains have no atomic create-if-absent across
      // processes, so: write, then ALWAYS read back and adopt what the
      // keychain actually holds. A concurrent creator that wrote after us
      // wins the store; both processes converge on the same key instead of
      // forking. (A write-vs-read window remains — documented residual,
      // narrowed from "always fork" to "last write wins + read-back".)
      const fresh = randomBytes(32).toString("hex");
      try {
        probe.write(fresh);
      } catch {
        // We may have lost the race or the write failed; the read-back below
        // is the arbiter — no key there means the ladder steps down.
      }
      const confirmed = probe.read();
      const confirmedHex = confirmed !== null && HEX_KEY.test(confirmed)
        ? confirmed
        : null;
      if (confirmedHex === null) throw new Error("keychain create failed");
      const key = Buffer.from(confirmedHex, "hex");
      return { source: "os-keychain", getOrCreateKey: () => key };
    } catch {
      options.warn("persistence: keychain unavailable, stepping down the key ladder");
    }
  }
  if (options.keyFile) {
    const path = options.keyfilePath ?? defaultKeyfilePath();
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return new KeyfileMappingKeyProvider(path);
    } catch {
      options.warn("persistence: keyfile unreadable or unwritable, degrading to memory-only");
      return null;
    }
  }
  options.warn("persistence: no key provider available, degrading to memory-only");
  return null;
}

/** Ladder entry point for production callers. */
export function resolveMappingKey(options: ResolveMappingKeyOptions): MappingKeyProvider | null {
  return resolveMappingKeyWithProbe(createPlatformKeychainProbe(), options);
}

export function defaultKeyfilePath(): string {
  return join(defaultDataDir(), "sgp.key");
}

/** Decision §8: global store location, owner-specified file name. */
export function defaultStorePath(): string {
  return join(defaultDataDir(), "SGP.db");
}

function defaultDataDir(): string {
  return join(homedir(), ".local", "share", "sensitive-guard");
}

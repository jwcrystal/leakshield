/**
 * OpenCode v2 transparent pseudonymization session guard (issue #22).
 *
 * One guard owns exactly ONE pseudonymizer service (bounded per setup, no
 * session fallback, no TTL, no eviction) and its own hook registrations and
 * disposal. Protection model:
 *
 * - The four model-request kinds (`context`, `compaction`, `generate`,
 *   `title`) protect an atomic snapshot (system, messages, options, tools
 *   schema) with `protectJson` and publish it back only after the whole
 *   transaction succeeds — never piecewise in place, never partial.
 * - Wire protection registers outbound HTTP/WS and SDK admission hooks.
 *   Explicit false is hook-only: none of those outbound hooks is registered.
 *   Inbound HTTP/WS restoration is best-effort in both modes; hook-only uses
 *   the host's session/kind/model and successful content preparation, not an
 *   outgoing transport registration, to select the local mapping.
 * - Native Responses-family WebSocket routes restore display frames; the same
 *   wireProtection switch controls outbound admission and masking. Unknown
 *   inbound protocols stay literal. SDKs honoring injected HTTP fetch reuse
 *   the wire-protected HTTP hooks; hook-only makes no transport guarantee.
 * - `tool:execute.before` restores registered tokens in tool arguments so local
 *   tools run with the real values (the model never sees them). Restoration is
 *   deep over the argument tree and keeps keys/types. Shell-like tools accept
 *   complete literal argument words in a single simple command; POSIX quoting
 *   and one static trailing output redirect are supported. Expansion, control
 *   syntax, unsafe quote-breaking originals and tokenized redirect targets
 *   refuse the affected call. Token-free calls pass through unchanged.
 *
 * Deliberately NOT registered in transparent mode: `session:prompt` (prompt
 * admission and local persistence keep originals by design — protection is at
 * the model boundary), `session:model.request` (routing/headers only; no
 * content is exposed there to scan), `tool:execute.after` (local tool results
 * stay original; their outbound replay is protected by the request kinds).
 *
 * The public V2 `session.deleted` event releases that session's memory and
 * response attribution. Idle/completed sessions retain mappings for resume;
 * there is no TTL or LRU eviction of live mappings. Disposal clears all RAM.
 */

import { types } from "node:util";
import type { Plugin as PluginNamespace } from "@opencode/plugin";
import {
  containsTokenPrefix,
  createPseudonymizer,
  type PseudonymFailureReason,
  type PseudonymizerService,
} from "./decision/pseudonymization.js";
import {
  MappingForgottenError,
  MappingKeyMismatchError,
  MappingSnapshotTooLargeError,
  MappingStoreConflictError,
  openMappingStore,
  type LoadedSession,
  type MappingKeyProvider,
  type MappingStore,
} from "./decision/mapping-store.js";
import { resolveMappingKey } from "./decision/mapping-key.js";
import { walkSchemaStrings } from "./decision/schema-strings.js";
import {
  classifyModelRoute,
  remaskModelRequest,
  restoreModelResponse,
  withOpaqueAttachments,
  type TransportMaskingService,
} from "./opencode-transparent-http.js";
import type { GuardConfig } from "./types.js";
import { createResponsesWebSocketAdapter } from "./opencode-transparent-ws.js";
import { createAISDKTransportAdmission } from "./opencode-transparent-aisdk.js";
import { BUILTIN_RULES } from "./rules/builtin.js";

type V2Plugin = PluginNamespace.Plugin;
type PluginContext = PluginNamespace.Context;

type RecordLike = { [key: string]: unknown };

// ─── Static failure messages (no content ever included) ─────────────────────

const INITIALIZATION_ERROR =
  "LeakShield initialization failed, so the request was blocked before anything was sent.";
const PROTECT_FAILED_ERROR =
  "LeakShield blocked a model request because it could not be masked safely.";
const ATTRIBUTION_ERROR =
  "LeakShield blocked a response because it could not be matched to a request.";
const UNSUPPORTED_ROUTE_ERROR =
  "LeakShield blocked a request on an unsupported route.";
const TOOL_REFUSAL_ERROR =
  "LeakShield blocked this tool call because its arguments could not be restored safely. Re-read the file and try again.";
const TOOL_UNKNOWN_MAPPING_ERROR =
  "LeakShield blocked this tool call before execution: a placeholder has no mapping in this session. The tool did not run. Reread the source and rebuild the affected arguments from current references; rereading does not make an old placeholder valid. If it is refused again, stop retrying and ask the user.";
const TOOL_RESTORE_LIMIT_ERROR =
  "LeakShield blocked this tool call because its arguments are too large to restore safely. Use smaller arguments and try again.";
const TOOL_SHELL_CONTEXT_ERROR =
  "LeakShield blocked this tool call because the shell command's quoting is not supported. Use a simple command with plain arguments, or a different tool.";
const TOOL_CODE_CONTEXT_ERROR =
  "LeakShield blocked this tool call because a protected value cannot be safely inserted into code. Pass the value through a plain argument or a file instead, or ask the user.";
const TOOL_CODE_POSITION_ERROR =
  "LeakShield blocked this tool call; the tool did not run.\n- Allowed: a placeholder in a plain single-line quoted string with no interpolation, outside any multi-line string or line continuation.\n- Fix: copy the placeholder exactly as it appears in this conversation, including its brackets, into such a string, assign that to a variable, and reference the variable.\n- Do not replace the placeholder with other text, and do not ask for or write the real value. If refused again, stop and ask the user.";
/**
 * OpenCode's built-in Code Mode tool (v2.2.5): custom tools are reachable only
 * through it, with input `{code: string}`.
 */
const CODE_MODE_TOOL = "execute";
/**
 * Refusal for `fetch` inside Code Mode source that holds a protected value.
 * This only avoids a misleading result: the inner fetch would send the
 * placeholder, the remote would answer with an error, and the model would read
 * that as a verdict on the real value. It is NOT a security boundary: it is a
 * text match on the source, not a network control, so other spellings are not
 * caught (and then send only the placeholder).
 */
const TOOL_CODE_FETCH_ERROR =
  "LeakShield blocked this tool call; the tool did not run.\n- Reason: fetch inside execute cannot use protected values, because it would send the placeholder rather than the real value, so a failed response says nothing about the value.\n- Fix: use a tool call instead, or tell the user this cannot be done here.\n- Do not report the value as invalid, and do not ask for or write the real value.";
/** Refusal for a value recognisably derived from this session's placeholder whose format was changed. */
const TOOL_PLACEHOLDER_NEAR_MISS_ERROR =
  "LeakShield blocked this tool call; the tool did not run.\n- A value looks like a placeholder from this conversation, but its format was changed.\n- Fix: copy it exactly as it appears, including its brackets; do not replace it with other text.\n- Do not ask for or write the real value. If refused again, stop and ask the user.";
const TOOL_INPUT_SHAPE_ERROR =
  "LeakShield blocked this tool call because its argument structure cannot be safely restored. Use plain JSON values and try again.";
const STRUCTURAL_SENSITIVE_ERROR =
  "LeakShield blocked this request because a structural identifier (message or tool id, name, role, or part type) scans as sensitive and cannot be masked. Change it or adjust the matching rule, then try again.";

function toolRestoreError(reason: PseudonymFailureReason): string {
  if (reason === "unknown_token" || reason === "malformed_token") return TOOL_UNKNOWN_MAPPING_ERROR;
  if (reason === "operation_limit") return TOOL_RESTORE_LIMIT_ERROR;
  return TOOL_REFUSAL_ERROR;
}

/**
 * Refusal text for a failed masking preparation. The marker stays static —
 * stage plus reason code, never content — because the refused value may be
 * exactly what must not be echoed. `truncated_content` additionally names the
 * scanner bound and the two ways out, so the bound is visible instead of a
 * dead end (issue #47). Masked text is rescanned and tokens can be longer than
 * what they replace, so a string under the bound can still exceed it.
 */
function prepareMaskError(reason: PseudonymFailureReason, config: GuardConfig): string {
  const marker = `${PROTECT_FAILED_ERROR} [stage=prepare.mask reason=${reason}]`;
  if (reason !== "truncated_content") return marker;
  const maxChars = config.settings.max_chars;
  return `${marker} A string, before or after masking, exceeded settings.max_chars (${maxChars}). Raise settings.max_chars or split the content.`;
}

/** Shell syntax excluded from unquoted literal words. Known tokens are
 * removed before this check; a token-shaped prefix alone grants no exemption. */
const UNSUPPORTED_SHELL_SYNTAX = /[\x00-\x1f\x7f'"`\\$;|&<>(){}*?\[\]!~#]/;

type ShellQuote = "none" | "single" | "double";
interface LiteralShellWord {
  start: number;
  end: number;
  value: string;
  quote: ShellQuote;
  redirect: boolean;
}

/** A deliberately small literal-word lexer, not a general shell parser.
 * Quotes must enclose the entire word. No escape decoding, expansions, quote
 * concatenation or control characters are accepted. Decode command/flag
 * quotes too, so `'sh' '-c' TOKEN` cannot bypass the interpreter gate. */
function parseLiteralShellWords(text: string): LiteralShellWord[] | null {
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  // The new quote/redirection subset is POSIX-specific. Keep the previous
  // conservative behavior on Windows, where the host may launch cmd.exe.
  if (process.platform === "win32" && /['">]/.test(text)) return null;
  const words: LiteralShellWord[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === " ") {
      at += 1;
      continue;
    }
    const start = at;
    if (text[at] === ">") {
      at += text[at + 1] === ">" ? 2 : 1;
      words.push({ start, end: at, value: text.slice(start, at), quote: "none", redirect: true });
    } else if (text[at] === "'" || text[at] === '"') {
      const delimiter = text[at++];
      const valueStart = at;
      while (at < text.length && text[at] !== delimiter) at += 1;
      if (at === text.length) return null;
      const value = text.slice(valueStart, at++);
      const quote = delimiter === "'" ? "single" : "double";
      if (quote === "double" && /[`\\$!]/.test(value)) return null;
      words.push({ start, end: at, value, quote, redirect: false });
    } else {
      while (at < text.length && text[at] !== " ") at += 1;
      const value = text.slice(start, at);
      if (UNSUPPORTED_SHELL_SYNTAX.test(value.replace(TOKEN_SCAN, "TOKEN")) || value.includes(">")) return null;
      words.push({ start, end: at, value, quote: "none", redirect: false });
    }
    if (at < text.length && text[at] !== " ") return null;
  }
  return words;
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_COMMAND_WRAPPERS = new Set([
  "builtin",
  "command",
  "doas",
  "env",
  "eval",
  "exec",
  "nice",
  "nohup",
  "pkexec",
  "runuser",
  "setsid",
  "source",
  "sudo",
  "su",
  "time",
  "timeout",
  "xargs",
]);

const INLINE_SCRIPT_FLAGS = new Map<string, Set<string>>([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
  ["ruby", new Set(["-e", "-pe", "-ne"])],
  ["perl", new Set(["-e", "-pe", "-ne", "-E"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
  ["powershell", new Set(["-c", "-command", "-encodedcommand", "-e"])],
  ["pwsh", new Set(["-c", "-command", "-encodedcommand", "-e"])],
  ["cmd", new Set(["/c", "/k"])],
]);
const SCRIPT_ARGUMENT_INTERPRETERS = new Set(["awk", "sed", "jq"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "csh", "tcsh", "fish"]);

/** Returns only ordinary arguments, never command/assignment/redirect words. */
function parseSupportedShellArguments(text: string): LiteralShellWord[] | null {
  const parsed = parseLiteralShellWords(text);
  if (parsed === null) return null;
  const redirectIndex = parsed.findIndex((word) => word.redirect);
  if (redirectIndex !== -1) {
    const target = parsed[redirectIndex + 1];
    if (
      redirectIndex === 0 || redirectIndex !== parsed.length - 2 ||
      target.redirect || target.value.length === 0 || containsTokenPrefix(target.value)
    ) return null;
  }
  const words = redirectIndex === -1 ? parsed : parsed.slice(0, redirectIndex);
  const commandIndex = words.findIndex((word) => word.quote !== "none" || !ASSIGNMENT_WORD.test(word.value));
  if (commandIndex === -1) return null;
  const commandName = words[commandIndex].value.split("/").at(-1)?.toLowerCase() ?? "";
  if (SHELL_COMMAND_WRAPPERS.has(commandName) || SCRIPT_ARGUMENT_INTERPRETERS.has(commandName)) return null;
  const argumentsOnly = words.slice(commandIndex + 1);
  if (SHELL_INTERPRETERS.has(commandName)) {
    if (argumentsOnly.some((argument) => /^-[A-Za-z]*c[A-Za-z]*$/.test(argument.value))) return null;
  }
  const inlineFlags =
    INLINE_SCRIPT_FLAGS.get(commandName) ??
    (/^python(?:\d+(?:\.\d+)*)?$/.test(commandName) ? INLINE_SCRIPT_FLAGS.get("python") : undefined);
  if (inlineFlags && argumentsOnly.some((argument) => inlineFlags.has(argument.value.toLowerCase()))) return null;
  if (commandName === "deno" && argumentsOnly.some((argument) => argument.value === "eval")) return null;
  return argumentsOnly;
}

/** Characters forbidden inside restored shell argument words. */
const SHELL_UNSAFE = /[\s'"`\\$;|&<>(){}*?\[\]!~#\x00-\x1F\x7F]/;
/**
 * Restore policy is decided per field, not per tool. A tool name that is in
 * SHELL_TOOLS or has a shell-interpreter segment (bash, shell, sh, zsh, pwsh,
 * powershell) makes every field "shell". Otherwise a field named like a
 * command (command, cmd, commands, argv, ...) is "shell", a field named like
 * code (code, script, ...) is "inert" (no parsing; originals with
 * shell-unsafe characters are refused), and any other field restores
 * verbatim. The list is built into the source, not configurable; an executing
 * tool using other field names is not detected.
 */
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "exec",
  "command",
  "run",
  "pwsh",
  "powershell",
]);
type ToolLeafPolicy = "verbatim" | "shell" | "inert";

/** Splits on non-alphanumerics and camelCase boundaries; lowercase segments. */
const nameSegments = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

const SHELL_TOOL_SEGMENTS = new Set(["bash", "shell", "sh", "zsh", "pwsh", "powershell"]);
const METADATA_KEYS = new Set(["description", "title", "label"]);
const SHELL_KEY_LAST_SEGMENTS = new Set(["command", "commands", "cmd", "cmds"]);
const SHELL_KEYS_JOINED = new Set(["shell", "commandline", "cmdline", "argv"]);
const CODE_KEYS_JOINED = new Set(["code", "script", "scripts", "sourcecode", "codesnippet", "inlinescript"]);

const isShellTool = (rawTool: string): boolean =>
  SHELL_TOOLS.has(rawTool.toLowerCase()) || nameSegments(rawTool).some((segment) => SHELL_TOOL_SEGMENTS.has(segment));

const isShellKey = (key: string): boolean => {
  const segments = nameSegments(key);
  return (
    (segments.length > 0 && SHELL_KEY_LAST_SEGMENTS.has(segments[segments.length - 1] as string)) ||
    SHELL_KEYS_JOINED.has(segments.join(""))
  );
};
const isCodeKey = (key: string): boolean => CODE_KEYS_JOINED.has(nameSegments(key).join(""));

const keyPolicy = (key: string, inherited: ToolLeafPolicy): ToolLeafPolicy => {
  const segments = nameSegments(key);
  if (segments.length === 1 && METADATA_KEYS.has(segments[0] as string)) return "verbatim";
  if (isShellKey(key)) return "shell";
  if (isCodeKey(key)) return inherited === "shell" ? "shell" : "inert";
  return inherited;
};

/**
 * Tools whose calls are observably read-only: an unresolved placeholder in
 * their arguments reads/greps/lists against a literal string and matches
 * nothing — no state change, no outbound transmission. Only these qualify
 * for P1 (2026-10-06b) best-effort literal passthrough when restoration is
 * incomplete. Everything else — writes, deletes, edits, network calls,
 * shell, unknown tools — refuses the affected invocation.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "view",
  "grep",
  "glob",
  "list",
  "ls",
  "find",
  "todoread",
]);
/**
 * Content-free degradation notice for the host log: one WARN line, a fixed
 * context word plus a count, never request content. No side files, no
 * provider-body notices (P1, 2026-10-06b).
 */
const warnDegradation = (context: string): void => {
  console.warn(`[leakshield] degraded: ${context}`);
};
/** Preserve the existing quote context; never add quoting or reinterpret the
 * original as code. Leading '-' stays forbidden even when quoted (options are
 * interpreted after quote removal). Controls are forbidden in every context. */
function isShellSafeOriginal(text: string, quote: ShellQuote): boolean {
  if (text.length === 0 || text.startsWith("-") || /[\x00-\x1f\x7f]/.test(text)) return false;
  if (quote === "single") return !text.includes("'");
  if (quote === "double") return !/["`\\$!]/.test(text);
  return !SHELL_UNSAFE.test(text);
}
/** Matches a fully formed reserved token (either version), for per-token shell safety checks. */
const TOKEN_SCAN =
  /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;

/**
 * Relaxed (brackets optional, separators up to 4 non-alphanumerics, any case)
 * forms of the two placeholder versions, used only to spot a placeholder the
 * model reformatted. Every quantifier is bounded and there is no nested
 * unbounded group. A candidate counts only if its canonical form restores in
 * the session, so no token enumeration is needed.
 *
 * SGP2 reads the words after the prefix and tries each category length. One
 * regex can't do this: the text after a stripped token is often more short
 * words, and a greedy category absorbs them and yields a wrong candidate.
 */
const NEAR_SEP = "[^A-Za-z0-9]{1,4}";
const NEAR_MISS_V2_HEAD = /(?<![A-Za-z0-9])SGP2(?=[^A-Za-z0-9])/gi;
const NEAR_MISS_V2_WORD = new RegExp(`${NEAR_SEP}([A-Za-z]{1,32})(?![A-Za-z0-9])`, "y");
const NEAR_MISS_V2_MAX_CATEGORY_WORDS = 6;
const NEAR_MISS_V1 = new RegExp(
  `(?<![A-Za-z0-9])SGP1${NEAR_SEP}([0-9a-f]{32})${NEAR_SEP}(\\d{8,12})(?!\\d)`,
  "gi",
);

/**
 * Builds the position check for the placeholders of one code/script field.
 * Call the result with each token's [start, end) in increasing order; it keeps
 * its state between calls, so the whole field costs one forward pass however
 * many tokens it holds, and a false result ends the field's check. A token's
 * position passes unless `crossesLineBoundary` or `isInPlainStringLiteral`
 * rejects it.
 *
 * Conservative, language-agnostic, line-based heuristic; it is not a parser
 * and does not confirm the match is in a string. It can both over-refuse and
 * miss. It guards the restoration context only and is not egress protection:
 * code can still print, send or re-interpret the restored value.
 */
function createInertPositionCheck(text: string): (start: number, end: number) => boolean {
  const lineBreak = /[\n\r\u2028\u2029]/g;
  // Current line is [lineStart, lineEnd); lineEnd sits on its separator.
  let lineStart = 0;
  let lineEnd = -1;
  // Triple quotes in text[0, countedTo). A separator ends any run of quotes, so
  // per-line counts add up to the non-overlapping count over the whole prefix.
  let countedTo = 0;
  let doubleTriples = 0;
  let singleTriples = 0;
  let crossesLineBoundary = false;
  // Quote scan of the current line, resumed from `cursor` for each token.
  let cursor = 0;
  let quote: string | null = null;
  let introducerInString = false;
  let closingQuote = -1;

  const enterLineOf = (index: number): void => {
    while (lineEnd < index) {
      lineStart = lineEnd + 1;
      lineBreak.lastIndex = lineStart;
      lineEnd = lineBreak.exec(text)?.index ?? text.length;
    }
    const uncounted = text.slice(countedTo, lineStart);
    doubleTriples += uncounted.match(/"""/g)?.length ?? 0;
    singleTriples += uncounted.match(/'''/g)?.length ?? 0;
    countedTo = lineStart;
    const line = text.slice(lineStart, lineEnd);
    // True when the line may belong to a multi-line construct, so the
    // line-based string check cannot be trusted: the line holds a triple quote,
    // an odd number of non-overlapping triple quotes precedes the line (inside
    // an open multi-line string), or the previous line ends in a backslash
    // (continuation; doubled backslashes are not distinguished, so refuse).
    // Deliberately not a whole-field ban, so a script with a balanced docstring
    // above the assignment still works.
    crossesLineBoundary =
      line.includes('"""') ||
      line.includes("'''") ||
      doubleTriples % 2 === 1 ||
      singleTriples % 2 === 1 ||
      /\\(?:\r\n|[\n\r\u2028\u2029])$/.test(text.slice(Math.max(0, lineStart - 3), lineStart));
    cursor = lineStart;
    quote = null;
    introducerInString = false;
  };

  /**
   * True when [start, end) looks like it sits inside an ordinary quoted string
   * that opens and closes on the current line, with no interpolation or escape
   * introducer between the opening quote and the token.
   */
  const isInPlainStringLiteral = (start: number, end: number): boolean => {
    while (cursor < start) {
      const c = text[cursor];
      if (quote === null) {
        if (c === "'" || c === '"') {
          quote = c;
          introducerInString = false;
        } else if (
          c === "`" || c === "#" || text.startsWith("//", cursor) || text.startsWith("/*", cursor) || text.startsWith("--", cursor)
        ) {
          return false;
        }
      } else if (c === "\\") {
        introducerInString = true;
        cursor++;
      } else if (c === quote) {
        quote = null;
      } else if (c === "{" || c === "$" || c === "`") {
        introducerInString = true;
      }
      cursor++;
    }
    if (quote === null || introducerInString) return false;
    // A token holds no quote or backslash, so a search from an earlier token
    // in this string walked through this one: its answer still holds, and each
    // string on the line is searched once.
    if (closingQuote >= end) return true;
    for (let i = end; i < lineEnd; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === quote) {
        closingQuote = i;
        return true;
      }
    }
    return false;
  };

  return (start, end) => {
    if (start > lineEnd) enterLineOf(start);
    return !crossesLineBoundary && isInPlainStringLiteral(start, end);
  };
}

/**
 * Bound on distinct session identities retained for disposal. The core already
 * caps committed sessions; this bounds identities seen with safe-only content
 * so a stream of fresh session ids cannot grow the set without limit. Beyond
 * it, a new session fails closed.
 */
const MAX_TRACKED_SESSIONS = 4096;
/**
 * The core's small standalone defaults are not a whole model-history budget.
 * Match its mapping-session ceiling to the guard's existing bookkeeping cap.
 * HTTP bodies and WS frames are already capped at 4 MiB; allow 8 Mi UTF-16
 * units of combined input/output work for assembled requests. The node cap
 * bounds schema-heavy histories independently. Per-string scanner bounds,
 * depth and aggregate mapping-byte/entry caps remain unchanged.
 */
const TRANSPARENT_LIMITS = {
  maxSessions: MAX_TRACKED_SESSIONS,
  maxNodes: 100000,
  maxUnitsPerOperation: 8 * 1024 * 1024,
};

// ─── Structural validation ───────────────────────────────────────────────────

function isRecordLike(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireSessionID(event: RecordLike): string {
  if (typeof event.sessionID !== "string" || event.sessionID.length === 0) {
    throw new Error(PROTECT_FAILED_ERROR);
  }
  return event.sessionID;
}

/**
 * Protocol/structural identifiers of a request snapshot: message ids and
 * roles, part types, tool-call ids/names, tool names and the whole tool input
 * schema. These must survive protection verbatim; the masker never renames
 * them, and the guard refuses rather than silently renaming when one itself
 * carries sensitive content (see assertStructuralSafe). Returned in a stable
 * walk order so the pre- and post-protection collections can be compared.
 */
function collectStructuralStrings(event: RecordLike): string[] {
  const out: string[] = [];
  const pushString = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
  };
  if (Array.isArray(event.system)) {
    for (const part of event.system) {
      if (isRecordLike(part)) pushString(part.type);
    }
  }
  if (Array.isArray(event.messages)) {
    for (const message of event.messages) {
      if (!isRecordLike(message)) continue;
      pushString(message.id);
      pushString(message.role);
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!isRecordLike(part)) continue;
          pushString(part.type);
          if (part.type === "tool-call") {
            pushString(part.id);
            pushString(part.name);
            pushString(part.toolName);
          }
        }
      }
    }
  }
  if (isRecordLike(event.tools)) {
    for (const name of Object.keys(event.tools)) {
      out.push(name);
      const tool = (event.tools as RecordLike)[name];
      // Schema annotation prose (description/title values) is content, not
      // structural: it masks to a token instead of refusing the request.
      if (isRecordLike(tool) && tool.input !== undefined) walkSchemaStrings(out, tool.input);
    }
  }
  return out;
}

// ─── Provider-opaque state ───────────────────────────────────────────────────

/**
 * Provider state the host replays verbatim (OpenAI encrypted reasoning and
 * compaction checkpoints, Anthropic/Bedrock signatures and redacted thinking,
 * Gemini thought signatures). It is ciphertext or a MAC over prior output: a
 * detector false positive inside it (an `AIza` run in base64, say) rewrites
 * bytes the provider authenticates and the request fails with
 * `invalid_encrypted_content`. Masking it protects nothing — the plaintext it
 * stands for is not in it — so it crosses the boundary unscanned, but only
 * when position AND shape both say it is provider state:
 *   - position: an assistant message's reasoning/compaction `encrypted`, or a
 *     known key under any assistant part's `providerMetadata.<provider>`;
 *   - shape: a single base64/base64url run whose decoded bytes are mostly
 *     non-printable (ciphertext), so readable text — raw or merely
 *     base64-encoded — keeps being scanned like any other leaf.
 * Everything else in those parts (reasoning text, other metadata) is masked
 * as usual.
 */
const OPAQUE_STATE_SENTINEL = "__sg_opaque_state";
const OPAQUE_STATE_PART_TYPES = new Set(["reasoning", "compaction"]);
const OPAQUE_STATE_METADATA_KEYS = ["reasoningEncryptedContent", "encryptedContent", "signature", "redactedData", "thoughtSignature"];
const OPAQUE_STATE_SHAPE = /^[A-Za-z0-9+/_-]+={0,2}$/;
const OPAQUE_STATE_MIN_LENGTH = 16;
/** Uniform random bytes are ~37% printable; encoded text is ~100%. */
const OPAQUE_STATE_MAX_PRINTABLE_RATIO = 0.75;

function isOpaqueStateShaped(value: string): boolean {
  if (value.length < OPAQUE_STATE_MIN_LENGTH || !OPAQUE_STATE_SHAPE.test(value)) return false;
  // Node's base64 decoder accepts both the standard and url-safe alphabets.
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) return false;
  let printable = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d) printable++;
  }
  return printable / bytes.length <= OPAQUE_STATE_MAX_PRINTABLE_RATIO;
}

type OpaqueStatePath = readonly (string | number)[];

/**
 * Substitutes trusted opaque state with sentinels around the masking
 * transaction, then writes each original back at its exact path in the
 * protected projection. Any path that no longer holds its sentinel fails the
 * whole request closed: nothing is restored into a moved or rewritten slot.
 */
function withOpaqueProviderState(plain: RecordLike, fn: (input: RecordLike) => RecordLike): RecordLike {
  const slots: Array<{ path: OpaqueStatePath; value: string }> = [];
  const stash = (container: RecordLike, key: string, path: OpaqueStatePath): void => {
    const value = container[key];
    if (typeof value !== "string" || !isOpaqueStateShaped(value)) return;
    container[key] = `${OPAQUE_STATE_SENTINEL}_${slots.length}`;
    slots.push({ path, value });
  };
  if (Array.isArray(plain.messages)) {
    plain.messages.forEach((message, messageIndex) => {
      if (!isRecordLike(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;
      message.content.forEach((part, partIndex) => {
        if (!isRecordLike(part)) return;
        const base = ["messages", messageIndex, "content", partIndex];
        if (typeof part.type === "string" && OPAQUE_STATE_PART_TYPES.has(part.type)) {
          stash(part, "encrypted", [...base, "encrypted"]);
        }
        if (!isRecordLike(part.providerMetadata)) return;
        for (const [provider, metadata] of Object.entries(part.providerMetadata)) {
          if (!isRecordLike(metadata)) continue;
          for (const key of OPAQUE_STATE_METADATA_KEYS) {
            stash(metadata, key, [...base, "providerMetadata", provider, key]);
          }
        }
      });
    });
  }
  if (slots.length === 0) return fn(plain);
  const result = fn(plain);
  slots.forEach(({ path, value }, index) => {
    let container: unknown = result;
    for (const segment of path.slice(0, -1)) {
      container = container !== null && typeof container === "object" ? (container as RecordLike)[segment] : undefined;
    }
    const key = path[path.length - 1];
    if (container === null || typeof container !== "object" || (container as RecordLike)[key] !== `${OPAQUE_STATE_SENTINEL}_${index}`) {
      throw new Error(PROTECT_FAILED_ERROR);
    }
    (container as RecordLike)[key] = value;
  });
  return result;
}

/**
 * Replaces media/file attachment PARTS (array slots) with an explanatory text
 * part: binary or base64 content cannot be scanned, so it never crosses the
 * boundary — the conversation continues with a notice instead of the whole
 * session failing. (2026-10-05 product decision, owner-approved; spec
 * revised.) A media/file record found in a NON-part slot (a bare object
 * value) is an unexpected shape and still fails closed.
 */
const ATTACHMENT_PLACEHOLDER_TEXT =
  "[leakshield: attachment omitted — binary content is never sent to the model]";

const ATTACHMENT_ALLOW_NOTICE_TEXT =
  "[leakshield: attachment(s) allowed through unscanned per configuration — the user vouches for their content]";

/**
 * Applies the attachment policy to a live event field.
 * "block": media/file parts in part arrays become omission-notice text parts
 * (the attachment is not sent; the conversation continues).
 * "allow": parts are left intact and ONE notice text part is appended to the
 * field so the choice stays visible to the user and the model.
 * A media/file record in a non-part slot (a bare object value) is an
 * unexpected shape and fails closed in BOTH policies.
 */
function applyAttachmentPolicy(
  value: unknown,
  seen: WeakSet<object>,
  policy: "block" | "allow",
): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const isAttachment = (item: unknown): boolean =>
    isRecordLike(item) && (item.type === "media" || item.type === "file");
  let changed = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item = value[index];
      if (isAttachment(item)) {
        if (policy === "block") {
          value[index] = { type: "text", text: ATTACHMENT_PLACEHOLDER_TEXT };
          changed = true;
        }
        // allow mode: leave the attachment intact; the caller appends the notice.
      } else if (applyAttachmentPolicy(item, seen, policy)) {
        changed = true;
      }
    }
    return changed;
  }
  const record = value as RecordLike;
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (isAttachment(item)) {
      // Not a parts-array slot: unexpected shape, fail closed.
      throw new Error(PROTECT_FAILED_ERROR);
    }
    if (applyAttachmentPolicy(item, seen, policy)) changed = true;
  }
  return changed;
}

/**
 * Appends ONE visible notice when allow-mode attachments are present.
 * Only a user-role message is an eligible slot: a bare text part inside an
 * assistant/tool message breaks the host's provider serialization ("OpenAI
 * Chat tool messages only support tool-result content for now"). When no
 * user message with a content array exists, the notice is skipped — the
 * request shape is never corrupted to deliver it.
 */
function appendAllowNotice(event: RecordLike, found: boolean): void {
  if (!found) return;
  const messages = event.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecordLike(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
    message.content.push({ type: "text", text: ATTACHMENT_ALLOW_NOTICE_TEXT });
    return;
  }
}

function hasAttachmentPart(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some(
      (item) =>
        (isRecordLike(item) && (item.type === "media" || item.type === "file")) ||
        hasAttachmentPart(item, seen),
    );
  }
  const record = value as RecordLike;
  return Object.values(record).some(
    (item) =>
      (isRecordLike(item) && (item.type === "media" || item.type === "file")) ||
      hasAttachmentPart(item, seen),
  );
}

/**
 * True when any string reachable from the tool input — as a value OR as an
 * object key — carries the reserved token prefix (owned or foreign). Such
 * inputs are refused before execution: with no pinned adapter there is no
 * schema-validated, non-shell tool whose arguments may be restored. Keys are
 * inspected too, because a token-keyed argument would otherwise escape the
 * refusal gate.
 */
function inputCarriesToken(value: unknown, seen: WeakSet<object>): boolean {
  if (typeof value === "string") return containsTokenPrefix(value);
  if (value === null || typeof value !== "object") return false;
  if (types.isProxy(value)) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return true;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (containsTokenPrefix(key)) return true;
    const descriptor = descriptors[key];
    if (!("value" in descriptor)) return true;
    if (inputCarriesToken(descriptor.value, seen)) return true;
  }
  return false;
}

// ─── Guard ───────────────────────────────────────────────────────────────────

export interface TransparentSessionGuard {
  /** OpenCode v2 `setup(ctx)` implementation. */
  readonly setup: V2Plugin["setup"];
  /**
   * Disposes every registration this setup made (reverse order) and clears
   * every session mapping the guard issued. Idempotent.
   */
  readonly dispose: () => Promise<void>;
}

/** Runs pending disposals (best effort, reverse order) without throwing. */
async function runDisposals(disposals: Array<() => Promise<void>>): Promise<void> {
  for (let i = disposals.length - 1; i >= 0; i--) {
    try {
      await disposals[i]();
    } catch {
      // Continue clearing remaining registrations.
    }
  }
  disposals.length = 0;
}

/**
 * Creates a fail-closed guard whose every hook refuses all operations. Exported
 * so the plugin entry can arm it for transparent mode when setup fails before
 * (or during) guard construction: a transparent fallback must cover the
 * transport routes (http/ws/aisdk) in wire mode. Hook-only failures refuse
 * content/tool dispatch without introducing new transport registrations.
 */
export function createFailClosedTransparentGuard(wireProtection = true): TransparentSessionGuard {
  const disposals: Array<() => Promise<void>> = [];
  const refuse = (): never => {
    throw new Error(INITIALIZATION_ERROR);
  };
  return {
    setup: async (ctx: PluginContext) => {
      try {
        const contentHooks = ["context", "compaction", "generate", "title"] as const;
        const wireHooks = [
          "http.request",
          "http.response",
          "experimental.ws.handshake",
          "experimental.ws.send",
          "experimental.ws.receive",
        ] as const;
        for (const name of [...contentHooks, ...(wireProtection ? wireHooks : [])]) {
          disposals.push((await ctx.session.hook(name, refuse)).dispose);
        }
        if (wireProtection) {
          disposals.push((await ctx.aisdk.hook("sdk", refuse)).dispose);
          disposals.push((await ctx.aisdk.hook("language", refuse)).dispose);
        }
        disposals.push((await ctx.tool.hook("execute.before", refuse)).dispose);
      } catch (error) {
        await runDisposals(disposals);
        throw error;
      }
    },
    dispose: () => runDisposals(disposals),
  };
}

/** Persistence wiring options (W2/B4 + R-round), mapped from
 * PluginOptions.persistence. `keyProvider` is a test/CI injection seam —
 * production callers leave it unset and the OS keychain ladder resolves;
 * an explicit null forces the ladder-bottom memory-only path deterministically. */
export interface GuardPersistenceOptions {
  ttlDays: number;
  path: string;
  keyFile: boolean;
  keyfilePath?: string;
  keyProvider?: MappingKeyProvider | null;
}

/**
 * Creates the transparent session guard for one plugin setup (= one OpenCode
 * process): a single bounded pseudonymizer, exact-session mapping, private
 * request attribution, and its own registrations. With persistence options
 * the guard additionally hydrates sessions from the encrypted store on
 * first touch and writes committed mappings back (decision §4: dispose
 * unloads hooks but never deletes persisted mappings — forget is the only
 * erasure path).
 */
export function createTransparentSessionGuard(
  config: GuardConfig,
  attachmentsPolicy: "block" | "allow" = "block",
  wireProtection = true,
  persistence?: GuardPersistenceOptions,
): TransparentSessionGuard {
  const created = createPseudonymizer(config, TRANSPARENT_LIMITS);
  if (!created.ok) return createFailClosedTransparentGuard(wireProtection);
  const pseudonymizer: PseudonymizerService = created;

  const disposals: Array<() => Promise<void>> = [];
  const sessions = new Set<string>();
  /** Fails closed on a new session once the tracked-session budget is full. */
  const assertTrackable = (sessionID: string): void => {
    if (!sessions.has(sessionID) && sessions.size >= MAX_TRACKED_SESSIONS) {
      throw new Error(`${PROTECT_FAILED_ERROR} [stage=session.track reason=session_limit]`);
    }
  };
  /**
   * Retains a session for disposal. Called only AFTER an operation succeeds, so
   * failed requests cannot grow the set ("failed-session IDs unbounded").
   */
  const track = (sessionID: string): void => {
    sessions.add(sessionID);
  };
  /** Private correlation of a dispatched request to its session/kind/model. */
  const attributions = new WeakMap<Request, { sessionID: string; kind: string; model?: string }>();
  // Latest successful host preparation, scoped to session/kind/model. This
  // proves hook coverage, NOT that an opaque final body has been inspected.
  const protectedContexts = new Map<string, string>();
  const notices = new Set<string>();
  const noticeOnce = (message: string): void => {
    if (notices.has(message)) return;
    notices.add(message);
    warnDegradation(message);
  };
  const contextScope = (event: RecordLike, kind = event.kind): string => JSON.stringify([event.sessionID, kind]);
  const contextModel = (event: RecordLike): string | undefined => {
    if (!isRecordLike(event.model) || typeof event.model.providerID !== "string" || !event.model.providerID || typeof event.model.id !== "string" || !event.model.id) return undefined;
    const key = JSON.stringify([event.model.providerID, event.model.id]);
    return Buffer.byteLength(key, "utf8") <= 4096 ? key : undefined;
  };
  const hasProtectedContext = (event: RecordLike): boolean => {
    const model = contextModel(event);
    return model !== undefined && protectedContexts.get(contextScope(event)) === model;
  };

// ─── W2/B4 + R-round persistence wiring (all no-ops when store is null) ───
  let store: MappingStore | null = null;
  /** Bounded (F4.4): insertion-ordered attempt log, evicting the oldest. */
  const seedAttempts = new Map<string, true>();
  const MAX_SEED_ATTEMPTS = 1024;
  const persistedEntries = new Map<string, number>();
  /** R-round F3.2: the row version observed at seed/write time (CAS token).
   * Absent looks encode -(generation+1); row looks carry the version. */
  const persistVersions = new Map<string, number>();
  /** F4.2: sessions whose seed was rejected must never overwrite their
   * previously persisted (good) snapshot with a partial re-protect. */
  const noPersist = new Set<string>();
  /** R3-F7: bounded per-session bookkeeping. Live sessions (bounded by
   * MAX_TRACKED_SESSIONS) always keep their state; only departed ids go. */
  const MAX_BOOKKEEPING = 1024;
  const evictStaleBookkeeping = <V>(map: Map<string, V> | Set<string>): void => {
    if (map.size <= MAX_BOOKKEEPING) return;
    for (const key of map.keys()) {
      if (map.size <= MAX_BOOKKEEPING) break;
      if (!sessions.has(key)) map.delete(key);
    }
  };

  if (persistence !== undefined) {
    // Test/CI seam: an injected provider skips the OS keychain ladder so
    // integration tests never touch the developer's real keychain (F6.1);
    // explicit null forces the memory-only bottom of the ladder.
    const keyProvider =
      persistence.keyProvider !== undefined
        ? persistence.keyProvider
        : resolveMappingKey({
            keyFile: persistence.keyFile,
            keyfilePath: persistence.keyfilePath,
            warn: warnDegradation,
          });
    if (keyProvider !== null) {
      try {
        store = openMappingStore({
          path: persistence.path,
          keyProvider,
          ttlDays: persistence.ttlDays,
        });
        console.info(`[leakshield] persistence: active; key=${keyProvider.source ?? "injected"}; ttl=${persistence.ttlDays}d; cleanup=on-store-open`);
      } catch (error) {
        store = null;
        warnDegradation(
          error instanceof MappingKeyMismatchError
            ? "persistence: resolved key does not match this store's pinned key identity; operating memory-only (forget --all resets)"
            : "persistence: mapping store unavailable, operating memory-only",
        );
      }
    } else {
      warnDegradation("persistence: no key provider, operating memory-only");
    }
  }

  /** R2-8: degradation must close the handle before dropping the reference. */
  const disableStore = (message: string): void => {
    if (store !== null) {
      try {
        store.close();
      } catch {
        // Already-broken handle: nothing further to release.
      }
    }
    store = null;
    warnDegradation(message);
  };

  /**
   * Lazy hydration on a session's first touch: seed the core from the store
   * before any protect/restore so replayed history and tool calls resolve.
   * A rejected seed (static reason only) degrades to memory-only for that
   * session — never blocks the conversation. A store that THROWS mid-flight
   * (F4.1) disables persistence for this process; the conversation continues
   * memory-only.
   */
  const ensureSeeded = (sessionID: string): void => {
    // R2-9: a session already LIVE in this process's registry needs no seed —
    // and re-seeding would fail invalid_session and mis-fire noPersist. This
    // also makes FIFO eviction of an active session's attempt harmless: its
    // CAS state (persistVersions) is retained either way.
    if (store === null || seedAttempts.has(sessionID) || pseudonymizer.hasSession(sessionID)) return;
    if (seedAttempts.size >= MAX_SEED_ATTEMPTS) {
      const oldest = seedAttempts.keys().next().value;
      if (oldest !== undefined) seedAttempts.delete(oldest);
    }
    seedAttempts.set(sessionID, true);
    let seed: LoadedSession | null;
    try {
      seed = store.loadSession(sessionID);
    } catch (error) {
      disableStore("persistence: store read failed; disabled for this process, memory-only");
      return;
    }
    if (seed === null) {
      // R3-F2: the absent look carries the session's tombstone generation —
      // a delete that happens since (create→forget, sweep, eviction) must
      // make this handle's insert a conflict, never a resurrection.
      try {
        persistVersions.set(sessionID, -(store.absentGeneration(sessionID) + 1));
      } catch {
        // Same contract as loadSession above: a store that fails mid-flight
        // disables persistence for the process, never the conversation.
        disableStore("persistence: store read failed; disabled for this process, memory-only");
      }
      return;
    }
    if (seed.entries.length === 0) {
      // Row exists (possibly with undecryptable entries): remember ITS
      // version so write-behind CASes against the real lineage.
      persistVersions.set(sessionID, seed.version);
      return;
    }
    const result = pseudonymizer.seedSession(sessionID, {
      epoch: seed.epoch,
      entries: seed.entries,
    });
    if (!result.ok) {
      noPersist.add(sessionID);
      evictStaleBookkeeping(noPersist);
      warnDegradation(`persistence: session seed rejected (${result.reason}); memory-only for this session`);
      return;
    }
    // F4.3: a session hydrated only via tool:execute.before also holds core
    // state — retain it for disposal like any tracked session.
    sessions.add(sessionID);
    persistedEntries.set(sessionID, seed.entries.length);
    persistVersions.set(sessionID, seed.version);
  };

  /** Write-behind after successful protects; skips no-op writes. */
  const persistIfChanged = (sessionID: string): void => {
    if (store === null || noPersist.has(sessionID)) return;
    const snapshot = pseudonymizer.exportSession(sessionID);
    if (snapshot === null) return;
    if (persistedEntries.get(sessionID) === snapshot.entries.length) return;
    try {
      const storedVersion = store.putSession(
        {
          sessionId: sessionID,
          epoch: snapshot.epoch,
          entries: snapshot.entries.map((entry) => ({ ...entry })),
        },
        persistVersions.get(sessionID) ?? 0,
      );
      persistedEntries.set(sessionID, snapshot.entries.length);
      persistVersions.set(sessionID, storedVersion);
      evictStaleBookkeeping(persistedEntries);
      evictStaleBookkeeping(persistVersions);
      evictStaleBookkeeping(noPersist);
    } catch (error) {
      if (error instanceof MappingStoreConflictError) {
        // Another process holds a newer snapshot for this session; ours is
        // stale. Never overwrite — keep serving in-memory mappings and stop
        // write-behind for the session (the next process seeds the newer set).
        noPersist.add(sessionID);
        warnDegradation("persistence: concurrent writer holds a newer snapshot for this session; write-behind stopped");
        return;
      }
      if (error instanceof MappingForgottenError) {
        // Explicit erasure raced this handle: persisting now would resurrect
        // forgotten data. Close and disable the store for this process (the
        // in-memory copy remains until this process exits — documented RAM
        // residue).
        disableStore("persistence: mappings were forgotten while this process was running; persistence disabled (in-memory copy remains until restart)");
        return;
      }
      if (error instanceof MappingSnapshotTooLargeError) {
        // R2-10: this single session exceeds the store-wide cap; evicting
        // others can never fix it. Stop trying — memory-only persistence.
        noPersist.add(sessionID);
        warnDegradation(`persistence: ${error.message}`);
        return;
      }
      warnDegradation("persistence: write-behind failed; in-session mappings remain valid");
    }
  };

  const kindOf = (event: RecordLike): string =>
    typeof event.kind === "string" ? event.kind : "";

  /**
   * Structural identifiers are preserved verbatim, so they are judged, not
   * masked. P1 (2026-10-06b): marker-shaped content is never refused per se —
   * registered-marker interiors are exempt from scanning, unregistered
   * payloads scan as ordinary text. Clean → preserved literal with a
   * content-free WARN. Any finding → refusal: the position cannot be masked
   * or renamed without breaking the protocol (genuine leak-risk refusal).
   */
  const detectSensitive = (text: string): boolean => !pseudonymizer.isTextSafe(text);
  const assertStructuralSafe = (text: string, sessionID: string): void => {
    if (containsTokenPrefix(text)) {
      if (!pseudonymizer.isStructuralIdentifierSafe(sessionID, text)) {
        throw new Error(STRUCTURAL_SENSITIVE_ERROR);
      }
      warnDegradation("structural identifier preserved with a literal placeholder");
      return;
    }
    if (detectSensitive(text)) throw new Error(STRUCTURAL_SENSITIVE_ERROR);
  };
  /** Rejects a snapshot whose numeric values scan as sensitive (never masked). */
  const assertNumbersSafe = (value: unknown): void => {
    if (typeof value === "number") {
      if (detectSensitive(String(value))) throw new Error(PROTECT_FAILED_ERROR);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) assertNumbersSafe(item);
      return;
    }
    for (const item of Object.values(value as RecordLike)) assertNumbersSafe(item);
  };

  /**
   * Field-aware transport exemption for the opt-in URL rule. Transport
   * positions (request URL, query values, header values) are infrastructure:
   * masking or refusing an endpoint URL would break every request once the
   * URL rule is enabled. Neutralizing URL matches BEFORE the strict checks
   * removes both the direct findings and the percent-decoding hazard windows
   * that would otherwise re-surface the URL text — while non-URL secrets
   * (e.g. an API key encoded in a query value outside a URL match) still
   * refuse. Only active when the URL rule itself is enabled; body-content
   * URLs are unaffected (they are masked like any other finding).
   */
  const urlRule = BUILTIN_RULES.find((rule) => rule.id === "url");
  const urlRuleId = urlRule?.id;
  const urlRuleOptIn = urlRule?.optIn === true;
  const urlRuleActive =
    urlRuleId !== undefined &&
    (urlRuleId in (config.settings.rule_overrides ?? {})
      ? config.settings.rule_overrides?.[urlRuleId] === true
      : !urlRuleOptIn);
  const neutralizeTransportUrls = (text: string): string => {
    if (!urlRuleActive || urlRule === undefined) return text;
    // Fresh RegExp per call: the shared rule pattern is stateful (/g).
    return text.replace(new RegExp(urlRule.pattern.source, urlRule.pattern.flags), "url");
  };

  const transportService: TransportMaskingService = {
    protectJsonForModel: (sid, value) => pseudonymizer.protectJsonForModel(sid, value),
    restoreText: (sid, text) => pseudonymizer.restoreText(sid, text),
    restoreTextForDisplay: (sid, text) => pseudonymizer.restoreTextForDisplay(sid, text),
    detectSensitive,
    isStructuralIdentifierSafe: (sid, text) => pseudonymizer.isStructuralIdentifierSafe(sid, text),
    transportDetectSensitive: (text) => detectSensitive(neutralizeTransportUrls(text)),
    isTransportIdentifierSafe: (sid, text) =>
      pseudonymizer.isStructuralIdentifierSafe(sid, neutralizeTransportUrls(text)),
    attachmentsPolicy,
  };
  const webSocket = createResponsesWebSocketAdapter(transportService, wireProtection, hasProtectedContext);
  /** Release only an explicitly deleted session; persisted rows keep their TTL. */
  const releaseSession = (sessionID: string): void => {
    if (!sessions.delete(sessionID)) return;
    pseudonymizer.clearSession(sessionID);
    webSocket.clearSession(sessionID);
    for (const kind of ["primary", "compaction", "generate", "title"]) {
      protectedContexts.delete(JSON.stringify([sessionID, kind]));
    }
    seedAttempts.delete(sessionID);
    persistedEntries.delete(sessionID);
    persistVersions.delete(sessionID);
    noPersist.delete(sessionID);
  };
  const aiSDK = createAISDKTransportAdmission(wireProtection);

  /**
   * Publishes protected string leaves back into the live event in place. The
   * host keeps its own (possibly class-instance) option/message objects, so we
   * must mutate them rather than replace them with plain projections.
   */
  const publishInPlace = (original: unknown, protectedValue: unknown): void => {
    if (original === null || typeof original !== "object") return;
    if (Array.isArray(original)) {
      if (!Array.isArray(protectedValue)) return;
      for (let index = 0; index < original.length; index++) {
        const current = original[index];
        const next = protectedValue[index];
        if (typeof current === "string") {
          if (typeof next === "string" && next !== current) original[index] = next;
        } else {
          publishInPlace(current, next);
        }
      }
      return;
    }
    if (protectedValue === null || typeof protectedValue !== "object") return;
    const record = original as RecordLike;
    const protectedRecord = protectedValue as RecordLike;
    for (const key of Object.keys(protectedRecord)) {
      if (!(key in record)) continue;
      const current = record[key];
      const next = protectedRecord[key];
      if (typeof current === "string") {
        if (typeof next === "string" && next !== current) record[key] = next;
      } else {
        publishInPlace(current, next);
      }
    }
  };

  /** True when two JSON values have identical key/array structure. */
  const sameStructure = (a: unknown, b: unknown): boolean => {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      return a.every((item, index) => sameStructure(item, b[index]));
    }
    const aObject = a !== null && typeof a === "object";
    const bObject = b !== null && typeof b === "object";
    if (aObject !== bObject) return false;
    if (!aObject) return true;
    const aRecord = a as RecordLike;
    const bRecord = b as RecordLike;
    const aKeys = Object.keys(aRecord);
    if (aKeys.length !== Object.keys(bRecord).length) return false;
    for (const key of aKeys) {
      if (!(key in bRecord) || !sameStructure(aRecord[key], bRecord[key])) return false;
    }
    return true;
  };

  const assertWritableDataProperty = (record: object, key: string | number): void => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
      throw new Error(PROTECT_FAILED_ERROR);
    }
  };

  const assertPublishable = (value: unknown, seen: WeakSet<object>): void => {
    if (value === null || typeof value !== "object") return;
    if (types.isProxy(value)) throw new Error(PROTECT_FAILED_ERROR);
    if (seen.has(value)) return;
    seen.add(value);
    if (Object.isFrozen(value)) throw new Error(PROTECT_FAILED_ERROR);
    for (let prototype: object | null = value; prototype !== null && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
      if (Object.getOwnPropertyDescriptor(prototype, "toJSON") !== undefined) {
        throw new Error(PROTECT_FAILED_ERROR);
      }
    }
    if (Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new Error(PROTECT_FAILED_ERROR);
        const item = descriptor.value;
        if (typeof item === "string" && descriptor.writable !== true) {
          throw new Error(PROTECT_FAILED_ERROR);
        }
        assertPublishable(item, seen);
      }
      return;
    }
    const record = value as RecordLike;
    for (const key of Object.keys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error(PROTECT_FAILED_ERROR);
      const item = descriptor.value;
      if (typeof item === "string" && descriptor.writable !== true) {
        throw new Error(PROTECT_FAILED_ERROR);
      }
      assertPublishable(item, seen);
    }
  };

  const protectRequestKind = (event: RecordLike, kind: "primary" | "title" | "compaction" | "generate"): void => {
    const sessionID = requireSessionID(event);
    // Host preparation events omit kind; the registered hook is the authority.
    // Do not mutate the event or infer a primary scope from a title/generate.
    protectedContexts.delete(contextScope(event, kind));
    if (!wireProtection && contextModel(event) !== undefined) {
      webSocket.resetRequest({ sessionID, kind, model: event.model });
    }
    assertTrackable(sessionID);
    ensureSeeded(sessionID);
    if (types.isProxy(event)) throw new Error(PROTECT_FAILED_ERROR);
    for (const field of ["system", "messages", "options", "tools"] as const) {
      if (field in event) {
        assertWritableDataProperty(event, field);
        assertPublishable(event[field], new WeakSet());
      }
    }
    const allowFound =
      attachmentsPolicy === "allow" &&
      ["system", "messages", "options", "tools"].some((field) => hasAttachmentPart(event[field], new WeakSet()));
    applyAttachmentPolicy(event.system, new WeakSet(), attachmentsPolicy);
    applyAttachmentPolicy(event.messages, new WeakSet(), attachmentsPolicy);
    applyAttachmentPolicy(event.options, new WeakSet(), attachmentsPolicy);
    applyAttachmentPolicy(event.tools, new WeakSet(), attachmentsPolicy);
    if (attachmentsPolicy === "allow") appendAllowNotice(event, allowFound);
    const snapshot: Record<string, unknown> = {
      system: event.system,
      messages: event.messages,
      options: event.options,
    };
    if (event.tools !== undefined) snapshot.tools = event.tools;
    // Project to the exact plain JSON the host will serialize (real v2 events
    // are class instances that strict-JSON protection refuses), then protect in
    // one atomic transaction and publish masked leaves back in place.
    let plain: unknown;
    try {
      plain = JSON.parse(JSON.stringify(snapshot));
    } catch {
      throw new Error(PROTECT_FAILED_ERROR);
    }
    if (!isRecordLike(plain)) throw new Error(PROTECT_FAILED_ERROR);
    // Structural identifiers must be preserved verbatim. Verify them BEFORE
    // masking: a sensitive one (sensitive-looking id/name) refuses the whole
    // request rather than being silently renamed, while a placeholder-shaped
    // one is judged session-aware — clean markers are preserved literal with
    // a WARN (P1, 2026-10-06b). Numeric values are never transformed by
    // masking, so a sensitive one refuses.
    const structuralBefore = collectStructuralStrings(plain);
    for (const identifier of structuralBefore) assertStructuralSafe(identifier, sessionID);
    assertNumbersSafe(plain);
    // "allow" means unscanned: attachment payloads are substituted with opaque
    // sentinels around the masking transaction (the same mechanism the wire
    // remaskers use) and restored afterwards, so a real image's base64 is
    // never token-mangled into an unparseable payload and never trips
    // encoded-content detection.
    const protectTree = (input: RecordLike): RecordLike => {
      const masked = pseudonymizer.protectJsonForModel(sessionID, input);
      if (!masked.ok) throw new Error(prepareMaskError(masked.reason, config));
      if (!isRecordLike(masked.value)) throw new Error(PROTECT_FAILED_ERROR);
      return masked.value as RecordLike;
    };
    // Provider-authenticated reasoning/compaction state is substituted the
    // same way, so a detector false positive cannot corrupt its bytes.
    const value = withOpaqueProviderState(plain, (input) => withOpaqueAttachments(attachmentsPolicy, input, protectTree));
    // Defense in depth: no structural identifier may have changed.
    const structuralAfter = collectStructuralStrings(value);
    if (
      structuralAfter.length !== structuralBefore.length ||
      structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
    ) {
      throw new Error(PROTECT_FAILED_ERROR);
    }
    // Publish only after the whole transaction succeeded. When masking renamed
    // an object key the live container cannot be mutated in place, so that
    // field is replaced with the protected projection; otherwise the live
    // (possibly class-instance) container is mutated leaf-by-leaf.
    try {
      for (const field of ["system", "messages", "options", "tools"] as const) {
        if (!(field in snapshot)) continue;
        const before = plain[field];
        const after = value[field];
        if (sameStructure(before, after)) publishInPlace(event[field], after);
        else event[field] = after;
      }
    } catch {
      throw new Error(PROTECT_FAILED_ERROR);
    }
    track(sessionID);
    persistIfChanged(sessionID);
    const model = contextModel(event);
    if (model !== undefined) {
      protectedContexts.set(contextScope(event, kind), model);
    }
  };

  const onHttpRequest = async (event: RecordLike): Promise<void> => {
    const sessionID = requireSessionID(event);
    assertTrackable(sessionID);
    ensureSeeded(sessionID);
    if (types.isProxy(event)) throw new Error(PROTECT_FAILED_ERROR);
    assertWritableDataProperty(event, "request");
    if (!(event.request instanceof Request)) throw new Error(PROTECT_FAILED_ERROR);
    // HTTP fallback must not leave a previous WS request eligible to receive.
    if (event.model !== undefined) webSocket.resetRequest(event);
    // Registered only with wire protection; hook-only has no request gate.
    const request = await remaskModelRequest(transportService, sessionID, event.request);
    event.request = request;
    attributions.set(request, { sessionID, kind: kindOf(event), model: contextModel(event) });
    track(sessionID);
    persistIfChanged(sessionID);
  };

  const onHttpResponse = async (event: RecordLike): Promise<void> => {
    try {
      const sessionID = requireSessionID(event);
      assertTrackable(sessionID);
      if (!sessions.has(sessionID)) throw new Error(ATTRIBUTION_ERROR);
      if (!(event.request instanceof Request) || !(event.response instanceof Response)) throw new Error(ATTRIBUTION_ERROR);
      if (wireProtection) {
        const attribution = attributions.get(event.request);
        if (attribution === undefined || attribution.sessionID !== sessionID || attribution.kind !== kindOf(event) || attribution.model !== contextModel(event)) {
          throw new Error(ATTRIBUTION_ERROR);
        }
      } else if (!hasProtectedContext(event)) {
        throw new Error(ATTRIBUTION_ERROR);
      }
      ensureSeeded(sessionID);
      // Hook-only routes have no response adapter. Do not guess their dialect.
      if (classifyModelRoute(event.request.url) === null) return;
      event.response = await restoreModelResponse(transportService, sessionID, event.request, event.response);
      track(sessionID);
    } catch {
      // Restoration is optional on ingress. Keep the original one-shot body;
      // upstream failures will still surface when the host reads that body.
      noticeOnce("HTTP reply kept original after attribution or restoration failure; placeholders may remain literal");
    }
  };

  /**
   * True when at least one placeholder in `text` belongs to this session.
   * Shell quoting rules only matter when a placeholder is actually replaced;
   * an unmapped literal must fall through to the mapping policy instead of
   * being reported as an unsupported shell construct.
   */
  const containsMappedToken = (sessionID: string, text: string): boolean => {
    for (const match of text.matchAll(TOKEN_SCAN)) {
      if (transportService.restoreText(sessionID, match[0]).ok) return true;
    }
    return false;
  };

  /**
   * True when `text` holds a placeholder of this session whose format was
   * changed (brackets dropped or half-dropped, separators swapped, case
   * lowered). Exact canonical tokens are blanked first; partially masked forms
   * and tokens unknown to the session never qualify.
   */
  const textHasNearMiss = (sessionID: string, text: string): boolean => {
    if (!/sgp[12]/i.test(text)) return false;
    const rest = text.replace(TOKEN_SCAN, " ");
    for (const head of rest.matchAll(NEAR_MISS_V2_HEAD)) {
      const words: string[] = [];
      NEAR_MISS_V2_WORD.lastIndex = head.index + head[0].length;
      while (words.length < NEAR_MISS_V2_MAX_CATEGORY_WORDS + 3) {
        const word = NEAR_MISS_V2_WORD.exec(rest);
        if (word === null) break;
        words.push(word[1] as string);
      }
      for (let size = 1; size <= NEAR_MISS_V2_MAX_CATEGORY_WORDS && size + 3 <= words.length; size++) {
        const segments = words.slice(size, size + 3);
        if (segments.some((segment) => segment.length !== 4)) continue;
        const category = words.slice(0, size).join("_").toUpperCase();
        const canonical = `[SGP2:${category}-${segments.join("-").toLowerCase()}]`;
        ensureSeeded(sessionID);
        if (transportService.restoreText(sessionID, canonical).ok) return true;
      }
    }
    for (const match of rest.matchAll(NEAR_MISS_V1)) {
      const canonical = `[SGP1:${match[1].toLowerCase()}-${match[2]}]`;
      ensureSeeded(sessionID);
      if (transportService.restoreText(sessionID, canonical).ok) return true;
    }
    return false;
  };

  /**
   * Read-only walk over every string leaf and object key of a tool input.
   * Never throws and never runs getters: proxies, accessors, symbols and
   * non-plain objects are skipped silently, cycles are guarded, frozen objects
   * are scanned. `skipCode` leaves the top-level `code` string of a Code Mode
   * call alone.
   */
  const inputHasNearMiss = (sessionID: string, input: unknown, skipCode: boolean): boolean => {
    try {
      if (typeof input === "string") return textHasNearMiss(sessionID, input);
      const seen = new WeakSet<object>();
      const stack: Array<{ value: unknown; top: boolean }> = [{ value: input, top: true }];
      while (stack.length > 0) {
        const { value, top } = stack.pop()!;
        if (value === null || typeof value !== "object") continue;
        if (types.isProxy(value) || seen.has(value)) continue;
        seen.add(value);
        const isArray = Array.isArray(value);
        if (!isArray) {
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== null) continue;
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const key of Object.keys(descriptors)) {
          if (isArray && key === "length") continue;
          if (!isArray && textHasNearMiss(sessionID, key)) return true;
          const descriptor = descriptors[key];
          if (!("value" in descriptor)) continue;
          if (skipCode && top && key === "code" && typeof descriptor.value === "string") continue;
          if (typeof descriptor.value === "string") {
            if (textHasNearMiss(sessionID, descriptor.value)) return true;
          } else {
            stack.push({ value: descriptor.value, top: false });
          }
        }
      }
    } catch {
      return false;
    }
    return false;
  };

  /**
   * Restores registered tokens in a tool input leaf according to its policy.
   * "shell": the token must occupy a complete argument word AND its original
   * must be safe in that word's quote context; command/assignment/redirect
   * tokens, expansion, quote-breaking and option injection refuse the call.
   * "inert" (code/script fields): every restorable token's original must be
   * free of shell-unsafe characters (spaces included), and the token must sit
   * look like it sits in an ordinary single-line quoted string without
   * interpolation, outside any multi-line string or line continuation
   * (conservative heuristic, not a parser: it can over-refuse and miss, and
   * does not confirm the token is in a string; it guards the restoration
   * context, not egress). Otherwise the call is refused. "verbatim": plain restore.
   *
   * P1 (2026-10-06b) limited best-effort: when `allowDegraded` is set (the
   * call is a proven read-only tool with no shell/code fields) and the leaf is
   * "verbatim", a mapping failure (unknown/malformed marker) keeps the leaf
   * literal and records a degradation instead of refusing. Every other
   * failure kind still refuses.
   */
  const restoreLeaf = (
    sessionID: string,
    text: string,
    policy: ToolLeafPolicy,
    allowDegraded: boolean,
    degraded: { count: number },
  ): string => {
    if (!containsTokenPrefix(text)) return text;
    if (policy === "inert" && containsMappedToken(sessionID, text)) {
      const isAllowedPosition = createInertPositionCheck(text);
      for (const match of text.matchAll(TOKEN_SCAN)) {
        const restoredToken = transportService.restoreText(sessionID, match[0]);
        if (!restoredToken.ok) continue;
        if (!isShellSafeOriginal(restoredToken.text, "none")) throw new Error(TOOL_CODE_CONTEXT_ERROR);
        if (!isAllowedPosition(match.index, match.index + match[0].length)) throw new Error(TOOL_CODE_POSITION_ERROR);
      }
    }
    if (policy === "shell" && containsMappedToken(sessionID, text)) {
      const argumentsOnly = parseSupportedShellArguments(text);
      if (argumentsOnly === null) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
      for (const match of text.matchAll(TOKEN_SCAN)) {
        const end = match.index + match[0].length;
        const argument = argumentsOnly.find((word) => word.value === match[0] && word.start <= match.index && word.end >= end);
        if (argument === undefined) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
        const restoredToken = transportService.restoreText(sessionID, match[0]);
        if (!restoredToken.ok) throw new Error(toolRestoreError(restoredToken.reason));
        if (!isShellSafeOriginal(restoredToken.text, argument.quote)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
      }
    }
    const restored = transportService.restoreText(sessionID, text);
    if (restored.ok) return restored.text;
    if (
      allowDegraded &&
      policy === "verbatim" &&
      (restored.reason === "unknown_token" || restored.reason === "malformed_token")
    ) {
      degraded.count += 1;
      return text;
    }
    throw new Error(toolRestoreError(restored.reason));
  };

  type ToolAssignment = { container: RecordLike | unknown[]; key: string | number; value: string };

  /**
   * Planning pass: computes every replacement WITHOUT mutating, and rejects
   * frozen/unwritable containers or token-bearing keys. Nothing is written
   * until the whole plan is known to be applicable.
   */
  const planToolInput = (
    value: unknown,
    sessionID: string,
    policy: ToolLeafPolicy,
    seen: WeakSet<object>,
    out: ToolAssignment[],
    allowDegraded: boolean,
    degraded: { count: number },
  ): void => {
    if (value === null || typeof value !== "object") return;
    if (types.isProxy(value) || seen.has(value) || Object.isFrozen(value)) {
      throw new Error(TOOL_INPUT_SHAPE_ERROR);
    }
    seen.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(TOOL_INPUT_SHAPE_ERROR);
    if (Array.isArray(value)) {
      for (const key of Object.keys(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (descriptor === undefined) continue;
        if (!("value" in descriptor)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
        const item = descriptor.value;
        if (typeof item === "string") {
          const next = restoreLeaf(sessionID, item, policy, allowDegraded, degraded);
          if (next !== item) out.push({ container: value, key: index, value: next });
        } else {
          planToolInput(item, sessionID, policy, seen, out, allowDegraded, degraded);
        }
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(TOOL_INPUT_SHAPE_ERROR);
    const record = value as RecordLike;
    for (const key of Object.keys(record)) {
      if (containsTokenPrefix(key)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      const item = descriptor.value;
      const itemPolicy = keyPolicy(key, policy);
      if (typeof item === "string") {
        const next = restoreLeaf(sessionID, item, itemPolicy, allowDegraded, degraded);
        if (next !== item) out.push({ container: record, key, value: next });
      } else {
        planToolInput(item, sessionID, itemPolicy, seen, out, allowDegraded, degraded);
      }
    }
  };

  const assertToolPlanWritable = (plan: readonly ToolAssignment[]): void => {
    for (const assignment of plan) {
      const descriptor = Object.getOwnPropertyDescriptor(assignment.container, assignment.key);
      if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
        throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
    }
  };

  const applyToolPlan = (plan: readonly ToolAssignment[]): void => {
    for (const assignment of plan) {
      if (Array.isArray(assignment.container)) {
        assignment.container[assignment.key as number] = assignment.value;
      } else {
        (assignment.container as RecordLike)[assignment.key as string] = assignment.value;
      }
    }
  };

  const onToolBefore = (event: RecordLike): void => {
    const codeMode =
      event.tool === CODE_MODE_TOOL && isRecordLike(event.input) && typeof (event.input as RecordLike).code === "string";
    // Placeholders whose format the model changed would reach the tool as junk
    // with no error; refuse them before anything is restored or mutated.
    if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
      if (inputHasNearMiss(event.sessionID, event.input, codeMode)) {
        throw new Error(TOOL_PLACEHOLDER_NEAR_MISS_ERROR);
      }
      if (codeMode) {
        const code = (event.input as RecordLike).code as string;
        if (/\bfetch\b/.test(code) && /sgp[12]/i.test(code)) {
          ensureSeeded(event.sessionID);
          if (containsMappedToken(event.sessionID, code) || textHasNearMiss(event.sessionID, code)) {
            throw new Error(TOOL_CODE_FETCH_ERROR);
          }
        }
      }
    }
    if (!inputCarriesToken(event.input, new WeakSet())) return;
    const sessionID = requireSessionID(event);
    ensureSeeded(sessionID);
    const rawTool = typeof event.tool === "string" ? event.tool : "";
    const tool = rawTool.toLowerCase();
    // Code Mode source is JavaScript and the host re-fires this hook for each
    // inner tool call with evaluated arguments; that is where restoration and
    // the shell/inert/verbatim rules apply. A placeholder in the source stays
    // literal. Any other shape or name falls through to the logic below.
    if (codeMode) {
      return;
    }
    // Field-level model: the root policy is "shell" for shell tools and
    // "verbatim" otherwise; each key may then switch the policy for its value
    // (shell/command-like keys -> "shell", code/script keys -> "inert",
    // description/title/label -> "verbatim").
    const shellTool = isShellTool(rawTool);
    const rootPolicy: ToolLeafPolicy = shellTool ? "shell" : "verbatim";
    // P1 (2026-10-06b): only proven read-only tools without shell/code fields
    // may degrade to literal placeholders; everything else refuses the
    // affected invocation when restoration is incomplete.
    const allowDegraded =
      READ_ONLY_TOOLS.has(tool) &&
      !shellTool &&
      !(isRecordLike(event.input) &&
        Object.keys(event.input as RecordLike).some((key) => isShellKey(key) || isCodeKey(key)));
    const degraded = { count: 0 };
    if (typeof event.input === "string") {
      const descriptor = Object.getOwnPropertyDescriptor(event, "input");
      if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
        throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
      event.input = restoreLeaf(sessionID, event.input, rootPolicy, allowDegraded, degraded);
    } else {
      const plan: ToolAssignment[] = [];
      planToolInput(event.input, sessionID, rootPolicy, new WeakSet(), plan, allowDegraded, degraded);
      assertToolPlanWritable(plan);
      applyToolPlan(plan);
    }
    if (degraded.count > 0) {
      warnDegradation(
        `read-only tool call kept ${degraded.count} literal placeholder(s); the tool's no-match output is the in-band signal`,
      );
    }
  };

  return {
    setup: async (ctx: PluginContext) => {
      try {
        for (const kind of ["context", "compaction", "generate", "title"] as const) {
          disposals.push(
            (
              await ctx.session.hook(kind, (event) => {
                protectRequestKind(event as unknown as RecordLike, kind === "context" ? "primary" : kind);
              })
            ).dispose,
          );
        }
        if (wireProtection) {
          disposals.push(
            (
              await ctx.session.hook("http.request", (event) => {
                return onHttpRequest(event as unknown as RecordLike);
              })
            ).dispose,
          );
        }
        try {
          disposals.push(
            (
              await ctx.session.hook("http.response", (event) => {
                return onHttpResponse(event as unknown as RecordLike);
              })
            ).dispose,
          );
        } catch (error) {
          if (wireProtection) throw error;
          noticeOnce("HTTP reply restoration hook unavailable; content and tool hooks remain active");
        }
        const socketHooks = wireProtection
          ? ["experimental.ws.handshake", "experimental.ws.send", "experimental.ws.receive"] as const
          : ["experimental.ws.receive"] as const;
        for (const name of socketHooks) {
          try {
            disposals.push(
              (
              await ctx.session.hook(name, async (input) => {
                const event = input as unknown as RecordLike;
                try {
                  const sessionID = requireSessionID(event);
                  assertTrackable(sessionID);
                  if (name === "experimental.ws.receive" && !sessions.has(sessionID)) throw new Error(ATTRIBUTION_ERROR);
                  ensureSeeded(sessionID);
                  if (types.isProxy(event)) throw new Error(PROTECT_FAILED_ERROR);
                  if (name === "experimental.ws.handshake") webSocket.handshake(event);
                  else {
                    assertWritableDataProperty(event, "frame");
                    event.frame = name === "experimental.ws.send" ? await webSocket.send(event)
                      : wireProtection ? webSocket.receive(event) : webSocket.receiveOnly(event);
                  }
                  track(sessionID);
                  if (name === "experimental.ws.send") persistIfChanged(sessionID);
                } catch (error) {
                  if (name === "experimental.ws.receive") {
                    try {
                      const frame = webSocket.abandonResponse(event);
                      if (frame !== undefined) event.frame = frame;
                    } catch { /* Unwritable or invalid input stays untouched. */ }
                    noticeOnce("WS reply kept original after attribution or restoration failure; placeholders may remain literal");
                    return;
                  }
                  try { webSocket.reset(event); } catch { /* Invalid attribution has no lane to reset. */ }
                  // Adapter diagnostics are static. Do not surface native URL/
                  // Headers errors, which may embed a credential or raw value.
                  const message = error instanceof Error && error.message.startsWith("LeakShield ")
                    ? error.message : PROTECT_FAILED_ERROR;
                  throw new Error(`${message} [hook=${name}]`);
                }
              })
              ).dispose,
            );
          } catch (error) {
            if (wireProtection) throw error;
            noticeOnce("WS reply restoration hook unavailable; content and tool hooks remain active");
          }
        }
        for (const name of wireProtection ? ["sdk", "language"] as const : []) {
          disposals.push(
            (await ctx.aisdk.hook(name, (event) => {
              try { aiSDK.admit(event as unknown as RecordLike); }
              catch {
                throw new Error(`${UNSUPPORTED_ROUTE_ERROR} AI SDK providers must honor OpenCode's injected HTTP fetch. [hook=aisdk.${name}]`);
              }
            })).dispose,
          );
        }
        disposals.push(
          (
            await ctx.tool.hook("execute.before", (event) => {
              onToolBefore(event as unknown as RecordLike);
            })
          ).dispose,
        );
        // Public V2 events are an optional reclamation optimization: an absent
        // or failed stream retains mappings rather than evicting live state.
        // Subscribe only after all protection hooks have been armed.
        if (ctx.event?.subscribe) {
          const controller = new AbortController();
          disposals.push(async () => { controller.abort(); });
          void (async () => {
            try {
              for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                if (event.type === "session.deleted") releaseSession(event.data.sessionID);
              }
              if (!controller.signal.aborted) noticeOnce("session lifecycle stream ended; mappings retained until unload");
            } catch {
              if (!controller.signal.aborted) noticeOnce("session lifecycle stream unavailable; mappings retained until unload");
            }
          })();
        }
      } catch (error) {
        // Registration failed partway: undo what was armed, then surface the
        // failure so the caller can fall back to its fail-closed setup.
        // R-round (F4.5): the store handle must not leak on this path.
        await runDisposals(disposals);
        webSocket.dispose();
        aiSDK.dispose();
        store?.close();
        store = null;
        throw error;
      }
    },
    dispose: async () => {
      await runDisposals(disposals);
      webSocket.dispose();
      aiSDK.dispose();
      for (const sessionID of sessions) pseudonymizer.clearSession(sessionID);
      sessions.clear();
      protectedContexts.clear();
      notices.clear();
      seedAttempts.clear();
      persistedEntries.clear();
      persistVersions.clear();
      noPersist.clear();
      // W2 (decision §4.4): dispose unloads hooks and in-memory state only —
      // persisted mappings survive until TTL expiry or an explicit forget.
      store?.close();
      store = null;
    },
  };
}

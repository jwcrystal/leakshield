/**
 * OpenCode v2 transparent pseudonymization session guard (issue #22, stage 1
 * — offline mocks only).
 *
 * One guard owns exactly ONE pseudonymizer service (bounded per setup, no
 * session fallback, no TTL, no eviction) and its own hook registrations and
 * disposal. Protection model:
 *
 * - The four model-request kinds (`context`, `compaction`, `generate`,
 *   `title`) protect an atomic snapshot (system, messages, options, tools
 *   schema) with `protectJson` and publish it back only after the whole
 *   transaction succeeds — never piecewise in place, never partial.
 * - `http.request` performs the final wire mask (see
 *   ./opencode-transparent-http.js) and records a private correlation
 *   (request identity ↔ session + kind). `http.response` restores assistant
 *   display text only, and refuses responses whose attribution is missing or
 *   mismatched.
 * - WebSocket routes (`experimental.ws.*`) and AI SDK routes (`aisdk:sdk`,
 *   `aisdk:language`) fail closed: transparent mode cannot guarantee a final
 *   scan on those paths.
 * - `tool:execute.before` restores registered tokens in tool arguments so local
 *   tools run with the real values (the model never sees them). Restoration is
 *   deep over the argument tree and keeps keys/types; a foreign, unknown or
 *   malformed token refuses the whole call. Shell-like tools accept tokens
 *   only as unquoted arguments in a single simple command with no expansion,
 *   redirection, or control syntax; every other shell command containing a
 *   token is refused. Token-free calls pass through unchanged.
 *
 * Deliberately NOT registered in transparent mode: `session:prompt` (prompt
 * admission and local persistence keep originals by design — protection is at
 * the model boundary), `session:model.request` (routing/headers only; no
 * content is exposed there to scan), `tool:execute.after` (local tool results
 * stay original; their outbound replay is protected by the request kinds).
 *
 * No session-deletion event is guessed or inferred; mappings are cleared only
 * by the explicit `dispose()` of this guard.
 */

import { types } from "node:util";
import type { Plugin as PluginNamespace } from "@opencode/plugin";
import {
  createPseudonymizer,
  PSEUDONYM_TOKEN_PREFIX,
  type PseudonymFailureReason,
  type PseudonymizerService,
} from "./decision/pseudonymization.js";
import { walkSchemaStrings } from "./decision/schema-strings.js";
import {
  remaskModelRequest,
  restoreModelResponse,
  withOpaqueAttachments,
  type TransportMaskingService,
} from "./opencode-transparent-http.js";
import type { GuardConfig } from "./types.js";

type V2Plugin = PluginNamespace.Plugin;
type PluginContext = PluginNamespace.Context;

type RecordLike = { [key: string]: unknown };

// ─── Static failure messages (no content ever included) ─────────────────────

const INITIALIZATION_ERROR =
  "Sensitive Guard initialization failed. Model request blocked before content was sent.";
const PROTECT_FAILED_ERROR =
  "Sensitive Guard transparent mode failed to protect a model request.";
const ATTRIBUTION_ERROR =
  "Sensitive Guard transparent mode blocked a response without verified request attribution.";
const UNSUPPORTED_ROUTE_ERROR =
  "Sensitive Guard transparent mode blocked an unsupported model transport route (WebSocket and AI SDK routes are not supported).";
const TOOL_REFUSAL_ERROR =
  "Sensitive Guard transparent mode blocked this tool call because its arguments could not be safely restored. Refresh the affected arguments and retry.";
const TOOL_UNKNOWN_MAPPING_ERROR =
  "Sensitive Guard transparent mode blocked this tool call because a placeholder has no mapping in this session. Re-read the source in this session, refresh the affected arguments, and retry.";
const TOOL_RESTORE_LIMIT_ERROR =
  "Sensitive Guard transparent mode blocked this tool call because its arguments exceed the safe restoration limit. Reduce the arguments and retry.";
const TOOL_SHELL_CONTEXT_ERROR =
  "Sensitive Guard transparent mode blocked this tool call because the shell command does not use a supported literal-argument form. Rewrite it as a simple command or use a non-shell tool.";
const TOOL_INPUT_SHAPE_ERROR =
  "Sensitive Guard transparent mode blocked this tool call because its argument structure cannot be safely restored. Refresh the arguments using plain JSON values and retry.";
const STRUCTURAL_SENSITIVE_ERROR =
  "Sensitive Guard transparent mode refused this model request: a structural identifier (message or tool id, name, role, or part type) scans as sensitive, and masking cannot rewrite it without breaking the protocol. Adjust the matching rule in the guard config or change the identifier, then retry.";

function toolRestoreError(reason: PseudonymFailureReason): string {
  if (reason === "unknown_token" || reason === "malformed_token") return TOOL_UNKNOWN_MAPPING_ERROR;
  if (reason === "operation_limit") return TOOL_RESTORE_LIMIT_ERROR;
  return TOOL_REFUSAL_ERROR;
}

/**
 * Characters that may safely PRECEDE a restored token inside a shell command.
 * `$`, backtick, `{` and `(` are deliberately absent: a token there sits inside
 * a parameter expansion, command substitution or grouping where substituting
 * the plain value changes the command's meaning (e.g. `$TOKEN` would become a
 * variable reference). Whitespace and simple separators keep the token an
 * ordinary operand word.
 */
/** Shell syntax excluded from the supported unquoted simple-command subset. */
const UNSUPPORTED_SHELL_SYNTAX = /[\x00-\x1f\x7f'"`\\$;|&<>(){}*?\[\]!~#]/;

/**
 * True only for an unquoted argument word in a single simple command. Rejecting
 * all other shell syntax avoids context-dependent substitution in expansions,
 * heredocs, command position, and compound commands.
 */
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

function tokenIsStandaloneArgument(text: string, start: number, end: number): boolean {
  if (start === 0 || text[start - 1] !== " ") return false;
  if (end < text.length && text[end] !== " ") return false;
  const wordsBefore = text.slice(0, start).split(" ").filter(Boolean);
  const commandWord = wordsBefore.find((word) => !ASSIGNMENT_WORD.test(word));
  if (commandWord === undefined) return false;
  const commandName = commandWord.split("/").at(-1)?.toLowerCase() ?? "";
  return !SHELL_COMMAND_WRAPPERS.has(commandName);
}

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

function isSupportedSimpleShellCommand(text: string): boolean {
  const withoutTokens = text.replace(TOKEN_SCAN, "TOKEN");
  if (UNSUPPORTED_SHELL_SYNTAX.test(withoutTokens)) return false;
  const words = withoutTokens.split(" ").filter(Boolean);
  const commandIndex = words.findIndex((word) => !ASSIGNMENT_WORD.test(word));
  if (commandIndex === -1) return false;
  const commandName = words[commandIndex].split("/").at(-1)?.toLowerCase() ?? "";
  if (SHELL_COMMAND_WRAPPERS.has(commandName) || SCRIPT_ARGUMENT_INTERPRETERS.has(commandName)) return false;
  if (SHELL_INTERPRETERS.has(commandName)) {
    if (words.slice(commandIndex + 1).some((argument) => /^-[A-Za-z]*c[A-Za-z]*$/.test(argument))) return false;
  }
  const inlineFlags =
    INLINE_SCRIPT_FLAGS.get(commandName) ??
    (/^python(?:\d+(?:\.\d+)*)?$/.test(commandName) ? INLINE_SCRIPT_FLAGS.get("python") : undefined);
  if (inlineFlags && words.slice(commandIndex + 1).some((argument) => inlineFlags.has(argument.toLowerCase()))) return false;
  return !(commandName === "deno" && words.slice(commandIndex + 1).includes("eval"));
}

/** Characters forbidden inside restored shell argument words. */
const SHELL_UNSAFE = /[\s'"`\\$;|&<>(){}*?\[\]!~#\x00-\x1F\x7F]/;
/**
 * Conservative allowlist of non-executing tools. Any tool not listed here is
 * treated as potentially shell-like and requires shell-safe originals, so an
 * unrecognized (or newly added) executing tool fails closed rather than
 * receiving a value that could change its meaning.
 */
const NON_SHELL_TOOLS = new Set([
  "read",
  "read_file",
  "view",
  "write",
  "write_file",
  "create_file",
  "edit",
  "edit_file",
  "multiedit",
  "patch",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
  "grep",
  "glob",
  "list",
  "ls",
  "find",
  "webfetch",
  "websearch",
  "fetch",
  "todowrite",
  "todoread",
  "notebookedit",
]);
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
  console.warn(`[sensitive-guard] degraded: ${context}`);
};
/** A value is shell-safe when it is non-empty, does not start with "-", and
 * contains no shell-significant character. */
function isShellSafeOriginal(text: string): boolean {
  return text.length > 0 && !text.startsWith("-") && !SHELL_UNSAFE.test(text);
}
/** Matches a fully formed reserved token, for per-token shell safety checks. */
const TOKEN_SCAN = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]/g;

/**
 * Bound on distinct session identities retained for disposal. The core already
 * caps committed sessions; this bounds identities seen with safe-only content
 * so a stream of fresh session ids cannot grow the set without limit. Beyond
 * it, a new session fails closed.
 */
const MAX_TRACKED_SESSIONS = 4096;

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

/**
 * Replaces media/file attachment PARTS (array slots) with an explanatory text
 * part: binary or base64 content cannot be scanned, so it never crosses the
 * boundary — the conversation continues with a notice instead of the whole
 * session failing. (2026-10-05 product decision, owner-approved; spec
 * revised.) A media/file record found in a NON-part slot (a bare object
 * value) is an unexpected shape and still fails closed.
 */
const ATTACHMENT_PLACEHOLDER_TEXT =
  "[sensitive-guard: attachment omitted — binary content is never sent to the model]";

const ATTACHMENT_ALLOW_NOTICE_TEXT =
  "[sensitive-guard: attachment(s) allowed through unscanned per configuration — the user vouches for their content]";

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
  if (typeof value === "string") return value.includes(PSEUDONYM_TOKEN_PREFIX);
  if (value === null || typeof value !== "object") return false;
  if (types.isProxy(value)) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length > 0) return true;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Object.keys(descriptors)) {
    if (Array.isArray(value) && key === "length") continue;
    if (key.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
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
 * transport routes (http/ws/aisdk), not only the redact-mode hooks.
 */
export function createFailClosedTransparentGuard(): TransparentSessionGuard {
  const disposals: Array<() => Promise<void>> = [];
  const refuse = (): never => {
    throw new Error(INITIALIZATION_ERROR);
  };
  return {
    setup: async (ctx: PluginContext) => {
      try {
        for (const name of [
          "context",
          "compaction",
          "generate",
          "title",
          "http.request",
          "http.response",
          "experimental.ws.handshake",
          "experimental.ws.send",
          "experimental.ws.receive",
        ] as const) {
          disposals.push((await ctx.session.hook(name, refuse)).dispose);
        }
        disposals.push((await ctx.aisdk.hook("sdk", refuse)).dispose);
        disposals.push((await ctx.aisdk.hook("language", refuse)).dispose);
        disposals.push((await ctx.tool.hook("execute.before", refuse)).dispose);
      } catch (error) {
        await runDisposals(disposals);
        throw error;
      }
    },
    dispose: () => runDisposals(disposals),
  };
}

/**
 * Creates the transparent session guard for one plugin setup (= one OpenCode
 * process): a single bounded pseudonymizer, exact-session mapping, private
 * request attribution, and its own registrations.
 */
export function createTransparentSessionGuard(
  config: GuardConfig,
  attachmentsPolicy: "block" | "allow" = "block",
): TransparentSessionGuard {
  const created = createPseudonymizer(config);
  if (!created.ok) return createFailClosedTransparentGuard();
  const pseudonymizer: PseudonymizerService = created;

  const disposals: Array<() => Promise<void>> = [];
  const sessions = new Set<string>();
  /** Fails closed on a new session once the tracked-session budget is full. */
  const assertTrackable = (sessionID: string): void => {
    if (!sessions.has(sessionID) && sessions.size >= MAX_TRACKED_SESSIONS) {
      throw new Error(PROTECT_FAILED_ERROR);
    }
  };
  /**
   * Retains a session for disposal. Called only AFTER an operation succeeds, so
   * failed requests cannot grow the set ("failed-session IDs unbounded").
   */
  const track = (sessionID: string): void => {
    sessions.add(sessionID);
  };
  /** Private correlation of a dispatched request to its session and kind. */
  const attributions = new WeakMap<Request, { sessionID: string; kind: string }>();

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
    if (text.includes(PSEUDONYM_TOKEN_PREFIX)) {
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

  const transportService: TransportMaskingService = {
    protectJsonForModel: (sid, value) => pseudonymizer.protectJsonForModel(sid, value),
    restoreText: (sid, text) => pseudonymizer.restoreText(sid, text),
    restoreTextForDisplay: (sid, text) => pseudonymizer.restoreTextForDisplay(sid, text),
    detectSensitive,
    isStructuralIdentifierSafe: (sid, text) => pseudonymizer.isStructuralIdentifierSafe(sid, text),
    attachmentsPolicy,
  };

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

  const protectRequestKind = (event: RecordLike): void => {
    const sessionID = requireSessionID(event);
    assertTrackable(sessionID);
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
      if (!masked.ok) throw new Error(PROTECT_FAILED_ERROR);
      if (!isRecordLike(masked.value)) throw new Error(PROTECT_FAILED_ERROR);
      return masked.value as RecordLike;
    };
    const value = withOpaqueAttachments(attachmentsPolicy, plain, protectTree);
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
  };

  const onHttpRequest = async (event: RecordLike): Promise<void> => {
    const sessionID = requireSessionID(event);
    assertTrackable(sessionID);
    if (types.isProxy(event)) throw new Error(PROTECT_FAILED_ERROR);
    assertWritableDataProperty(event, "request");
    if (!(event.request instanceof Request)) throw new Error(PROTECT_FAILED_ERROR);
    const request = await remaskModelRequest(transportService, sessionID, event.request);
    event.request = request;
    attributions.set(request, { sessionID, kind: kindOf(event) });
    track(sessionID);
  };

  const onHttpResponse = async (event: RecordLike): Promise<void> => {
    const sessionID = requireSessionID(event);
    assertTrackable(sessionID);
    if (!(event.request instanceof Request) || !(event.response instanceof Response)) {
      throw new Error(ATTRIBUTION_ERROR);
    }
    const attribution = attributions.get(event.request);
    if (
      attribution === undefined ||
      attribution.sessionID !== sessionID ||
      attribution.kind !== kindOf(event)
    ) {
      throw new Error(ATTRIBUTION_ERROR);
    }
    event.response = await restoreModelResponse(transportService, sessionID, event.request, event.response);
    track(sessionID);
  };

  /**
   * Restores registered tokens in a tool input leaf. For shell-like tools the
   * token must occupy a standalone word AND the substituted value must be free
   * of shell-significant characters and must not start with "-": otherwise the
   * substitution could change the command's meaning (variable expansion,
   * word splitting, globbing, option injection). Anything not provably safe
   * refuses the whole call.
   *
   * P1 (2026-10-06b) limited best-effort: when `allowDegraded` is set (the
   * call is a proven read-only tool, not shell-like) a mapping failure
   * (unknown/malformed marker) keeps the leaf literal and records a
   * degradation instead of refusing — the placeholder reads as a literal
   * that matches nothing, the tool's own output is the in-band signal, and a
   * content-free WARN line is logged. Every other failure kind still refuses.
   */
  const restoreLeaf = (
    sessionID: string,
    text: string,
    shellLike: boolean,
    allowDegraded: boolean,
    degraded: { count: number },
  ): string => {
    if (!text.includes(PSEUDONYM_TOKEN_PREFIX)) return text;
    if (shellLike) {
      if (!isSupportedSimpleShellCommand(text)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
      TOKEN_SCAN.lastIndex = 0;
      for (let match = TOKEN_SCAN.exec(text); match !== null; match = TOKEN_SCAN.exec(text)) {
        const end = match.index + match[0].length;
        if (!tokenIsStandaloneArgument(text, match.index, end)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
        const restoredToken = transportService.restoreText(sessionID, match[0]);
        if (!restoredToken.ok) throw new Error(toolRestoreError(restoredToken.reason));
        if (!isShellSafeOriginal(restoredToken.text)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
      }
    }
    const restored = transportService.restoreText(sessionID, text);
    if (restored.ok) return restored.text;
    if (
      allowDegraded &&
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
    shellLike: boolean,
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
          const next = restoreLeaf(sessionID, item, shellLike, allowDegraded, degraded);
          if (next !== item) out.push({ container: value, key: index, value: next });
        } else {
          planToolInput(item, sessionID, shellLike, seen, out, allowDegraded, degraded);
        }
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(TOOL_INPUT_SHAPE_ERROR);
    const record = value as RecordLike;
    for (const key of Object.keys(record)) {
      if (key.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !("value" in descriptor)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      const item = descriptor.value;
      if (typeof item === "string") {
        const next = restoreLeaf(sessionID, item, shellLike, allowDegraded, degraded);
        if (next !== item) out.push({ container: record, key, value: next });
      } else {
        planToolInput(item, sessionID, shellLike, seen, out, allowDegraded, degraded);
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
    if (!inputCarriesToken(event.input, new WeakSet())) return;
    const sessionID = requireSessionID(event);
    const tool = typeof event.tool === "string" ? event.tool.toLowerCase() : "";
    const shellLike =
      !NON_SHELL_TOOLS.has(tool) ||
      (isRecordLike(event.input) && typeof (event.input as RecordLike).command === "string");
    // P1 (2026-10-06b): only proven read-only, non-shell tools may degrade to
    // literal placeholders; writes/deletes/outbound/unknown tools keep
    // refusing the affected invocation when restoration is incomplete.
    const allowDegraded = READ_ONLY_TOOLS.has(tool) && !shellLike;
    const degraded = { count: 0 };
    if (typeof event.input === "string") {
      const descriptor = Object.getOwnPropertyDescriptor(event, "input");
      if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
        throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
      event.input = restoreLeaf(sessionID, event.input, shellLike, allowDegraded, degraded);
    } else {
      const plan: ToolAssignment[] = [];
      planToolInput(event.input, sessionID, shellLike, new WeakSet(), plan, allowDegraded, degraded);
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
                protectRequestKind(event as unknown as RecordLike);
              })
            ).dispose,
          );
        }
        disposals.push(
          (
            await ctx.session.hook("http.request", (event) => {
              return onHttpRequest(event as unknown as RecordLike);
            })
          ).dispose,
        );
        disposals.push(
          (
            await ctx.session.hook("http.response", (event) => {
              return onHttpResponse(event as unknown as RecordLike);
            })
          ).dispose,
        );
        for (const name of [
          "experimental.ws.handshake",
          "experimental.ws.send",
          "experimental.ws.receive",
        ] as const) {
          disposals.push(
            (
              await ctx.session.hook(name, () => {
                throw new Error(UNSUPPORTED_ROUTE_ERROR);
              })
            ).dispose,
          );
        }
        disposals.push(
          (
            await ctx.aisdk.hook("sdk", () => {
              throw new Error(UNSUPPORTED_ROUTE_ERROR);
            })
          ).dispose,
        );
        disposals.push(
          (
            await ctx.aisdk.hook("language", () => {
              throw new Error(UNSUPPORTED_ROUTE_ERROR);
            })
          ).dispose,
        );
        disposals.push(
          (
            await ctx.tool.hook("execute.before", (event) => {
              onToolBefore(event as unknown as RecordLike);
            })
          ).dispose,
        );
      } catch (error) {
        // Registration failed partway: undo what was armed, then surface the
        // failure so the caller can fall back to its fail-closed setup.
        await runDisposals(disposals);
        throw error;
      }
    },
    dispose: async () => {
      await runDisposals(disposals);
      for (const sessionID of sessions) pseudonymizer.clearSession(sessionID);
      sessions.clear();
    },
  };
}

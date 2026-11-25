import { types } from "node:util";
import {
  containsTokenPrefix,
  createPseudonymizer,
  type PseudonymFailureReason,
  type PseudonymizerService,
} from "../decision/pseudonymization.js";
import {
  MappingForgottenError,
  MappingKeyMismatchError,
  MappingSnapshotTooLargeError,
  MappingStoreConflictError,
  openMappingStore,
  type LoadedSession,
  type MappingKeyProvider,
  type MappingStore,
} from "../decision/mapping-store.js";
import { resolveMappingKey } from "../decision/mapping-key.js";
import { walkSchemaStrings } from "../decision/schema-strings.js";
import {
  classifyModelRoute,
  remaskModelRequest,
  restoreModelResponse,
  withOpaqueAttachments,
  type TransportMaskingService,
} from "./wire.js";
import { createResponsesWebSocketAdapter } from "./ws.js";
import {
  parseSupportedShellArguments,
  ToolLeafPolicy,
  warnDegradation,
  isShellSafeOriginal,
  commandAllowsEmbeddedTokens,
  isWgetExecuteCommand,
  TOKEN_SCAN,
  NEAR_MISS_V2_HEAD,
  NEAR_MISS_V2_SEGMENT_LETTERS,
  NEAR_MISS_V2_CATEGORIES,
  collectNearMissLetters,
  createInertPositionCheck,
} from "./tool-restore-policy.js";
import type { GuardConfig } from "../types.js";
import { BUILTIN_RULES } from "../rules/builtin.js";

export type RecordLike = { [key: string]: unknown };

// ─── Static failure messages (no content ever included) ─────────────────────

export const INITIALIZATION_ERROR =
  "LeakShield initialization failed, so the request was blocked before anything was sent.";
export const NO_REASON_HINT =
  "Run `leakshield --doctor` to see why, fix it and restart OpenCode.";
export const PROTECT_FAILED_ERROR =
  "LeakShield blocked a model request because it could not be masked safely.";
export const ATTRIBUTION_ERROR =
  "LeakShield blocked a response because it could not be matched to a request.";
export const UNSUPPORTED_ROUTE_ERROR =
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
  "LeakShield blocked this tool call because the structure of one argument could not be restored. This is not about what the value looks like or contains. Use plain JSON values (strings, numbers, booleans, arrays and plain objects) and try again.";
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

export function requireSessionID(event: RecordLike): string {
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

/** Host-defined classification. Without this capability, token-bearing tool calls refuse. */
export interface HostToolPolicy {
  isCodeModeCall(event: RecordLike): boolean;
  isShellTool(rawTool: string): boolean;
  classifyField(key: string, inherited: ToolLeafPolicy): ToolLeafPolicy;
  /** `rawTool` is the tool name as the host sent it, not lowercased. */
  allowsDegradedRestore(rawTool: string, input: unknown): boolean;
}

export interface GuardCore {
  readonly hasSession: (sessionID: string) => boolean;
  readonly assertTrackable: (sessionID: string) => void;
  readonly ensureSeeded: (sessionID: string) => void;
  readonly track: (sessionID: string) => void;
  readonly persistIfChanged: (sessionID: string) => void;
  readonly protectRequestKind: (event: RecordLike, kind: "primary" | "title" | "compaction" | "generate") => void;
  readonly onHttpRequest: (event: RecordLike) => Promise<void>;
  readonly onHttpResponse: (event: RecordLike) => Promise<void>;
  readonly onToolBefore: (event: RecordLike) => void;
  readonly releaseSession: (sessionID: string) => void;
  readonly noticeOnce: (message: string) => void;
  readonly webSocket: ReturnType<typeof createResponsesWebSocketAdapter>;
  readonly assertWritableDataProperty: (record: object, key: string | number) => void;
  /** Releases handles without clearing sessions: used when registration fails before any hook ran. */
  readonly closeResources: () => void;
  readonly dispose: () => void;
}

/**
 * Creates the host-independent guard core for one plugin setup (= one OpenCode
 * process): a single bounded pseudonymizer, exact-session mapping and private
 * request attribution. The host layer registers hooks that call its handlers.
 * With persistence options the core additionally hydrates sessions from the
 * encrypted store on first touch and writes committed mappings back (decision
 * §4: dispose unloads hooks but never deletes persisted mappings — forget is
 * the only erasure path). Returns null when the pseudonymizer cannot be built.
 */
export function createGuardCore(
  config: GuardConfig,
  attachmentsPolicy: "block" | "allow" = "block",
  wireProtection = true,
  persistence?: GuardPersistenceOptions,
  dialect: { anthropicThinking?: "refuse" | "mask" } = {},
  hostToolPolicy?: HostToolPolicy,
): GuardCore | null {
  const created = createPseudonymizer(config, TRANSPARENT_LIMITS);
  if (!created.ok) return null;
  const pseudonymizer: PseudonymizerService = created;

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
    anthropicThinking: dialect.anthropicThinking ?? "refuse",
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
   * lowered, separators changed or removed). Exact canonical tokens are blanked first; partially masked forms
   * and tokens unknown to the session never qualify.
   */
  const textHasNearMiss = (sessionID: string, text: string): boolean => {
    if (!/sgp2/i.test(text)) return false;
    const rest = text.replace(TOKEN_SCAN, " ");
    for (const head of rest.matchAll(NEAR_MISS_V2_HEAD)) {
      const letters = collectNearMissLetters(rest, head.index + head[0].length);
      const upper = letters.toUpperCase();
      for (const [compact, label] of NEAR_MISS_V2_CATEGORIES) {
        if (!upper.startsWith(compact) || letters.length - compact.length < NEAR_MISS_V2_SEGMENT_LETTERS) continue;
        const body = letters.slice(compact.length, compact.length + NEAR_MISS_V2_SEGMENT_LETTERS).toLowerCase();
        const canonical = `[SGP2:${label}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}]`;
        ensureSeeded(sessionID);
        if (transportService.restoreText(sessionID, canonical).ok) return true;
      }
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
      const embedded = commandAllowsEmbeddedTokens(text);
      if (isWgetExecuteCommand(text)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
      for (const match of text.matchAll(TOKEN_SCAN)) {
        const end = match.index + match[0].length;
        const argument = argumentsOnly.find(
          (word) => (embedded || word.value === match[0]) && word.start <= match.index && word.end >= end,
        );
        if (argument === undefined) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
        // In a word starting with `-`, only `--name=value` may hold a token. Short
        // options cluster, with punctuation flags too (`-#`, `-:`), so restored
        // text could become an option and its value (`-#T/tmp/x` uploads a file).
        const valueStart = argument.start + (argument.quote === "none" ? 0 : 1);
        const before = text.slice(valueStart, match.index);
        if (before.startsWith("-") && !/^--[A-Za-z0-9-]+=/.test(before)) throw new Error(TOOL_SHELL_CONTEXT_ERROR);
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

  type ToolAssignment = { container: RecordLike | unknown[]; key: string | number; value: unknown };

  /**
   * Planning pass: computes every replacement WITHOUT mutating, and rejects
   * proxies, shared/cyclic references, symbol keys, accessors, odd prototypes,
   * non-index array keys and token-bearing keys anywhere in the tree.
   *
   * A writable container gets its replacements pushed onto `out`. A frozen
   * container is never written: when its subtree needs a change it is rebuilt
   * as a new plain container and RETURNED, so the caller (the nearest writable
   * ancestor, or an enclosing frozen copy) takes it in place of the original.
   * It returns `undefined` when the value needs no replacement.
   */
  const planToolInput = (
    value: unknown,
    sessionID: string,
    policy: ToolLeafPolicy,
    seen: WeakSet<object>,
    out: ToolAssignment[],
    allowDegraded: boolean,
    degraded: { count: number },
  ): unknown => {
    if (value === null || typeof value !== "object") return undefined;
    if (types.isProxy(value) || seen.has(value)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
    seen.add(value);
    const frozen = Object.isFrozen(value);
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(TOOL_INPUT_SHAPE_ERROR);
    const isArray = Array.isArray(value);
    const changes: { key: string | number; next: unknown }[] = [];
    const plan = (item: unknown, itemPolicy: ToolLeafPolicy, key: string | number): void => {
      if (typeof item === "string") {
        const next = restoreLeaf(sessionID, item, itemPolicy, allowDegraded, degraded);
        if (next !== item) changes.push({ key, next });
      } else {
        const next = planToolInput(item, sessionID, itemPolicy, seen, out, allowDegraded, degraded);
        if (next !== undefined) changes.push({ key, next });
      }
    };
    if (isArray) {
      const array = value as unknown[];
      for (const key of Object.keys(array)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
      for (let index = 0; index < array.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(array, index);
        if (descriptor === undefined) continue;
        if (!("value" in descriptor) || !descriptor.enumerable) throw new Error(TOOL_INPUT_SHAPE_ERROR);
        plan(descriptor.value, policy, index);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      const record = value as RecordLike;
      // A copy keeps enumerable keys only, so a hidden property would vanish from it.
      if (Object.getOwnPropertyNames(record).length !== Object.keys(record).length) throw new Error(TOOL_INPUT_SHAPE_ERROR);
      for (const key of Object.keys(record)) {
        if (containsTokenPrefix(key)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new Error(TOOL_INPUT_SHAPE_ERROR);
        plan(descriptor.value, hostToolPolicy!.classifyField(key, policy), key);
      }
    }
    if (changes.length === 0) return undefined;
    if (!frozen) {
      for (const change of changes) {
        out.push({ container: value as RecordLike | unknown[], key: change.key, value: change.next });
      }
      return undefined;
    }
    // Frozen: copy only this container, keeping key order and array positions.
    const replaced = new Map<string | number, unknown>(changes.map((change) => [change.key, change.next]));
    if (isArray) {
      const source = value as unknown[];
      const copy = new Array<unknown>(source.length);
      for (const key of Object.keys(source)) {
        const index = Number(key);
        copy[index] = replaced.has(index) ? replaced.get(index) : source[index];
      }
      return copy;
    }
    const source = value as RecordLike;
    const copy = Object.create(Object.getPrototypeOf(source)) as RecordLike;
    for (const key of Object.keys(source)) {
      Object.defineProperty(copy, key, {
        value: replaced.has(key) ? replaced.get(key) : source[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
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
    // A host with no explicit restoration policy must never infer that a
    // token-bearing tool invocation is safe to execute.
    if (!hostToolPolicy) {
      const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
      const hasNearMiss = sessionID.length > 0 && inputHasNearMiss(sessionID, event.input, false);
      if (inputCarriesToken(event.input, new WeakSet()) || hasNearMiss) {
        throw new Error(TOOL_REFUSAL_ERROR);
      }
      return;
    }
    const codeMode = hostToolPolicy.isCodeModeCall(event);
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
    const shellTool = hostToolPolicy.isShellTool(rawTool);
    const rootPolicy: ToolLeafPolicy = shellTool ? "shell" : "verbatim";
    // P1 (2026-10-06b): only proven read-only tools without shell/code fields
    // may degrade to literal placeholders; everything else refuses the
    // affected invocation when restoration is incomplete.
    const allowDegraded = hostToolPolicy.allowsDegradedRestore(rawTool, event.input);
    const degraded = { count: 0 };
    if (typeof event.input === "string") {
      const descriptor = Object.getOwnPropertyDescriptor(event, "input");
      if (descriptor === undefined || !("value" in descriptor) || descriptor.writable !== true) {
        throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
      event.input = restoreLeaf(sessionID, event.input, rootPolicy, allowDegraded, degraded);
    } else {
      // The root is the one container that is never copied: it is the host's
      // own event object slot, so a frozen root stays refused.
      if (event.input !== null && typeof event.input === "object" && (types.isProxy(event.input) || Object.isFrozen(event.input))) {
        throw new Error(TOOL_INPUT_SHAPE_ERROR);
      }
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
    hasSession: (sessionID) => sessions.has(sessionID),
    assertTrackable,
    ensureSeeded,
    track,
    persistIfChanged,
    protectRequestKind,
    onHttpRequest,
    onHttpResponse,
    onToolBefore,
    releaseSession,
    noticeOnce,
    webSocket,
    assertWritableDataProperty,
    closeResources: () => {
      webSocket.dispose();
      store?.close();
      store = null;
    },
    dispose: () => {
      webSocket.dispose();
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

/**
 * Transport-boundary helpers for OpenCode v2 transparent pseudonymization
 * (issue #22; protocol selection is not provider-brand selection).
 *
 * Source-verified against the installed @opencode/plugin 2.0.19 declarations:
 * `session:http.request` / `session:http.response` expose native `Request` /
 * `Response` objects whose bodies are one-shot streams (clone before reading).
 * Supported wire protocols are the three custom-provider dialects — OpenAI
 * Chat Completions, Anthropic Messages and OpenAI Responses — selected by URL
 * path shape; each has JSON / event-stream response restore.
 *
 * Outbound enforcement and ingress restoration:
 * - Final-wire masking refuses unsupported routes, mixed dialects and
 *   bodyless requests. Explicit false admission may accept an unknown route
 *   with scoped host preparation proof; its opaque body is not inspected.
 *   A placeholder in transport metadata or the URL is judged
 *   session-aware instead: clean markers are preserved verbatim with a
 *   content-free WARN; sensitive content still refuses (unmaskable
 *   position).
 * - Transport metadata is inspected: decoded non-auth headers and query
 *   parameters, and numeric body values, must not scan as sensitive;
 *   legitimate authentication headers are preserved.
 * - The whole body is validated BEFORE any token is issued, then protected in
 *   ONE atomic transaction, so a rejected request commits no mapping or
 *   session capacity.
 * - Protocol metadata (model ids, tools, usage, numeric fields, envelopes) is
 *   never rewritten: structural identifiers (message ids, roles, part types,
 *   tool names and schema keys/enum constraints) are preserved and a
 *   sensitive one refuses the request rather than being silently renamed.
 * - Response restore touches assistant display text only: owned tokens are
 *   restored and unknown/malformed marker strings remain literal there. A
 *   placeholder in an unplaceable response field is degradation — kept
 *   literal with a WARN — never a refusal; actual tool arguments remain
 *   tokenized for the typed tool gate.
 * - Streaming is pull-based with bounded original-event transactions and
 *   channel state. SG parser/restore failures replay undelivered originals,
 *   then bypass rewriting; source errors and cancellation remain failures.
 *   Non-stream restoration failures are recovered by the session hook.
 */

import {
  containsTokenPrefix,
  PSEUDONYM_TOKEN_PREFIXES,
  type PseudonymJsonResult,
  type PseudonymTextResult,
} from "../decision/pseudonymization.js";
import { walkSchemaStrings } from "../decision/schema-strings.js";
import { createRecoveringSseStream } from "./sse-recovery.js";

/** The masking/detection subset of the pseudonymization core this module needs. */
export interface TransportMaskingService {
  protectJsonForModel(sessionID: string, value: unknown): PseudonymJsonResult;
  restoreText(sessionID: string, text: string): PseudonymTextResult;
  restoreTextForDisplay(sessionID: string, text: string): PseudonymTextResult;
  /** Non-committing sensitivity detection: no mapping, no mutation. */
  detectSensitive(text: string): boolean;
  /**
   * Session-aware judgement for structural positions (identifiers, transport
   * metadata): marker-shaped content is safe when clean (registered-marker
   * interiors exempt, unregistered payloads scanned); unsafe on a finding,
   * because the position cannot be masked without breaking the protocol.
   */
  isStructuralIdentifierSafe(sessionID: string, text: string): boolean;
  /**
   * Field-aware transport variants: identical to the strict checks except
   * that PII_URL findings are exempt. The request URL, query values, and
   * header values are infrastructure positions — masking or refusing an
   * endpoint URL would break every request once the opt-in URL rule is
   * enabled, so URL findings are ignored there. User-content URLs inside
   * the request body are unaffected (still masked).
   */
  transportDetectSensitive(text: string): boolean;
  /** Transport variant of {@link isStructuralIdentifierSafe} (PII_URL exempt). */
  isTransportIdentifierSafe(sessionID: string, text: string): boolean;
  /**
   * Attachment policy: "block" (default) refuses media/file parts at the
   * wire; "allow" tolerates them as opaque leaves that are substituted with a
   * sentinel around the masking transaction and restored verbatim after it,
   * so binary payloads are neither scanned nor altered.
   */
  readonly attachmentsPolicy?: "block" | "allow";
  /**
   * Anthropic extended-thinking history blocks. "refuse" (default) keeps the
   * original contract: any `thinking` / `redacted_thinking` block refuses the
   * request. "mask" accepts them: thinking text is masked like other text,
   * while `signature` and `redacted_thinking.data` cross verbatim as opaque
   * provider state (never scanned, never altered).
   */
  readonly anthropicThinking?: "refuse" | "mask";
}

// ─── Static failure messages (no content ever included) ─────────────────────

/**
 * Content-free degradation notice for the host log (P1, 2026-10-06b): one
 * WARN line with a fixed context word, never response/request content.
 */
const warnDegradation = (context: string): void => {
  console.warn(`[leakshield] degraded: ${context}`);
};

const UNSUPPORTED_REQUEST_BODY =
  "LeakShield blocked the request because its body is unsupported or could not be identified.";
const UNSUPPORTED_TRANSPORT =
  "LeakShield blocked a request on an unsupported route.";
const MASK_FAILURE =
  "LeakShield blocked the request because it could not be masked safely.";
const UNSUPPORTED_RESPONSE =
  "LeakShield blocked a response it could not restore safely.";
const RESTORE_FAILURE =
  "LeakShield blocked the response because it could not be restored safely.";
const MALFORMED_STREAM =
  "LeakShield blocked a malformed or incomplete stream.";
const STREAM_BUFFER_LIMIT =
  "LeakShield blocked an oversized stream buffer.";

/**
 * Content-free refusal classification (2026-10-08): every request refusal
 * appends a fixed code naming WHICH check failed — the refusal-policy spec
 * requires refusals to name the cause. Codes are static labels, never
 * request/response content, so the full message stays safe for host logs
 * and user-facing errors. Existing substring assertions keep passing: the
 * base sentence is unchanged and the code is appended in brackets.
 */
function refusal(code: string): string {
  return `${UNSUPPORTED_REQUEST_BODY} [${code}]`;
}


/**
 * All byte caps are UTF-8 bytes (not UTF-16 code units): the bound is a memory
 * bound, and a code-unit cap would allow up to ~4× the stated bytes for
 * multi-byte text. Each cap is charged BEFORE the value is accumulated.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// SSE framing and original-event retention caps live in the shared recovery
// stream; protocol adapters only own their bounded text/channel state.
/** A single choice's held-back content channel. */
const MAX_CHANNEL_BYTES = 65_536;
/** The aggregate held-back content across all channels. */
const MAX_TOTAL_CHANNEL_BYTES = 1_048_576;
/** Bound on the number of concurrently-held choice channels. */
const MAX_CHANNELS = 256;

/** Headers that legitimately carry credentials; never scanned as content. */
const AUTH_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-goog-api-key",
]);

// ─── Shared helpers ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The OpenAI-compatible chat-completions endpoint for this request, if any. */
function isChatCompletionsUrl(url: string): boolean {
  try {
    return /\/chat\/completions\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The Anthropic Messages endpoint for this request, if any. */
function isAnthropicMessagesUrl(url: string): boolean {
  try {
    return /\/messages\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The OpenAI Responses endpoint for this request, if any. */
function isResponsesUrl(url: string): boolean {
  try {
    return /\/responses\/?$/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Wire routes this module can protect, detected by URL PATH SHAPE — never by
 * provider or model name, so any endpoint speaking a supported dialect
 * (OpenAI-compatible gateways, Anthropic-native, …) is covered uniformly. */
export type ModelWireRoute = "chat-completions" | "anthropic-messages" | "openai-responses";

export function classifyModelRoute(url: string): ModelWireRoute | null {
  try {
    const pathname = new URL(url).pathname;
    if (/\/chat\/completions\/?$/.test(pathname)) return "chat-completions";
    if (/\/messages\/?$/.test(pathname)) return "anthropic-messages";
    if (/\/responses\/?$/.test(pathname)) return "openai-responses";
    return null;
  } catch {
    return null;
  }
}

/** Whether a URL carries a reserved token, raw or percent-encoded. */
function urlCarriesToken(url: string): boolean {
  if (containsTokenPrefix(url)) return true;
  try {
    return containsTokenPrefix(decodeURIComponent(url));
  } catch {
    return false; // malformed escapes: the raw check already covered them
  }
}

/**
 * Reads a clone of `source` into a string, refusing (with `failure`) once the
 * decoded content exceeds `limit` UTF-8 bytes or on any read error. The limit
 * is charged before each decoded chunk is accumulated. The original
 * request/response body is never consumed.
 */
async function readCappedText(
  source: { clone(): { body: ReadableStream<Uint8Array> | null } },
  limit: number,
  failure: string,
): Promise<string> {
  const clone = source.clone();
  if (clone.body === null) return "";
  const reader = clone.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let outBytes = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new Error(failure);
    }
    if (step.done) break;
    const decoded = decoder.decode(step.value, { stream: true });
    outBytes += byteLength(decoded);
    if (outBytes > limit) {
      // Do not await cancellation here: cancelling a cloned body reader can
      // block, and the static failure is the outcome either way.
      void reader.cancel().catch(() => {});
      throw new Error(failure);
    }
    out += decoded;
  }
  const tail = decoder.decode();
  outBytes += byteLength(tail);
  if (outBytes > limit) throw new Error(failure);
  return out + tail;
}

/** Visits every numeric value in a strict-JSON tree. */
function walkNumbers(value: unknown, visit: (value: number) => void): void {
  if (typeof value === "number") {
    visit(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkNumbers(item, visit);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) walkNumbers(item, visit);
}

type PathSegment = string | number;

function isIntentionalToolArgumentsPath(path: readonly PathSegment[]): boolean {
  if (path[path.length - 1] !== "arguments") return false;
  const modern =
    path.length === 7 &&
    path[0] === "choices" &&
    typeof path[1] === "number" &&
    (path[2] === "message" || path[2] === "delta") &&
    path[3] === "tool_calls" &&
    typeof path[4] === "number" &&
    path[5] === "function";
  const legacy =
    path.length === 5 &&
    path[0] === "choices" &&
    typeof path[1] === "number" &&
    (path[2] === "message" || path[2] === "delta") &&
    path[3] === "function_call";
  return modern || legacy;
}

function isAssistantDisplayPath(path: readonly PathSegment[]): boolean {
  const messageContent =
    path.length === 4 &&
    path[0] === "choices" &&
    typeof path[1] === "number" &&
    path[2] === "message" &&
    path[3] === "content";
  const messageTextPart =
    path.length === 6 &&
    path[0] === "choices" &&
    typeof path[1] === "number" &&
    path[2] === "message" &&
    path[3] === "content" &&
    typeof path[4] === "number" &&
    path[5] === "text";
  const deltaContent =
    path.length === 4 &&
    path[0] === "choices" &&
    typeof path[1] === "number" &&
    path[2] === "delta" &&
    path[3] === "content";
  return messageContent || messageTextPart || deltaContent;
}

function strayTokenIn(value: unknown, path: readonly PathSegment[] = []): boolean {
  if (typeof value === "string") {
    return (
      containsTokenPrefix(value) &&
      !isIntentionalToolArgumentsPath(path) &&
      !isAssistantDisplayPath(path)
    );
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item, index) => strayTokenIn(item, [...path, index]));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (containsTokenPrefix(key) || strayTokenIn(record[key], [...path, key])) return true;
  }
  return false;
}

// ─── Transport metadata inspection ──────────────────────────────────────────

/**
 * Inspects decoded transport metadata. P1 (2026-10-06b): a placeholder in a
 * header or query parameter is no longer refused per se — it is judged
 * session-aware (registered-marker interiors exempt, unregistered payloads
 * scanned); clean markers are preserved verbatim with a content-free WARN.
 * A sensitive hit still refuses: transport metadata cannot be masked or
 * renamed without breaking the protocol. Legitimate authentication headers
 * are excluded from content scanning.
 */
function inspectTransportMetadata(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
): void {
  const url = new URL(request.url);
  for (const [name, value] of url.searchParams) {
    if (containsTokenPrefix(name) || containsTokenPrefix(value)) {
      if (
        !service.isStructuralIdentifierSafe(sessionID, name) ||
        !service.isTransportIdentifierSafe(sessionID, value)
      ) {
        throw new Error(refusal("metadata-query-token"));
      }
      warnDegradation("transport metadata preserved with a literal placeholder");
      continue;
    }
    if (service.detectSensitive(name) || service.transportDetectSensitive(value)) {
      throw new Error(refusal("metadata-query-sensitive"));
    }
  }
  for (const [name, value] of request.headers) {
    if (containsTokenPrefix(value)) {
      if (!service.isTransportIdentifierSafe(sessionID, value)) {
        throw new Error(refusal("metadata-header-token"));
      }
      warnDegradation("transport metadata preserved with a literal placeholder");
      continue;
    }
    if (AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (service.detectSensitive(name) || service.transportDetectSensitive(value)) {
      throw new Error(refusal("metadata-header-sensitive"));
    }
  }
}

// ─── Attachment pass-through (allow policy) ─────────────────────────────────

const OPAQUE_ATTACHMENT_SENTINEL = "__sg_opaque_attachment";

/**
 * Internal + wire-serialized attachment part types. Beyond the host's own
 * media/file records this includes what the provider serializers actually
 * emit on the wire: image_url (Chat Completions), image (Anthropic
 * Messages), input_image/input_file (Responses). Under the "allow" policy
 * every one of these passes as an opaque, unscanned leaf in all dialects.
 */
const ATTACHMENT_PART_TYPES = new Set([
  "media",
  "file",
  "image_url",
  "image",
  "input_image",
  "input_file",
]);

function isAttachmentRecord(item: unknown): item is Record<string, unknown> {
  return isRecord(item) && typeof item.type === "string" && ATTACHMENT_PART_TYPES.has(item.type);
}

/**
 * In "allow" mode, temporarily substitutes every media/file record with a
 * unique sentinel string around the masking transaction, then restores the
 * originals into the protected result: binary payloads are neither scanned
 * nor altered, and the structural checks outside this wrapper see identical
 * attachment records before and after. Shared by the wire remaskers and the
 * session-layer request guard so "allow means unscanned" holds at both
 * boundaries.
 */
export function withOpaqueAttachments<T extends Record<string, unknown>>(
  policy: "block" | "allow",
  body: T,
  fn: (input: T) => T,
): T {
  if (policy !== "allow") return fn(body);
  const originals: Array<Record<string, unknown>> = [];
  let counter = 0;
  const substitute = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index];
        if (isAttachmentRecord(item)) {
          originals.push(item);
          value[index] = `${OPAQUE_ATTACHMENT_SENTINEL}_${counter++}`;
        } else substitute(item);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (isAttachmentRecord(item)) {
        originals.push(item);
        record[key] = `${OPAQUE_ATTACHMENT_SENTINEL}_${counter++}`;
      } else substitute(item);
    }
  };
  substitute(body);
  const result = fn(body);
  const sentinelRe = new RegExp(`^${OPAQUE_ATTACHMENT_SENTINEL}_\\d+$`);
  let restoreIndex = 0;
  const restore = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const item = value[index];
        if (typeof item === "string" && sentinelRe.test(item)) {
          if (restoreIndex >= originals.length) throw new Error(MASK_FAILURE);
          value[index] = originals[restoreIndex++];
        } else restore(item);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const item = record[key];
      if (typeof item === "string" && sentinelRe.test(item)) {
        if (restoreIndex >= originals.length) throw new Error(MASK_FAILURE);
        record[key] = originals[restoreIndex++];
      } else restore(item);
    }
  };
  restore(result);
  if (restoreIndex !== originals.length) throw new Error(MASK_FAILURE);
  return result;
}

/** True when the policy tolerates media/file parts as opaque leaves. */
function attachmentsAllowed(service: TransportMaskingService): boolean {
  return service.attachmentsPolicy === "allow";
}

const OPAQUE_REASONING_SENTINEL = "__sg_opaque_reasoning";

/**
 * Stashes every reasoning item's `encrypted_content` string around the
 * masking transaction: the payload is provider-opaque, so it is neither
 * scanned nor masked — a false-positive detector hit (an `sk-` substring
 * inside base64, say) would corrupt the blob and break the protocol — and
 * it crosses the boundary verbatim while the same item's plaintext
 * summary/content parts are masked normally. Same sentinel contract as
 * withOpaqueAttachments: substitute, protect, restore, verify counts.
 */
function withOpaqueReasoningContent(
  body: Record<string, unknown>,
  fn: (input: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) return fn(body);
  const originals: string[] = [];
  for (const item of input) {
    if (
      isRecord(item) &&
      (item.type === "reasoning" || item.type === "compaction") &&
      typeof item.encrypted_content === "string"
    ) {
      originals.push(item.encrypted_content);
      item.encrypted_content = `${OPAQUE_REASONING_SENTINEL}_${originals.length - 1}`;
    }
  }
  if (originals.length === 0) return fn(body);
  const result = fn(body);
  const sentinelRe = new RegExp(`^${OPAQUE_REASONING_SENTINEL}_\\d+$`);
  const resultInput = (result as Record<string, unknown>).input;
  if (!Array.isArray(resultInput)) throw new Error(MASK_FAILURE);
  let index = 0;
  for (const item of resultInput) {
    if (
      isRecord(item) &&
      typeof item.encrypted_content === "string" &&
      sentinelRe.test(item.encrypted_content)
    ) {
      if (index >= originals.length) throw new Error(MASK_FAILURE);
      item.encrypted_content = originals[index++];
    }
  }
  if (index !== originals.length) throw new Error(MASK_FAILURE);
  return result;
}

// ─── Request validation (runs before any issuance) ──────────────────────────

function validateDialect(body: Record<string, unknown>): void {
  // An Anthropic-shaped /v1/messages body carries a top-level system prompt
  // and input_schema tools this OpenAI-specific masker cannot place.
  if (body.system !== undefined) throw new Error(refusal("chatcompletions-system-field"));
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(refusal("chatcompletions-tools-shape"));
    for (const tool of body.tools) {
      if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") {
        throw new Error(refusal("chatcompletions-tool-shape"));
      }
    }
  }
}

function validateMessages(body: Record<string, unknown>, allowAttachments: boolean): void {
  if (!Array.isArray(body.messages)) throw new Error(refusal("chatcompletions-messages-shape"));
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error(refusal("chatcompletions-message-shape"));
    }
    const content = message.content;
    if (content !== undefined && content !== null && typeof content !== "string") {
      if (!Array.isArray(content)) throw new Error(refusal("chatcompletions-content-shape"));
      for (const part of content) {
        // Attachments and foreign part types must refuse, never pass tokenized
        // or unscanned content through the wire boundary — unless the user
        // explicitly chose the "allow" policy (visible, unscanned pass-through).
        if (allowAttachments && isAttachmentRecord(part)) {
          continue;
        }
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
          throw new Error(refusal("chatcompletions-content-part"));
        }
      }
    }
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && toolCalls !== null) {
      if (!Array.isArray(toolCalls)) throw new Error(refusal("chatcompletions-tool-calls-shape"));
      for (const call of toolCalls) {
        if (
          !isRecord(call) ||
          !isRecord(call.function) ||
          typeof call.function.name !== "string" ||
          typeof call.function.arguments !== "string"
        ) {
          throw new Error(refusal("chatcompletions-tool-call-shape"));
        }
        try {
          JSON.parse(call.function.arguments);
        } catch {
          throw new Error(refusal("chatcompletions-tool-call-arguments"));
        }
      }
    }
    const functionCall = message.function_call;
    if (functionCall !== undefined && functionCall !== null) {
      if (!isRecord(functionCall) || typeof functionCall.name !== "string" || typeof functionCall.arguments !== "string") {
        throw new Error(refusal("chatcompletions-function-call-shape"));
      }
      try {
        JSON.parse(functionCall.arguments);
      } catch {
        throw new Error(refusal("chatcompletions-function-call-arguments"));
      }
    }
  }
}

// ─── Structural identifiers ─────────────────────────────────────────────────

/** True for any string value positioned as a structural (never-renamed) id. */
function pushString(out: string[], value: unknown): void {
  if (typeof value === "string") out.push(value);
}

/** Keys and values of a schema/metadata subtree, in stable walk order. */
function walkStrings(out: string[], value: unknown): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(out, item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    out.push(key);
    walkStrings(out, record[key]);
  }
}

/**
 * Protocol/structural identifiers of a Chat Completions body: model id,
 * message roles/ids, content part types, tool-call ids/names and the tool
 * input schema identifiers (property names, types, required entries, enum
 * values). These must survive masking verbatim; a sensitive or token-bearing
 * one refuses the request rather than being silently renamed. Schema
 * annotation prose (description/title values) is intentionally absent: it is
 * masked as ordinary content instead of refusing.
 */
function collectWireStructuralStrings(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  pushString(out, body.model);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      pushString(out, message.role);
      pushString(out, message.id);
      pushString(out, message.tool_call_id);
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (isRecord(part)) pushString(out, part.type);
        }
      }
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!isRecord(call)) continue;
          pushString(out, call.id);
          pushString(out, call.type);
          if (isRecord(call.function)) pushString(out, call.function.name);
        }
      }
      if (isRecord(message.function_call)) pushString(out, message.function_call.name);
    }
  }
  for (const tools of [body.tools, body.functions]) {
    if (!Array.isArray(tools)) continue;
    for (const tool of tools) {
      if (!isRecord(tool)) continue;
      pushString(out, tool.type);
      pushString(out, tool.name);
      const fn = isRecord(tool.function) ? tool.function : tool;
      pushString(out, fn.name);
      // Annotation prose (description/title values) masks as content; only
      // identifiers stay structural and can refuse the request.
      if (fn.parameters !== undefined) walkSchemaStrings(out, fn.parameters);
    }
  }
  if (body.tool_choice !== undefined) walkStrings(out, body.tool_choice);
  if (body.response_format !== undefined) walkSchemaStrings(out, body.response_format);
  return out;
}

/**
 * Remasks an OpenAI-compatible Chat Completions JSON request body.
 *
 * Every check that can reject runs FIRST (route, transport metadata, dialect,
 * message shapes, structural identifiers, numeric values); only then is the
 * whole body protected in a SINGLE transaction, so a rejected request commits
 * no mapping or session capacity. The original request is consumed only through
 * `clone()` and, when nothing changed, the ORIGINAL request object is returned
 * untouched. A rebuilt request inherits every transport control (method, url,
 * mode, credentials, cache, redirect, referrer, integrity, keepalive, signal,
 * authentication headers) and recomputes body headers.
 */
export async function remaskChatCompletionsRequest(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
): Promise<Request> {
  if (!isChatCompletionsUrl(request.url)) throw new Error(UNSUPPORTED_TRANSPORT);
  if (urlCarriesToken(request.url)) {
    // P1 (2026-10-06b): a placeholder in the URL is judged, not auto-refused;
    // sensitive content in a URL cannot be masked without changing the target.
    if (!service.isTransportIdentifierSafe(sessionID, request.url)) {
      throw new Error(refusal("url-token"));
    }
    warnDegradation("request url preserved with a literal placeholder");
  }
  inspectTransportMetadata(service, sessionID, request);
  // A body is required: transport metadata (query, headers) cannot be scanned
  // for arbitrary content, so a bodyless request has no verifiable boundary.
  if (request.body === null) throw new Error(refusal("body-missing"));

  const raw = await readCappedText(request, MAX_BODY_BYTES, refusal("body-cap"));
  if (raw.length === 0) throw new Error(refusal("body-empty"));

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(refusal("body-json"));
  }
  if (!isRecord(body)) throw new Error(refusal("body-shape"));

  validateDialect(body);
  validateMessages(body, attachmentsAllowed(service));

  // Capture the original wire shape BEFORE transforming tool arguments, so a
  // no-op protection still returns the ORIGINAL request untouched.
  const originalSerialized = JSON.stringify(body);

  // Tool arguments are JSON-encoded strings. Protecting them as PARSED values
  // (a) keeps masking from invalidating the JSON — a numeric pin matched by the
  // phone detector would otherwise be masked mid-token, producing invalid JSON
  // and a post-commit rejection that still consumes capacity — and (b) lets
  // structural/numeric policy see inside them, all BEFORE the one atomic
  // commit. Every transformed argument is re-encoded afterwards; a parsed JSON
  // *string* must also be re-encoded (it would otherwise be written as a bare
  // string and become invalid JSON on the wire).
  const transformedArguments: Array<{ message: number; call?: number }> = [];
  const messages = body.messages as unknown[];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!isRecord(message)) continue;
    if (Array.isArray(message.tool_calls)) {
      for (let callIndex = 0; callIndex < message.tool_calls.length; callIndex++) {
        const call = message.tool_calls[callIndex];
        if (!isRecord(call) || !isRecord(call.function)) continue;
        try {
          call.function.arguments = JSON.parse(call.function.arguments as string);
        } catch {
          throw new Error(refusal("chatcompletions-tool-call-arguments"));
        }
        transformedArguments.push({ message: messageIndex, call: callIndex });
      }
    }
    if (isRecord(message.function_call)) {
      try {
        message.function_call.arguments = JSON.parse(message.function_call.arguments as string);
      } catch {
        throw new Error(refusal("chatcompletions-function-call-arguments"));
      }
      transformedArguments.push({ message: messageIndex });
    }
  }

  // Structural identifiers and numeric values (now including values inside
  // tool arguments) must be safe BEFORE masking, so no mapping is committed for
  // content we are about to refuse.
  const structuralBefore = collectWireStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (containsTokenPrefix(identifier) || service.detectSensitive(identifier)) {
      throw new Error(refusal("structural-identifier"));
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(refusal("number-sensitive"));

  // Atomic protection: one transaction over the whole body.
  const next = withOpaqueAttachments(service.attachmentsPolicy ?? "block", body, (input) => {
    const masked = service.protectJsonForModel(sessionID, input);
    if (!masked.ok) throw new Error(MASK_FAILURE);
    const value = masked.value;
    if (!isRecord(value)) throw new Error(MASK_FAILURE);
    return value as Record<string, unknown>;
  });

  // Defense in depth: no structural identifier may have changed.
  const structuralAfter = collectWireStructuralStrings(next);
  if (
    structuralAfter.length !== structuralBefore.length ||
    structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
  ) {
    throw new Error(refusal("structural-drift"));
  }

  // Re-serialize every transformed argument: a parsed value re-encodes as
  // valid JSON by construction, so masking can no longer break them.
  if (Array.isArray(next.messages)) {
    for (const { message: messageIndex, call: callIndex } of transformedArguments) {
      const message = next.messages[messageIndex];
      if (!isRecord(message)) throw new Error(MASK_FAILURE);
      if (callIndex === undefined) {
        if (!isRecord(message.function_call)) throw new Error(MASK_FAILURE);
        message.function_call.arguments = JSON.stringify(message.function_call.arguments);
      } else {
        if (!Array.isArray(message.tool_calls)) throw new Error(MASK_FAILURE);
        const call = message.tool_calls[callIndex];
        if (!isRecord(call) || !isRecord(call.function)) throw new Error(MASK_FAILURE);
        call.function.arguments = JSON.stringify(call.function.arguments);
      }
    }
  }

  const serialized = JSON.stringify(next);
  if (serialized === originalSerialized) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(serialized)));
  return new Request(request, { body: serialized, headers });
}

// ─── Anthropic Messages request (wire dialect) ──────────────────────────────

/**
 * Validates an Anthropic Messages request body: top-level `system` (string or
 * text blocks), `messages` with content blocks (text | tool_use |
 * tool_result), flat `tools` ({name, description?, input_schema}). Images,
 * documents, thinking blocks (unless the service sets anthropicThinking
 * "mask"), and any unknown block type refuse — never pass
 * tokenized or unscanned content through the wire boundary.
 */
function validateAnthropicSystem(system: unknown): void {
  if (system === undefined || system === null || typeof system === "string") return;
  if (!Array.isArray(system)) throw new Error(refusal("anthropic-system-shape"));
  for (const block of system) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error(refusal("anthropic-system-block"));
    }
  }
}

function validateAnthropicContent(content: unknown, allowAttachments: boolean, allowThinking = false): void {
  if (content === undefined || content === null || typeof content === "string") return;
  if (!Array.isArray(content)) throw new Error(refusal("anthropic-content-shape"));
  for (const block of content) {
    if (!isRecord(block)) throw new Error(refusal("anthropic-content-block"));
    if (allowAttachments && isAttachmentRecord(block)) continue;
    if (allowThinking && block.type === "thinking") {
      if (typeof block.thinking !== "string" || (block.signature !== undefined && typeof block.signature !== "string")) {
        throw new Error(refusal("anthropic-thinking-block"));
      }
      continue;
    }
    if (allowThinking && block.type === "redacted_thinking") {
      if (typeof block.data !== "string") throw new Error(refusal("anthropic-thinking-block"));
      continue;
    }
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") throw new Error(refusal("anthropic-text-block"));
        break;
      case "tool_use":
        if (
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !isRecord(block.input)
        ) {
          throw new Error(refusal("anthropic-tool-use-block"));
        }
        break;
      case "tool_result": {
        if (typeof block.tool_use_id !== "string") throw new Error(refusal("anthropic-tool-result-block"));
        const inner = block.content;
        if (inner === undefined || inner === null || typeof inner === "string") break;
        if (!Array.isArray(inner)) throw new Error(refusal("anthropic-tool-result-content"));
        for (const part of inner) {
          // Images/documents inside tool results refuse like top-level ones,
          // unless the user explicitly chose the "allow" policy.
          if (allowAttachments && isAttachmentRecord(part)) {
            continue;
          }
          if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
            throw new Error(refusal("anthropic-tool-result-part"));
          }
        }
        break;
      }
      default:
        throw new Error(refusal("anthropic-content-block-type"));
    }
  }
}

function validateAnthropicDialect(body: Record<string, unknown>, allowAttachments: boolean, allowThinking = false): void {
  validateAnthropicSystem(body.system);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(refusal("anthropic-tools-shape"));
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") throw new Error(refusal("anthropic-tool-shape"));
      if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
        throw new Error(refusal("anthropic-tool-schema"));
      }
    }
  }
  if (!Array.isArray(body.messages)) throw new Error(refusal("anthropic-messages-shape"));
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error(refusal("anthropic-message-shape"));
    }
    validateAnthropicContent(message.content, allowAttachments, allowThinking);
  }
}

const OPAQUE_THINKING_SENTINEL = "__sg_opaque_thinking";

/**
 * Stashes thinking `signature` and `redacted_thinking.data` strings around the
 * masking transaction. Both are provider-verified blobs over earlier masked
 * traffic: a false-positive detector hit inside the base64 would corrupt them
 * and the provider would reject the whole history. Same sentinel contract as
 * withOpaqueReasoningContent: substitute, protect, restore, verify counts.
 */
function withOpaqueThinkingState(
  body: Record<string, unknown>,
  fn: (input: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const opaqueField = (block: Record<string, unknown>): "signature" | "data" | null => {
    if (block.type === "thinking" && typeof block.signature === "string") return "signature";
    if (block.type === "redacted_thinking" && typeof block.data === "string") return "data";
    return null;
  };
  const blocksOf = (value: Record<string, unknown>): Record<string, unknown>[] => {
    if (!Array.isArray(value.messages)) return [];
    return value.messages.flatMap((message) =>
      isRecord(message) && Array.isArray(message.content) ? message.content.filter(isRecord) : [],
    );
  };
  const originals: string[] = [];
  for (const block of blocksOf(body)) {
    const field = opaqueField(block);
    if (field === null) continue;
    originals.push(block[field] as string);
    block[field] = `${OPAQUE_THINKING_SENTINEL}_${originals.length - 1}`;
  }
  if (originals.length === 0) return fn(body);
  const result = fn(body);
  const sentinelRe = new RegExp(`^${OPAQUE_THINKING_SENTINEL}_(\\d+)$`);
  let restored = 0;
  for (const block of blocksOf(result)) {
    const field = opaqueField(block);
    if (field === null) continue;
    const match = sentinelRe.exec(block[field] as string);
    if (match === null || Number(match[1]) !== restored) throw new Error(MASK_FAILURE);
    block[field] = originals[restored++];
  }
  if (restored !== originals.length) throw new Error(MASK_FAILURE);
  return result;
}

/** Structural identifiers that must survive masking verbatim (Anthropic shape). */
function collectAnthropicStructuralStrings(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  pushString(out, body.model);
  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!isRecord(message)) continue;
      pushString(out, message.role);
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isRecord(block)) continue;
          pushString(out, block.type);
          if (block.type === "tool_use") {
            pushString(out, block.id);
            pushString(out, block.name);
          }
          if (block.type === "tool_result") pushString(out, block.tool_use_id);
        }
      }
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isRecord(tool)) pushString(out, tool.name);
    }
  }
  if (Array.isArray(body.stop_sequences)) {
    for (const stop of body.stop_sequences) pushString(out, stop);
  }
  return out;
}

/**
 * Remasks an Anthropic Messages JSON request body. Same contract as the
 * chat-completions path: every check that can reject runs FIRST, then the
 * whole body is protected in ONE transaction; a rejected request commits no
 * mapping or session capacity. tool_use.input is already a JSON object (no
 * string re-encoding needed) and stays tokenized on the wire; the typed tool
 * gate restores before execution.
 */
export async function remaskAnthropicMessagesRequest(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
): Promise<Request> {
  if (!isAnthropicMessagesUrl(request.url)) throw new Error(UNSUPPORTED_TRANSPORT);
  if (urlCarriesToken(request.url)) {
    // P1 (2026-10-06b): a placeholder in the URL is judged, not auto-refused;
    // sensitive content in a URL cannot be masked without changing the target.
    if (!service.isTransportIdentifierSafe(sessionID, request.url)) {
      throw new Error(refusal("url-token"));
    }
    warnDegradation("request url preserved with a literal placeholder");
  }
  inspectTransportMetadata(service, sessionID, request);
  if (request.body === null) throw new Error(refusal("body-missing"));

  const raw = await readCappedText(request, MAX_BODY_BYTES, refusal("body-cap"));
  if (raw.length === 0) throw new Error(refusal("body-empty"));

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(refusal("body-json"));
  }
  if (!isRecord(body)) throw new Error(refusal("body-shape"));

  const allowThinking = service.anthropicThinking === "mask";
  validateAnthropicDialect(body, attachmentsAllowed(service), allowThinking);

  const originalSerialized = JSON.stringify(body);

  const structuralBefore = collectAnthropicStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (containsTokenPrefix(identifier) || service.detectSensitive(identifier)) {
      throw new Error(refusal("structural-identifier"));
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(refusal("number-sensitive"));

  const protect = (input: Record<string, unknown>): Record<string, unknown> => {
    const masked = service.protectJsonForModel(sessionID, input);
    if (!masked.ok) throw new Error(MASK_FAILURE);
    const value = masked.value;
    if (!isRecord(value)) throw new Error(MASK_FAILURE);
    return value as Record<string, unknown>;
  };
  const next = withOpaqueAttachments(service.attachmentsPolicy ?? "block", body, (input) =>
    allowThinking ? withOpaqueThinkingState(input, protect) : protect(input),
  );

  const structuralAfter = collectAnthropicStructuralStrings(next);
  if (
    structuralAfter.length !== structuralBefore.length ||
    structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
  ) {
    throw new Error(refusal("structural-drift"));
  }

  const serialized = JSON.stringify(next);
  if (serialized === originalSerialized) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(serialized)));
  return new Request(request, { body: serialized, headers });
}

// ─── OpenAI Responses request (wire dialect) ────────────────────────────────

/**
 * Validates an OpenAI Responses request body: `instructions` string, `input`
 * (string or item array: message | function_call | function_call_output |
 * custom_tool_call | custom_tool_call_output | reasoning | compaction |
 * configuration_update), flat `tools` ({type:"function", name, parameters}).
 * Reasoning and compaction items pass with their encrypted payload opaque
 * (unscanned, verbatim); reasoning summary/content text is masked; item
 * references and unknown types refuse.
 */
function validateResponsesContentParts(content: unknown, allowAttachments: boolean): void {
  if (content === undefined || content === null || typeof content === "string") return;
  if (!Array.isArray(content)) throw new Error(refusal("responses-content-shape"));
  for (const part of content) {
    if (allowAttachments && isAttachmentRecord(part)) {
      continue;
    }
    if (
      !isRecord(part) ||
      (part.type !== "input_text" && part.type !== "output_text") ||
      typeof part.text !== "string"
    ) {
      throw new Error(refusal("responses-content-part"));
    }
  }
}

/** Text-part kinds the restore side recognizes on reasoning items. */
const REASONING_TEXT_PART_TYPES = new Set(["summary_text", "reasoning_text"]);

function validateResponsesReasoningParts(parts: unknown): void {
  if (parts === undefined || parts === null) return;
  if (!Array.isArray(parts)) throw new Error(refusal("responses-reasoning-shape"));
  for (const part of parts) {
    if (
      !isRecord(part) ||
      typeof part.type !== "string" ||
      !REASONING_TEXT_PART_TYPES.has(part.type) ||
      typeof part.text !== "string"
    ) {
      throw new Error(refusal("responses-reasoning-shape"));
    }
  }
}

function validateResponsesInputItem(item: unknown, allowAttachments: boolean): void {
  if (typeof item === "string") return;
  if (!isRecord(item)) throw new Error(refusal("responses-input-item"));
  // Responses EasyInputMessage permits omitted type. AI SDK's Responses
  // lowering emits this form for system/developer/user/assistant messages.
  // Do not normalize the wire body or infer arbitrary type-less records:
  // require a recognized role plus actual supported content before masking.
  if (item.type === undefined && typeof item.role === "string" && ["system", "developer", "user", "assistant"].includes(item.role)) {
    if (item.content === undefined || item.content === null) throw new Error(refusal("responses-content-shape"));
    validateResponsesContentParts(item.content, allowAttachments);
    return;
  }
  switch (item.type) {
    case "message":
      if (typeof item.role !== "string") throw new Error(refusal("responses-message-role"));
      validateResponsesContentParts(item.content, allowAttachments);
      return;
    case "function_call":
      if (typeof item.name !== "string" || typeof item.arguments !== "string") {
        throw new Error(refusal("responses-function-call-shape"));
      }
      return;
    case "custom_tool_call":
      if (typeof item.name !== "string" || typeof item.input !== "string") {
        throw new Error(refusal("responses-custom-tool-call-shape"));
      }
      return;
    case "function_call_output":
    case "custom_tool_call_output":
      if (typeof item.output !== "string") {
        if (!Array.isArray(item.output)) throw new Error(refusal("responses-function-output"));
        validateResponsesContentParts(item.output, allowAttachments);
      }
      return;
    case "reasoning": {
      // Encrypted reasoning payloads are provider-opaque: they cannot be
      // scanned, and masking them is impossible without corrupting the blob
      // (a false-positive finding — e.g. an `sk-` substring inside base64 —
      // would break the protocol). They are derived from earlier masked
      // traffic and return to the same provider, disclosing nothing new.
      // The plaintext channels (summary / content parts) are masked like
      // ordinary text; the id survives verbatim as a structural identifier.
      if (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string") {
        throw new Error(refusal("responses-reasoning-shape"));
      }
      validateResponsesReasoningParts(item.summary);
      validateResponsesReasoningParts(item.content);
      return;
    }
    case "compaction":
      // Same opacity argument as reasoning.encrypted_content: a provider
      // checkpoint of already-masked history, replayed to the same provider.
      if (
        typeof item.encrypted_content !== "string" ||
        (item.id !== undefined && item.id !== null && typeof item.id !== "string")
      ) {
        throw new Error(refusal("responses-compaction-shape"));
      }
      return;
    case "configuration_update":
      if (!isRecord(item.reasoning) || typeof item.reasoning.effort !== "string") {
        throw new Error(refusal("responses-configuration-update-shape"));
      }
      return;
    default:
      // item_reference / unknown: cannot verify or place.
      throw new Error(refusal("responses-item-type"));
  }
}

function validateResponsesDialect(body: Record<string, unknown>, allowAttachments: boolean): void {
  // A chat-completions/anthropic-shaped body on a /responses route is a
  // mixed dialect this masker cannot place; refuse it explicitly.
  if (body.messages !== undefined || body.system !== undefined) {
    throw new Error(refusal("responses-mixed-dialect"));
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new Error(refusal("responses-instructions"));
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(refusal("responses-tools-shape"));
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") throw new Error(refusal("responses-tool-shape"));
      if (tool.parameters !== undefined && !isRecord(tool.parameters)) {
        throw new Error(refusal("responses-tool-schema"));
      }
    }
  }
  if (body.input !== undefined) {
    if (typeof body.input !== "string") {
      if (!Array.isArray(body.input)) throw new Error(refusal("responses-input-shape"));
      for (const item of body.input) validateResponsesInputItem(item, allowAttachments);
    }
  }
}

/** Structural identifiers that must survive masking verbatim (Responses shape). */
function collectResponsesStructuralStrings(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  pushString(out, body.model);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!isRecord(item)) continue;
      pushString(out, item.type);
      pushString(out, item.role);
      pushString(out, item.call_id);
      if (item.type === "function_call" || item.type === "custom_tool_call") pushString(out, item.name);
      if (item.type === "function_call") pushString(out, item.namespace);
      if (item.type === "reasoning" || item.type === "compaction") pushString(out, item.id);
      if (item.type === "configuration_update" && isRecord(item.reasoning)) pushString(out, item.reasoning.effort);
    }
  }
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (isRecord(tool)) pushString(out, tool.name);
    }
  }
  return out;
}

/**
 * Remasks an OpenAI Responses JSON request body. Same contract as the other
 * dialects: reject-first validation, ONE atomic transaction, structural
 * identifiers preserved. function_call.arguments is a JSON-encoded string and
 * is parsed before masking and re-encoded after (same rule as chat
 * completions tool arguments).
 */
export async function remaskResponsesRequest(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
): Promise<Request> {
  if (!isResponsesUrl(request.url)) throw new Error(UNSUPPORTED_TRANSPORT);
  if (urlCarriesToken(request.url)) {
    // P1 (2026-10-06b): a placeholder in the URL is judged, not auto-refused;
    // sensitive content in a URL cannot be masked without changing the target.
    if (!service.isTransportIdentifierSafe(sessionID, request.url)) {
      throw new Error(refusal("url-token"));
    }
    warnDegradation("request url preserved with a literal placeholder");
  }
  inspectTransportMetadata(service, sessionID, request);
  if (request.body === null) throw new Error(refusal("body-missing"));

  const raw = await readCappedText(request, MAX_BODY_BYTES, refusal("body-cap"));
  if (raw.length === 0) throw new Error(refusal("body-empty"));

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(refusal("body-json"));
  }
  if (!isRecord(body)) throw new Error(refusal("body-shape"));

  validateResponsesDialect(body, attachmentsAllowed(service));

  const originalSerialized = JSON.stringify(body);

  // function_call.arguments strings are parsed so masking cannot invalidate
  // the JSON; re-encoded after the atomic protect (chat-completions rule).
  const transformedArguments: number[] = [];
  if (Array.isArray(body.input)) {
    for (let index = 0; index < body.input.length; index++) {
      const item = body.input[index];
      if (isRecord(item) && item.type === "function_call" && isRecordArgumentsString(item)) {
        try {
          item.arguments = JSON.parse(item.arguments as string);
        } catch {
          throw new Error(refusal("responses-function-call-arguments"));
        }
        transformedArguments.push(index);
      }
    }
  }

  const structuralBefore = collectResponsesStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (containsTokenPrefix(identifier) || service.detectSensitive(identifier)) {
      throw new Error(refusal("structural-identifier"));
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(refusal("number-sensitive"));

  const next = withOpaqueReasoningContent(body, (stage) =>
    withOpaqueAttachments(service.attachmentsPolicy ?? "block", stage, (input) => {
      const masked = service.protectJsonForModel(sessionID, input);
      if (!masked.ok) throw new Error(MASK_FAILURE);
      const value = masked.value;
      if (!isRecord(value)) throw new Error(MASK_FAILURE);
      return value as Record<string, unknown>;
    }),
  );

  const structuralAfter = collectResponsesStructuralStrings(next);
  if (
    structuralAfter.length !== structuralBefore.length ||
    structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
  ) {
    throw new Error(refusal("structural-drift"));
  }

  if (Array.isArray(next.input)) {
    for (const index of transformedArguments) {
      const item = next.input[index];
      if (!isRecord(item) || typeof item.name !== "string") throw new Error(MASK_FAILURE);
      item.arguments = JSON.stringify(item.arguments);
    }
  }

  const serialized = JSON.stringify(next);
  if (serialized === originalSerialized) return request;
  const headers = new Headers(request.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(serialized)));
  return new Request(request, { body: serialized, headers });
}

function isRecordArgumentsString(item: Record<string, unknown>): boolean {
  return typeof item.arguments === "string";
}

/** Hook-first admission: check the supported response route and transport
 * metadata without reading, validating, or changing the final request body.
 * Returning the same Request preserves identity for response attribution. */
export function admitModelRequest(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
  allowHookOnly = false,
): Request {
  const url = new URL(request.url);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || (!allowHookOnly && classifyModelRoute(request.url) === null)) {
    throw new Error(UNSUPPORTED_TRANSPORT);
  }
  if (urlCarriesToken(request.url)) {
    if (!service.isTransportIdentifierSafe(sessionID, request.url)) throw new Error(refusal("url-token"));
    warnDegradation("request url preserved with a literal placeholder");
  }
  inspectTransportMetadata(service, sessionID, request);
  return request;
}

/** Protocol dispatcher: masks any supported wire route by URL shape. */
export async function remaskModelRequest(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
): Promise<Request> {
  const route = classifyModelRoute(request.url);
  if (route === null) throw new Error(UNSUPPORTED_TRANSPORT);
  if (route === "anthropic-messages") {
    return remaskAnthropicMessagesRequest(service, sessionID, request);
  }
  if (route === "openai-responses") {
    return remaskResponsesRequest(service, sessionID, request);
  }
  return remaskChatCompletionsRequest(service, sessionID, request);
}

// ─── Response restore (assistant display text only) ─────────────────────────

/**
 * Restores assistant display text in a model response. Error bodies and
 * unsupported content types are passed through only when a bounded clone-read
 * proves they carry no reserved token this module cannot restore; otherwise
 * the response fails closed.
 */
export async function restoreChatCompletionsResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const restorable = response.status >= 200 && response.status < 300;
  if (restorable && contentType.includes("application/json")) {
    return restoreJsonResponse(service, sessionID, response);
  }
  if (restorable && contentType.includes("text/event-stream")) {
    return restoreSseResponse(service, sessionID, response);
  }
  // P1 (2026-10-06b): an unplaceable placeholder in an unrestorable body is
  // degradation — pass through with a WARN, never a refusal; token-free
  // error/metadata bodies pass untouched.
  return passThroughIfTokenBearing(response);
}

/** Passes an unrestorable response through, degrading (WARN) when it carries a placeholder. */
async function passThroughIfTokenBearing(response: Response): Promise<Response> {
  if (response.body === null) return response;
  const raw = await readCappedText(response, MAX_BODY_BYTES, UNSUPPORTED_RESPONSE);
  if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
  return response;
}

async function restoreJsonResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const raw = await readCappedText(response, MAX_BODY_BYTES, UNSUPPORTED_RESPONSE);
  if (raw.length === 0) return response;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (!isRecord(body)) {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (body.choices === undefined) {
    // Not a chat-completions payload; an unplaceable placeholder degrades to
    // a literal emit with a WARN (P1, 2026-10-06b).
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (!Array.isArray(body.choices)) throw new Error(UNSUPPORTED_RESPONSE);

  let changed = false;
  for (const choice of body.choices) {
    if (!isRecord(choice)) throw new Error(UNSUPPORTED_RESPONSE);
    const message = choice.message;
    if (message === undefined || message === null) continue;
    if (!isRecord(message)) throw new Error(UNSUPPORTED_RESPONSE);
    changed = restoreAssistantContent(service, sessionID, message) || changed;
    // message.tool_calls is deliberately untouched: tool arguments stay
    // tokenized until the typed tool gate decides execution.
  }
  // P1 (2026-10-06b): a reserved token outside intentional tool arguments is
  // degradation, not failure — the placeholder stays literal with a WARN;
  // mapping loss never refuses response delivery.
  if (strayTokenIn(body)) warnDegradation("response carries an unplaceable placeholder; kept literal");

  if (!changed) return response;
  const next = JSON.stringify(body);
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(next)));
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function restoreAssistantContent(
  service: TransportMaskingService,
  sessionID: string,
  message: Record<string, unknown>,
): boolean {
  const content = message.content;
  if (content === undefined || content === null) return false;
  if (typeof content === "string") {
    if (content.length === 0) return false;
    const restored = restoreDisplayText(service, sessionID, content);
    if (restored !== content) {
      message.content = restored;
      return true;
    }
    return false;
  }
  if (!Array.isArray(content)) throw new Error(UNSUPPORTED_RESPONSE);
  let changed = false;
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
      throw new Error(UNSUPPORTED_RESPONSE);
    }
    if (part.text.length === 0) continue;
    const restored = restoreDisplayText(service, sessionID, part.text);
    if (restored !== part.text) {
      part.text = restored;
      changed = true;
    }
  }
  return changed;
}

export function restoreDisplayText(service: TransportMaskingService, sessionID: string, text: string): string {
  const result = service.restoreTextForDisplay(sessionID, text);
  if (!result.ok) throw new Error(RESTORE_FAILURE);
  return result.text;
}

// ─── SSE streaming restore ───────────────────────────────────────────────────

function restoreSseResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Response {
  if (response.body === null) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const stream = createSseRestoreStream(service, sessionID, response.body);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Splits `buffered` into the portion safe to restore now and any incomplete
 * token candidate that must be held back until more stream data arrives. A
 * held tail is either a partial token from its LAST full prefix (either
 * version), or the longest suffix that is a proper prefix of a reserved
 * namespace prefix (e.g. `[SG`, `[SGP2`): emitting that suffix literally
 * would make the token unrestorable. Complete tokens in the emit portion are
 * restored by the caller through the core; a tail that never completes
 * degrades to a literal emit with a WARN at the terminal boundary
 * (P1, 2026-10-06b).
 */
export function splitRestorable(buffered: string): { emit: string; hold: string } {
  let at = -1;
  for (const prefix of PSEUDONYM_TOKEN_PREFIXES) {
    const candidate = buffered.lastIndexOf(prefix);
    if (candidate > at) at = candidate;
  }
  if (at !== -1) {
    const tail = buffered.slice(at);
    if (!tail.includes("]")) return { emit: buffered.slice(0, at), hold: tail };
  }
  // Longest suffix matching a proper prefix of either reserved prefix. Both
  // versions share "[SGP" and differ only in the version character, so the
  // distinct candidates (length 5 down to 1) are checked longest-first.
  for (let length = PSEUDONYM_TOKEN_PREFIXES[0].length - 1; length >= 1; length--) {
    for (const prefix of PSEUDONYM_TOKEN_PREFIXES) {
      const partial = prefix.slice(0, length);
      if (buffered.endsWith(partial)) {
        return { emit: buffered.slice(0, buffered.length - length), hold: partial };
      }
    }
  }
  return { emit: buffered, hold: "" };
}

/**
 * Incremental SSE restore. UTF-8 is decoded streaming (code points may split
 * across chunks), complete events are assembled from their `data:` lines as
 * they terminate (a blank line), and each choice's `delta.content` channel
 * keeps a token-prefix hold buffer so tokens split across chunks AND events
 * are restored exactly once, in order.
 *
 * Bounds are explicit, measured in UTF-8 bytes and fail closed: the pending
 * line buffer, the accumulated (unterminated) event, each choice channel, the
 * aggregate channel state and the channel count are all capped, each charged
 * before the value is accumulated. A choice whose token is still unresolved
 * at a terminal `finish_reason` degrades — the held tail is emitted literally
 * with a WARN — and a choice that keeps producing output after it is terminal
 * refuses. Reading is pull-based: one
 * bounded batch of upstream data is consumed per downstream pull, so an unread
 * consumer never builds an unbounded downstream queue. Errors from the
 * underlying stream propagate and downstream cancellation cancels its reader.
 * SG parse/restore failures instead replay undelivered originals and bypass
 * further rewriting; they never cancel a healthy upstream response.
 */
export function createSseRestoreStream(
  service: TransportMaskingService,
  sessionID: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  /** Held-back content tails per choice index (tokens split across events). */
  const channels = new Map<number, string>();
  /** Choice indexes that have already seen a terminal `finish_reason`. */
  const terminalChannels = new Set<number>();
  let totalChannelBytes = 0;
  let eventLines: string[] = [];

  /** An unresolved boundary stops rewriting; the shared loop retains and
   * releases the original frames rather than losing the literal prefix. */
  const requireEmptyChannels = (): void => {
    if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
  };
  const setChannel = (channel: number, hold: string): void => {
    const previous = channels.get(channel) ?? "";
    totalChannelBytes += byteLength(hold) - byteLength(previous);
    if (totalChannelBytes > MAX_TOTAL_CHANNEL_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    channels.set(channel, hold);
  };
  const deleteChannel = (channel: number): void => {
    const previous = channels.get(channel);
    if (previous !== undefined) totalChannelBytes -= byteLength(previous);
    channels.delete(channel);
  };

  /** Assembles and restores one SSE event; `terminated` adds the blank line. */
  const processEvent = (terminated: boolean): string => {
    const lines = eventLines;
    eventLines = [];
    const framing: string[] = [];
    const dataPayloads: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) {
        let payload = line.slice("data:".length);
        if (payload.startsWith(" ")) payload = payload.slice(1);
        dataPayloads.push(payload);
      } else {
        framing.push(line);
      }
    }

    const emitPayload = (payload: string): string[] =>
      framing.concat(payload.split("\n").map((line) => `data: ${line}`));

    let outputLines: string[];
    if (dataPayloads.length === 0) {
      outputLines = framing;
    } else {
      const joined = dataPayloads.join("\n");
      if (joined === "[DONE]") {
        requireEmptyChannels();
        outputLines = emitPayload(joined);
      } else {
        let chunk: unknown;
        try {
          chunk = JSON.parse(joined);
        } catch {
          throw new Error(MALFORMED_STREAM);
        }
        if (!isRecord(chunk)) throw new Error(MALFORMED_STREAM);
        // A provider error must reach the host immediately, even while an
        // incomplete text token is holding earlier events transactionally.
        // Recovery releases the original error envelope, never a fake finish.
        if (chunk.error !== undefined || chunk.type === "error") throw new Error(MALFORMED_STREAM);
        if (chunk.choices !== undefined) {
          if (!Array.isArray(chunk.choices)) throw new Error(MALFORMED_STREAM);
          for (let position = 0; position < chunk.choices.length; position++) {
            const choice = chunk.choices[position];
            if (!isRecord(choice)) throw new Error(MALFORMED_STREAM);
            // Channel key is the provider's choice index when present, so
            // interleaved multi-choice streams keep independent hold buffers.
            const channel =
              typeof choice.index === "number" && Number.isInteger(choice.index)
                ? choice.index
                : position;
            const terminal = typeof choice.finish_reason === "string";
            // Terminal state is per choice: no further event may follow it.
            if (terminalChannels.has(channel)) throw new Error(MALFORMED_STREAM);
            const delta = choice.delta;
            if (delta !== undefined && delta !== null) {
              if (!isRecord(delta)) throw new Error(MALFORMED_STREAM);
              // delta.tool_calls is deliberately not restored: tool arguments
              // remain tokenized until the typed tool gate.
              const content = delta.content;
              if (content !== undefined && content !== null) {
                if (typeof content !== "string") throw new Error(MALFORMED_STREAM);
                if (!channels.has(channel) && channels.size >= MAX_CHANNELS) {
                  throw new Error(STREAM_BUFFER_LIMIT);
                }
                const held = channels.get(channel) ?? "";
                if (byteLength(held) + byteLength(content) > MAX_CHANNEL_BYTES) {
                  throw new Error(STREAM_BUFFER_LIMIT);
                }
                const buffered = held + content;
                const { emit, hold } = splitRestorable(buffered);
                delta.content = emit.length === 0 ? "" : restoreDisplayText(service, sessionID, emit);
                if (hold === "") deleteChannel(channel);
                else setChannel(channel, hold);
              }
            }
            // P1 (2026-10-06b): a terminal choice holding an unresolved tail
            // (split or never-completed placeholder) is degradation, not a
            // stream failure — emit the held tail literally, WARN, and clear
            // the channel so per-choice state stays bounded.
            if (terminal) {
              const held = channels.get(channel);
              if (held !== undefined) {
                if (isRecord(delta) && typeof delta.content === "string") {
                  delta.content += held;
                } else if (isRecord(delta)) {
                  delta.content = held;
                } else {
                  choice.delta = { content: held };
                }
                warnDegradation("terminal stream event emitted an incomplete placeholder tail literally");
                deleteChannel(channel);
              }
              if (!terminalChannels.has(channel) && terminalChannels.size >= MAX_CHANNELS) {
                throw new Error(STREAM_BUFFER_LIMIT);
              }
              terminalChannels.add(channel);
            }
          }
          // A reserved token outside intentional tool arguments is degradation
          // (P1, 2026-10-06b): re-emit literally with a WARN.
          if (strayTokenIn(chunk)) {
            warnDegradation("stream event carries an unplaceable placeholder; kept literal");
          }
          outputLines = emitPayload(JSON.stringify(chunk));
        } else {
          // Usage-only etc.: re-emit the original payload verbatim; an
          // unplaceable placeholder stays literal with a WARN (P1).
          if (strayTokenIn(chunk)) {
            warnDegradation("stream event carries an unplaceable placeholder; kept literal");
          }
          outputLines = emitPayload(joined);
        }
      }
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return terminated ? `${text}\n\n` : text;
  };

  return createRecoveringSseStream(reader, (lines, terminated) => {
    eventLines = lines;
    return { output: processEvent(terminated), holding: channels.size > 0 };
  }, () => { channels.clear(); terminalChannels.clear(); });
}

// ─── Anthropic Messages response restore ────────────────────────────────────

/**
 * Token in an Anthropic response may appear ONLY in content-block text
 * (restored below) or inside tool_use.input (deliberately kept tokenized for
 * the typed tool gate). Anywhere else it is a stray that must refuse.
 */
type AnthropicAllowedFields = WeakMap<object, Set<string>>;

/**
 * Marks a field as display-restored assistant text. Per the literal-content
 * policy (spec §Mapping and restoration), an unknown or malformed marker
 * string that survives display restoration there is literal content — not a
 * stray — while identifiers, transport metadata, and tool arguments stay
 * strict everywhere else.
 */
function allowAnthropicField(fields: AnthropicAllowedFields, record: Record<string, unknown>, field: string): void {
  const allowed = fields.get(record) ?? new Set<string>();
  allowed.add(field);
  fields.set(record, allowed);
}

function anthropicStrayTokenIn(value: unknown, fields?: AnthropicAllowedFields): boolean {
  if (typeof value === "string") {
    return containsTokenPrefix(value);
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => anthropicStrayTokenIn(item, fields));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (containsTokenPrefix(key)) return true;
    const value = record[key];
    // content[].text is restored in place before this check runs; a surviving
    // token there was intentionally left by restore failure handling.
    if (key === "content" && Array.isArray(value)) {
      for (const block of value) {
        if (!isRecord(block)) return true;
        if (block.type === "tool_use") {
          if (typeof block.id === "string" && containsTokenPrefix(block.id)) return true;
          continue; // input stays tokenized by design
        }
        if (anthropicStrayTokenIn(block, fields)) return true;
      }
      continue;
    }
    if (fields?.get(record)?.has(key)) continue;
    if (anthropicStrayTokenIn(value, fields)) return true;
  }
  return false;
}

async function restoreAnthropicJsonResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const raw = await readCappedText(response, MAX_BODY_BYTES, UNSUPPORTED_RESPONSE);
  if (raw.length === 0) return response;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (!isRecord(body)) {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (body.content === undefined) {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (!Array.isArray(body.content)) throw new Error(UNSUPPORTED_RESPONSE);

  let changed = false;
  const fields: AnthropicAllowedFields = new WeakMap();
  for (const block of body.content) {
    if (!isRecord(block)) throw new Error(UNSUPPORTED_RESPONSE);
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error(UNSUPPORTED_RESPONSE);
      if (block.text.length > 0) {
        block.text = restoreDisplayText(service, sessionID, block.text);
        allowAnthropicField(fields, block, "text");
        changed = true;
      }
    }
    // tool_use / other blocks: input stays tokenized until the typed tool gate.
  }
  if (anthropicStrayTokenIn(body, fields)) throw new Error(UNSUPPORTED_RESPONSE);
  if (!changed) return response;
  const next = JSON.stringify(body);
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(next)));
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Restores an Anthropic Messages SSE stream. Channel hold buffers are keyed by
 * content-block index (tokens may split across content_block_delta events);
 * content_block_stop requires an empty channel and marks the index terminal;
 * message_stop requires every channel drained. input_json_delta is
 * deliberately untouched (tool arguments restore at the typed tool gate). All
 * framing/byte caps mirror the chat-completions stream.
 */
export function createAnthropicSseRestoreStream(
  service: TransportMaskingService,
  sessionID: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const channels = new Map<number, string>();
  const terminalBlocks = new Set<number>();
  const allowedFields: AnthropicAllowedFields = new WeakMap();
  let totalChannelBytes = 0;
  let eventLines: string[] = [];
  const messageStopped = { value: false };

  const setChannel = (channel: number, hold: string): void => {
    const previous = channels.get(channel) ?? "";
    totalChannelBytes += byteLength(hold) - byteLength(previous);
    if (totalChannelBytes > MAX_TOTAL_CHANNEL_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    channels.set(channel, hold);
  };
  const deleteChannel = (channel: number): void => {
    const previous = channels.get(channel);
    if (previous !== undefined) totalChannelBytes -= byteLength(previous);
    channels.delete(channel);
  };

  const processEvent = (terminated: boolean): string => {
    const lines = eventLines;
    eventLines = [];
    const framing: string[] = [];
    const dataPayloads: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) {
        let payload = line.slice("data:".length);
        if (payload.startsWith(" ")) payload = payload.slice(1);
        dataPayloads.push(payload);
      } else {
        framing.push(line);
      }
    }
    const emitPayload = (payload: string): string[] =>
      framing.concat(payload.split("\n").map((line) => `data: ${line}`));

    let outputLines: string[];
    if (dataPayloads.length === 0) {
      outputLines = framing;
    } else {
      const joined = dataPayloads.join("\n");
      let chunk: unknown;
      try {
        chunk = JSON.parse(joined);
      } catch {
        throw new Error(MALFORMED_STREAM);
      }
      if (!isRecord(chunk) || typeof chunk.type !== "string") throw new Error(MALFORMED_STREAM);
      if (chunk.type === "error") throw new Error(MALFORMED_STREAM);
      if (messageStopped.value) throw new Error(MALFORMED_STREAM);

      switch (chunk.type) {
        case "message_start": {
          const message = chunk.message;
          if (isRecord(message) && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (!isRecord(block)) throw new Error(MALFORMED_STREAM);
              if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                block.text = restoreDisplayText(service, sessionID, block.text);
                allowAnthropicField(allowedFields, block, "text");
              }
            }
          }
          break;
        }
        case "content_block_start": {
          const index = chunk.index;
          if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(MALFORMED_STREAM);
          if (terminalBlocks.has(index)) throw new Error(MALFORMED_STREAM);
          const block = chunk.content_block;
          if (!isRecord(block)) throw new Error(MALFORMED_STREAM);
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            const held = channels.get(index) ?? "";
            const buffered = held + block.text;
            const { emit, hold } = splitRestorable(buffered);
            if (emit.length > 0) block.text = restoreDisplayText(service, sessionID, emit);
            else block.text = "";
            allowAnthropicField(allowedFields, block, "text");
            if (hold === "") deleteChannel(index);
            else setChannel(index, hold);
          }
          break;
        }
        case "content_block_delta": {
          const index = chunk.index;
          if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(MALFORMED_STREAM);
          if (terminalBlocks.has(index)) throw new Error(MALFORMED_STREAM);
          const delta = chunk.delta;
          if (!isRecord(delta)) throw new Error(MALFORMED_STREAM);
          if (delta.type === "text_delta") {
            if (typeof delta.text !== "string") throw new Error(MALFORMED_STREAM);
            const held = channels.get(index) ?? "";
            const buffered = held + delta.text;
            const { emit, hold } = splitRestorable(buffered);
            delta.text = emit.length === 0 ? "" : restoreDisplayText(service, sessionID, emit);
            allowAnthropicField(allowedFields, delta, "text");
            if (hold === "") deleteChannel(index);
            else setChannel(index, hold);
          }
          // input_json_delta / thinking_delta / signature_delta: untouched.
          break;
        }
        case "content_block_stop": {
          const index = chunk.index;
          if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(MALFORMED_STREAM);
          // The shared recovery loop replays undelivered originals on a
          // boundary with unresolved text; no literal prefix is discarded.
          if (channels.has(index)) throw new Error(MALFORMED_STREAM);
          if (!terminalBlocks.has(index) && terminalBlocks.size >= MAX_CHANNELS) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          terminalBlocks.add(index);
          break;
        }
        case "message_stop": {
          if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
          messageStopped.value = true;
          break;
        }
        default:
          // ping / message_delta / unknown events carry no display text.
          break;
      }

      // P1 (2026-10-06b): an unplaceable placeholder is degradation — WARN,
      // emit literally; mapping loss never refuses response delivery.
      if (anthropicChunkStrayTokenIn(chunk, allowedFields)) {
        warnDegradation("anthropic stream event carries an unplaceable placeholder; kept literal");
      }
      outputLines = emitPayload(JSON.stringify(chunk));
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return terminated ? `${text}\n\n` : text;
  };

  return createRecoveringSseStream(reader, (lines, terminated) => {
    eventLines = lines;
    return { output: processEvent(terminated), holding: channels.size > 0 };
  }, () => { channels.clear(); terminalBlocks.clear(); });
}

/** Stray-token policy for one Anthropic SSE chunk: tokens may live only in
 * text channels (already restored above) and tool_use/input_json payloads. */
function anthropicChunkStrayTokenIn(chunk: Record<string, unknown>, fields?: AnthropicAllowedFields): boolean {
  const check = (value: unknown, inToolPayload: boolean): boolean => {
    if (typeof value === "string") {
      return !inToolPayload && containsTokenPrefix(value);
    }
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      return value.some((item) => check(item, inToolPayload));
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (containsTokenPrefix(key)) return true;
      if (key === "partial_json" || key === "input") {
        continue; // tool-argument payloads stay tokenized by design
      }
      if (fields?.get(record)?.has(key)) continue;
      if (check(record[key], inToolPayload)) return true;
    }
    return false;
  };
  return check(chunk, false);
}

function restoreAnthropicSseResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Response {
  if (response.body === null) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const stream = createAnthropicSseRestoreStream(service, sessionID, response.body);
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Restores assistant display text in an Anthropic Messages response. Error
 * bodies and unsupported content types pass through only when provably free
 * of reserved tokens; otherwise the response fails closed.
 */
export async function restoreAnthropicMessagesResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const restorable = response.status >= 200 && response.status < 300;
  if (restorable && contentType.includes("application/json")) {
    return restoreAnthropicJsonResponse(service, sessionID, response);
  }
  if (restorable && contentType.includes("text/event-stream")) {
    return restoreAnthropicSseResponse(service, sessionID, response);
  }
  return passThroughIfTokenBearing(response);
}

/** Protocol dispatcher: restores a response using the SAME wire route the
 * masked request used (classified by request URL shape). */
export async function restoreModelResponse(
  service: TransportMaskingService,
  sessionID: string,
  request: Request,
  response: Response,
): Promise<Response> {
  const route = classifyModelRoute(request.url);
  if (route === null) throw new Error(UNSUPPORTED_TRANSPORT);
  if (route === "anthropic-messages") {
    return restoreAnthropicMessagesResponse(service, sessionID, response);
  }
  if (route === "openai-responses") {
    return restoreResponsesResponse(service, sessionID, response);
  }
  return restoreChatCompletionsResponse(service, sessionID, response);
}

// ─── OpenAI Responses response restore ──────────────────────────────────────

const RESPONSES_TEXT_PART_TYPES = new Set(["output_text", "input_text", "summary_text", "reasoning_text"]);
export const RESPONSES_TEXT_DELTA_TYPES: ReadonlySet<string> = new Set([
  "response.output_text.delta",
  "response.refusal.delta",
  "response.reasoning.delta",
  "response.reasoning_text.delta",
  "response.reasoning_summary_text.delta",
]);
export const RESPONSES_TEXT_DONE_TYPES: ReadonlySet<string> = new Set([
  "response.output_text.done",
  "response.refusal.done",
  "response.reasoning.done",
  "response.reasoning_text.done",
  "response.reasoning_summary_text.done",
]);

type ResponsesAllowedFields = WeakMap<object, Set<string>>;

function allowResponsesField(fields: ResponsesAllowedFields, record: Record<string, unknown>, field: string): void {
  const allowed = fields.get(record) ?? new Set<string>();
  allowed.add(field);
  fields.set(record, allowed);
}

function restoreResponsesPartText(
  service: TransportMaskingService,
  sessionID: string,
  part: Record<string, unknown>,
  fields: ResponsesAllowedFields,
): boolean {
  if (typeof part.type === "string" && RESPONSES_TEXT_PART_TYPES.has(part.type) && typeof part.text === "string") {
    part.text = restoreDisplayText(service, sessionID, part.text);
    allowResponsesField(fields, part, "text");
    return true;
  }
  if (part.type === "refusal" && typeof part.refusal === "string") {
    part.refusal = restoreDisplayText(service, sessionID, part.refusal);
    allowResponsesField(fields, part, "refusal");
    return true;
  }
  return false;
}

function restoreResponsesItemText(
  service: TransportMaskingService,
  sessionID: string,
  item: Record<string, unknown>,
  fields: ResponsesAllowedFields,
): boolean {
  if (item.type === "function_call" && typeof item.arguments === "string") {
    allowResponsesField(fields, item, "arguments");
  }
  if (item.type === "custom_tool_call" && typeof item.input === "string") {
    allowResponsesField(fields, item, "input");
  }
  if ((item.type === "function_call_output" || item.type === "custom_tool_call_output") && typeof item.output === "string") {
    allowResponsesField(fields, item, "output");
  }
  let changed = false;
  const partFields = item.type === "message" ? ["content"] : item.type === "reasoning" ? ["content", "summary"] : [];
  for (const field of partFields) {
    const parts = item[field];
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (isRecord(part)) changed = restoreResponsesPartText(service, sessionID, part, fields) || changed;
    }
  }
  return restoreResponsesPartText(service, sessionID, item, fields) || changed;
}

function responsesStrayTokenIn(value: unknown, fields: ResponsesAllowedFields): boolean {
  if (typeof value === "string") {
    return containsTokenPrefix(value);
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => responsesStrayTokenIn(item, fields));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (containsTokenPrefix(key)) return true;
    if (fields.get(record)?.has(key)) continue;
    if (responsesStrayTokenIn(record[key], fields)) return true;
  }
  return false;
}

/** Restore complete display fields of one Responses event (HTTP/WS share
 * the same part/item semantics). Delta buffering belongs to the transport;
 * function-call arguments and provider state are never restored here. */
export function restoreResponsesEventDisplay(
  service: TransportMaskingService,
  sessionID: string,
  chunk: Record<string, unknown>,
): void {
  const fields: ResponsesAllowedFields = new WeakMap();
  const type = String(chunk.type);
  if (RESPONSES_TEXT_DELTA_TYPES.has(type)) {
    allowResponsesField(fields, chunk, "delta");
  } else if (RESPONSES_TEXT_DONE_TYPES.has(type)) {
    const field = type === "response.refusal.done" ? "refusal" : "text";
    if (typeof chunk[field] === "string") {
      chunk[field] = restoreDisplayText(service, sessionID, chunk[field]);
      allowResponsesField(fields, chunk, field);
    }
  } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
    allowResponsesField(fields, chunk, type.endsWith(".delta") ? "delta" : "arguments");
  } else if (type === "response.custom_tool_call_input.delta" || type === "response.custom_tool_call_input.done") {
    allowResponsesField(fields, chunk, type.endsWith(".delta") ? "delta" : "input");
  } else if (type === "response.output_item.added" || type === "response.output_item.done") {
    if (isRecord(chunk.item)) restoreResponsesItemText(service, sessionID, chunk.item, fields);
  } else if (
    type === "response.content_part.added" || type === "response.content_part.done" ||
    type === "response.reasoning_summary_part.added" || type === "response.reasoning_summary_part.done"
  ) {
    if (isRecord(chunk.part)) restoreResponsesPartText(service, sessionID, chunk.part, fields);
  } else if (
    type === "response.created" || type === "response.in_progress" ||
    type === "response.completed" || type === "response.failed" || type === "response.incomplete"
  ) {
    const response = chunk.response;
    if (isRecord(response)) {
      if (typeof response.output_text === "string") {
        response.output_text = restoreDisplayText(service, sessionID, response.output_text);
        allowResponsesField(fields, response, "output_text");
      }
      if (Array.isArray(response.output)) {
        for (const item of response.output) {
          if (isRecord(item)) restoreResponsesItemText(service, sessionID, item, fields);
        }
      }
    }
  }
  if (responsesStrayTokenIn(chunk, fields)) warnDegradation("responses frame carries an unplaceable placeholder; kept literal");
}

async function restoreResponsesJsonResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const raw = await readCappedText(response, MAX_BODY_BYTES, UNSUPPORTED_RESPONSE);
  if (raw.length === 0) return response;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  if (!isRecord(body)) {
    if (containsTokenPrefix(raw)) warnDegradation("response body carries an unplaceable placeholder; kept literal");
    return response;
  }
  const fields: ResponsesAllowedFields = new WeakMap();
  if (body.output_text !== undefined && typeof body.output_text === "string") {
    body.output_text = restoreDisplayText(service, sessionID, body.output_text);
    allowResponsesField(fields, body, "output_text");
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item)) throw new Error(UNSUPPORTED_RESPONSE);
      restoreResponsesItemText(service, sessionID, item, fields);
    }
  }
  if (responsesStrayTokenIn(body, fields)) throw new Error(UNSUPPORTED_RESPONSE);
  const next = JSON.stringify(body);
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.set("content-length", String(byteLength(next)));
  return new Response(next, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Restores an OpenAI Responses SSE stream. Channels are keyed by item id (or
 * output index) for response.output_text.delta events; function_call_arguments
 * deltas are untouched (tool gate); the terminal response.completed/failed/
 * incomplete event requires drained channels, and no event may follow it.
 */
export function createResponsesSseRestoreStream(
  service: TransportMaskingService,
  sessionID: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const channels = new Map<string, string>();
  const emittedRawCounts = new Map<string, number>();
  let totalChannelBytes = 0;
  let eventLines: string[] = [];
  const terminal = { value: false };

  const setChannel = (channel: string, hold: string): void => {
    const previous = channels.get(channel) ?? "";
    totalChannelBytes += byteLength(hold) - byteLength(previous);
    if (totalChannelBytes > MAX_TOTAL_CHANNEL_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    channels.set(channel, hold);
  };
  const deleteChannel = (channel: string): void => {
    const previous = channels.get(channel);
    if (previous !== undefined) totalChannelBytes -= byteLength(previous);
    channels.delete(channel);
  };
  const finishChannel = (key: string, fullText: string, chunk: Record<string, unknown>, kind: string): string => {
    const held = channels.get(key);
    const offset = emittedRawCounts.get(key) ?? 0;
    emittedRawCounts.delete(key);
    if (held === undefined) return "";
    const remainder = fullText.slice(offset);
    if (offset > fullText.length || !remainder.startsWith(held)) throw new Error(MALFORMED_STREAM);
    const delta = restoreDisplayText(service, sessionID, remainder);
    deleteChannel(key);
    if (delta.length === 0) return "";
    const event = {
      type: `${kind}.delta`,
      item_id: chunk.item_id,
      output_index: chunk.output_index,
      content_index: chunk.content_index,
      summary_index: chunk.summary_index,
      delta,
    };
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  };

  const processEvent = (terminated: boolean): string => {
    const lines = eventLines;
    eventLines = [];
    const framing: string[] = [];
    const dataPayloads: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) {
        let payload = line.slice("data:".length);
        if (payload.startsWith(" ")) payload = payload.slice(1);
        dataPayloads.push(payload);
      } else {
        framing.push(line);
      }
    }
    const emitPayload = (payload: string): string[] =>
      framing.concat(payload.split("\n").map((line) => `data: ${line}`));

    let outputLines: string[];
    let additionalEvents = "";
    if (dataPayloads.length === 0) {
      outputLines = framing;
    } else {
      const joined = dataPayloads.join("\n");
      if (joined.trim() === "[DONE]") {
        if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
        emittedRawCounts.clear();
        terminal.value = true;
        outputLines = emitPayload("[DONE]");
      } else {
        let chunk: unknown;
        try {
          chunk = JSON.parse(joined);
        } catch {
          throw new Error(MALFORMED_STREAM);
        }
        if (!isRecord(chunk) || typeof chunk.type !== "string") throw new Error(MALFORMED_STREAM);
        if (chunk.type === "error") throw new Error(MALFORMED_STREAM);
        if (terminal.value) throw new Error(MALFORMED_STREAM);
        const eventType = chunk.type;
        const fields: ResponsesAllowedFields = new WeakMap();

        const channelKey = (kind = eventType.replace(/\.(?:delta|done)$/, "")): string => {
          const item = chunk.item_id ?? chunk.id ?? chunk.output_index;
          const identity = typeof item === "string" || typeof item === "number" ? item : "0";
          return JSON.stringify([kind, identity, chunk.content_index ?? chunk.summary_index ?? 0]);
        };

        if (RESPONSES_TEXT_DELTA_TYPES.has(eventType)) {
          if (typeof chunk.delta !== "string") throw new Error(MALFORMED_STREAM);
          const key = channelKey();
          if ((!emittedRawCounts.has(key) && emittedRawCounts.size >= MAX_CHANNELS) || byteLength(key) > MAX_CHANNEL_BYTES) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          const held = channels.get(key) ?? "";
          if (byteLength(held) + byteLength(chunk.delta) > MAX_CHANNEL_BYTES) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          const buffered = held + chunk.delta;
          const { emit, hold } = splitRestorable(buffered);
          emittedRawCounts.set(key, (emittedRawCounts.get(key) ?? 0) + emit.length);
          chunk.delta = emit.length === 0 ? "" : restoreDisplayText(service, sessionID, emit);
          allowResponsesField(fields, chunk, "delta");
          if (hold === "") deleteChannel(key);
          else setChannel(key, hold);
        } else if (RESPONSES_TEXT_DONE_TYPES.has(eventType)) {
          const field = eventType === "response.refusal.done" ? "refusal" : "text";
          if (chunk[field] !== undefined) {
            if (typeof chunk[field] !== "string") throw new Error(MALFORMED_STREAM);
            additionalEvents += finishChannel(channelKey(), chunk[field], chunk, eventType.replace(/\.done$/, ""));
            chunk[field] = restoreDisplayText(service, sessionID, chunk[field]);
            allowResponsesField(fields, chunk, field);
          } else if (channels.has(channelKey())) {
            throw new Error(MALFORMED_STREAM);
          } else {
            emittedRawCounts.delete(channelKey());
          }
        } else if (
          eventType === "response.content_part.added" ||
          eventType === "response.content_part.done" ||
          eventType === "response.reasoning_summary_part.added" ||
          eventType === "response.reasoning_summary_part.done"
        ) {
          const part = chunk.part;
          if (isRecord(part)) {
            const completeText = part.type === "refusal" ? part.refusal : part.text;
            if (restoreResponsesPartText(service, sessionID, part, fields) && eventType.endsWith(".done") && typeof completeText === "string") {
              const kind = part.type === "summary_text" ? "reasoning_summary_text" : String(part.type);
              additionalEvents += finishChannel(channelKey(`response.${kind}`), completeText, chunk, `response.${kind}`);
            }
          }
        } else if (eventType === "response.output_item.added" || eventType === "response.output_item.done") {
          const item = chunk.item;
          if (isRecord(item)) {
            restoreResponsesItemText(service, sessionID, item, fields);
            if (eventType === "response.output_item.done") {
              for (const key of emittedRawCounts.keys()) {
                if (JSON.parse(key)[1] === item.id && !channels.has(key)) emittedRawCounts.delete(key);
              }
            }
          }
        } else if (
          eventType === "response.completed" ||
          eventType === "response.failed" ||
          eventType === "response.incomplete"
        ) {
          if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
          emittedRawCounts.clear();
          terminal.value = true;
          const response = chunk.response;
          if (isRecord(response)) {
            if (typeof response.output_text === "string") {
              response.output_text = restoreDisplayText(service, sessionID, response.output_text);
              allowResponsesField(fields, response, "output_text");
            }
            if (Array.isArray(response.output)) {
              for (const item of response.output) {
                if (isRecord(item)) restoreResponsesItemText(service, sessionID, item, fields);
              }
            }
          }
        } else if (eventType === "response.function_call_arguments.delta" || eventType === "response.function_call_arguments.done") {
          const field = eventType.endsWith(".delta") ? "delta" : "arguments";
          if (typeof chunk[field] === "string") allowResponsesField(fields, chunk, field);
        } else if (eventType === "response.custom_tool_call_input.delta" || eventType === "response.custom_tool_call_input.done") {
          const field = eventType.endsWith(".delta") ? "delta" : "input";
          if (typeof chunk[field] === "string") allowResponsesField(fields, chunk, field);
        }

        // P1 (2026-10-06b): an unplaceable placeholder is degradation — WARN
        // and emit literally; mapping loss never refuses response delivery.
        if (responsesStrayTokenIn(chunk, fields)) {
          warnDegradation("responses stream event carries an unplaceable placeholder; kept literal");
        }
        outputLines = emitPayload(JSON.stringify(chunk));
      }
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return additionalEvents + (terminated ? `${text}\n\n` : text);
  };

  return createRecoveringSseStream(reader, (lines, terminated) => {
    eventLines = lines;
    return { output: processEvent(terminated), holding: channels.size > 0 };
  }, () => { channels.clear(); emittedRawCounts.clear(); });
}

/**
 * Restores assistant display text in an OpenAI Responses response; error
 * bodies and unsupported content types pass through only when provably free
 * of reserved tokens.
 */
export async function restoreResponsesResponse(
  service: TransportMaskingService,
  sessionID: string,
  response: Response,
): Promise<Response> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const restorable = response.status >= 200 && response.status < 300;
  if (restorable && contentType.includes("application/json")) {
    return restoreResponsesJsonResponse(service, sessionID, response);
  }
  if (restorable && contentType.includes("text/event-stream")) {
    if (response.body === null) return response;
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const stream = createResponsesSseRestoreStream(service, sessionID, response.body);
    return new Response(stream, { status: response.status, statusText: response.statusText, headers });
  }
  return passThroughIfTokenBearing(response);
}

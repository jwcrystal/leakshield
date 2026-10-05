/**
 * Transport-boundary helpers for OpenCode v2 transparent pseudonymization
 * (issue #22, stage 1 — offline mocks only).
 *
 * Source-verified against the installed @opencode/plugin 2.0.19 declarations:
 * `session:http.request` / `session:http.response` expose native `Request` /
 * `Response` objects whose bodies are one-shot streams (clone before reading).
 * The ONLY supported wire protocol is the OpenAI-compatible Chat Completions
 * JSON request body and its JSON / text-event-stream responses.
 *
 * Fail-closed rules implemented here:
 * - Unsupported routes, dialects (e.g. Anthropic-shaped bodies), bodyless
 *   requests and reserved tokens in transport metadata are refused.
 * - Transport metadata is inspected: decoded non-auth headers and query
 *   parameters, and numeric body values, must not scan as sensitive;
 *   legitimate authentication headers are preserved.
 * - The whole body is validated BEFORE any token is issued, then protected in
 *   ONE atomic transaction, so a rejected request commits no mapping or
 *   session capacity.
 * - Protocol metadata (model ids, tools, usage, numeric fields, envelopes) is
 *   never rewritten: structural identifiers (message ids, roles, part types,
 *   tool names and schema keys/enum constraints) are preserved and the request
 *   is refused rather than silently renamed.
 * - Response restore touches assistant display text only: owned tokens are
 *   restored and unknown/malformed marker strings remain literal there. Tokens
 *   in metadata, keys or other unplaceable fields still refuse; actual tool
 *   arguments remain tokenized for the strict tool restoration gate.
 * - Streaming is pull-based with per-event, per-channel and aggregate bounds,
 *   and a terminal choice with an unresolved token refuses.
 */

import {
  PSEUDONYM_TOKEN_PREFIX,
  type PseudonymJsonResult,
  type PseudonymTextResult,
} from "./decision/pseudonymization.js";

/** The masking/detection subset of the pseudonymization core this module needs. */
export interface TransportMaskingService {
  protectJsonForModel(sessionID: string, value: unknown): PseudonymJsonResult;
  restoreText(sessionID: string, text: string): PseudonymTextResult;
  restoreTextForDisplay(sessionID: string, text: string): PseudonymTextResult;
  /** Non-committing sensitivity detection: no mapping, no mutation. */
  detectSensitive(text: string): boolean;
  /**
   * Attachment policy: "block" (default) refuses media/file parts at the
   * wire; "allow" tolerates them as opaque leaves that are substituted with a
   * sentinel around the masking transaction and restored verbatim after it,
   * so binary payloads are neither scanned nor altered.
   */
  readonly attachmentsPolicy?: "block" | "allow";
}

// ─── Static failure messages (no content ever included) ─────────────────────

const UNSUPPORTED_REQUEST_BODY =
  "Sensitive Guard transparent mode blocked a model request with an unsupported or unidentifiable body.";
const UNSUPPORTED_TRANSPORT =
  "Sensitive Guard transparent mode blocked a request on an unsupported model transport route.";
const MASK_FAILURE =
  "Sensitive Guard transparent mode failed to mask a model request.";
const UNSUPPORTED_RESPONSE =
  "Sensitive Guard transparent mode blocked a response it cannot restore safely.";
const RESTORE_FAILURE =
  "Sensitive Guard transparent mode failed to restore a model response.";
const MALFORMED_STREAM =
  "Sensitive Guard transparent mode blocked a malformed or incomplete streaming response.";
const STREAM_BUFFER_LIMIT =
  "Sensitive Guard transparent mode blocked an oversized streaming buffer.";

/**
 * All byte caps are UTF-8 bytes (not UTF-16 code units): the bound is a memory
 * bound, and a code-unit cap would allow up to ~4× the stated bytes for
 * multi-byte text. Each cap is charged BEFORE the value is accumulated.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Unparsed bytes held between newlines. */
const MAX_PENDING_BYTES = 1_048_576;
/** One accumulated (not yet terminated) SSE event. */
const MAX_EVENT_BYTES = 1_048_576;
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
  if (url.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
  try {
    return decodeURIComponent(url).includes(PSEUDONYM_TOKEN_PREFIX);
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
      value.includes(PSEUDONYM_TOKEN_PREFIX) &&
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
    if (key.includes(PSEUDONYM_TOKEN_PREFIX) || strayTokenIn(record[key], [...path, key])) return true;
  }
  return false;
}

// ─── Transport metadata inspection ──────────────────────────────────────────

/**
 * Inspects decoded transport metadata: every non-authentication header and
 * query parameter must be token-free and non-sensitive, and a reserved token
 * in ANY header or query parameter is refused (it could never be restored).
 * Legitimate authentication headers are excluded from content scanning.
 */
function inspectTransportMetadata(service: TransportMaskingService, request: Request): void {
  const url = new URL(request.url);
  for (const [name, value] of url.searchParams) {
    if (name.includes(PSEUDONYM_TOKEN_PREFIX) || value.includes(PSEUDONYM_TOKEN_PREFIX)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
    if (service.detectSensitive(name) || service.detectSensitive(value)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
  for (const [name, value] of request.headers) {
    if (value.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_REQUEST_BODY);
    if (AUTH_HEADER_NAMES.has(name.toLowerCase())) continue;
    if (service.detectSensitive(name) || service.detectSensitive(value)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
}

// ─── Attachment pass-through (allow policy) ─────────────────────────────────

const OPAQUE_ATTACHMENT_SENTINEL = "__sg_opaque_attachment";

/**
 * In "allow" mode, temporarily substitutes every media/file record with a
 * unique sentinel string around the masking transaction, then restores the
 * originals into the protected result: binary payloads are neither scanned
 * nor altered, and the structural checks outside this wrapper see identical
 * attachment records before and after.
 */
function withOpaqueAttachments<T extends Record<string, unknown>>(
  service: TransportMaskingService,
  body: T,
  fn: (input: T) => T,
): T {
  if (service.attachmentsPolicy !== "allow") return fn(body);
  const originals: Array<Record<string, unknown>> = [];
  let counter = 0;
  const isAttachmentRecord = (item: unknown): item is Record<string, unknown> =>
    isRecord(item) && (item.type === "media" || item.type === "file");
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

// ─── Request validation (runs before any issuance) ──────────────────────────

function validateDialect(body: Record<string, unknown>): void {
  // An Anthropic-shaped /v1/messages body carries a top-level system prompt
  // and input_schema tools this OpenAI-specific masker cannot place.
  if (body.system !== undefined) throw new Error(UNSUPPORTED_REQUEST_BODY);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(UNSUPPORTED_REQUEST_BODY);
    for (const tool of body.tools) {
      if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
    }
  }
}

function validateMessages(body: Record<string, unknown>, allowAttachments: boolean): void {
  if (!Array.isArray(body.messages)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
    const content = message.content;
    if (content !== undefined && content !== null && typeof content !== "string") {
      if (!Array.isArray(content)) throw new Error(UNSUPPORTED_REQUEST_BODY);
      for (const part of content) {
        // Attachments and foreign part types must refuse, never pass tokenized
        // or unscanned content through the wire boundary — unless the user
        // explicitly chose the "allow" policy (visible, unscanned pass-through).
        if (allowAttachments && isRecord(part) && (part.type === "media" || part.type === "file")) {
          continue;
        }
        if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
      }
    }
    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined && toolCalls !== null) {
      if (!Array.isArray(toolCalls)) throw new Error(UNSUPPORTED_REQUEST_BODY);
      for (const call of toolCalls) {
        if (
          !isRecord(call) ||
          !isRecord(call.function) ||
          typeof call.function.name !== "string" ||
          typeof call.function.arguments !== "string"
        ) {
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
        try {
          JSON.parse(call.function.arguments);
        } catch {
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
      }
    }
    const functionCall = message.function_call;
    if (functionCall !== undefined && functionCall !== null) {
      if (!isRecord(functionCall) || typeof functionCall.name !== "string" || typeof functionCall.arguments !== "string") {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
      try {
        JSON.parse(functionCall.arguments);
      } catch {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
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
 * input schema (property names, types, required entries, enum values). These
 * must survive masking verbatim; a sensitive or token-bearing one refuses the
 * request rather than being silently renamed.
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
      if (fn.parameters !== undefined) walkStrings(out, fn.parameters);
    }
  }
  if (body.tool_choice !== undefined) walkStrings(out, body.tool_choice);
  if (body.response_format !== undefined) walkStrings(out, body.response_format);
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
  if (urlCarriesToken(request.url)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  inspectTransportMetadata(service, request);
  // A body is required: transport metadata (query, headers) cannot be scanned
  // for arbitrary content, so a bodyless request has no verifiable boundary.
  if (request.body === null) throw new Error(UNSUPPORTED_REQUEST_BODY);

  const raw = await readCappedText(request, MAX_BODY_BYTES, UNSUPPORTED_REQUEST_BODY);
  if (raw.length === 0) throw new Error(UNSUPPORTED_REQUEST_BODY);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
  if (!isRecord(body)) throw new Error(UNSUPPORTED_REQUEST_BODY);

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
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
        transformedArguments.push({ message: messageIndex, call: callIndex });
      }
    }
    if (isRecord(message.function_call)) {
      try {
        message.function_call.arguments = JSON.parse(message.function_call.arguments as string);
      } catch {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
      transformedArguments.push({ message: messageIndex });
    }
  }

  // Structural identifiers and numeric values (now including values inside
  // tool arguments) must be safe BEFORE masking, so no mapping is committed for
  // content we are about to refuse.
  const structuralBefore = collectWireStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (identifier.includes(PSEUDONYM_TOKEN_PREFIX) || service.detectSensitive(identifier)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(UNSUPPORTED_REQUEST_BODY);

  // Atomic protection: one transaction over the whole body.
  const next = withOpaqueAttachments(service, body, (input) => {
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
    throw new Error(UNSUPPORTED_REQUEST_BODY);
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
 * documents, thinking blocks, and any unknown block type refuse — never pass
 * tokenized or unscanned content through the wire boundary.
 */
function validateAnthropicSystem(system: unknown): void {
  if (system === undefined || system === null || typeof system === "string") return;
  if (!Array.isArray(system)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  for (const block of system) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
}

function validateAnthropicContent(content: unknown, allowAttachments: boolean): void {
  if (content === undefined || content === null || typeof content === "string") return;
  if (!Array.isArray(content)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  for (const block of content) {
    if (!isRecord(block)) throw new Error(UNSUPPORTED_REQUEST_BODY);
    if (allowAttachments && (block.type === "media" || block.type === "file")) continue;
    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
        break;
      case "tool_use":
        if (
          typeof block.id !== "string" ||
          typeof block.name !== "string" ||
          !isRecord(block.input)
        ) {
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
        break;
      case "tool_result": {
        if (typeof block.tool_use_id !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
        const inner = block.content;
        if (inner === undefined || inner === null || typeof inner === "string") break;
        if (!Array.isArray(inner)) throw new Error(UNSUPPORTED_REQUEST_BODY);
        for (const part of inner) {
          // Images/documents inside tool results refuse like top-level ones,
          // unless the user explicitly chose the "allow" policy.
          if (allowAttachments && isRecord(part) && (part.type === "media" || part.type === "file")) {
            continue;
          }
          if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
            throw new Error(UNSUPPORTED_REQUEST_BODY);
          }
        }
        break;
      }
      default:
        throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
}

function validateAnthropicDialect(body: Record<string, unknown>, allowAttachments: boolean): void {
  validateAnthropicSystem(body.system);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(UNSUPPORTED_REQUEST_BODY);
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
      if (tool.input_schema !== undefined && !isRecord(tool.input_schema)) {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
    }
  }
  if (!Array.isArray(body.messages)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  for (const message of body.messages) {
    if (!isRecord(message) || typeof message.role !== "string") {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
    validateAnthropicContent(message.content, allowAttachments);
  }
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
  if (urlCarriesToken(request.url)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  inspectTransportMetadata(service, request);
  if (request.body === null) throw new Error(UNSUPPORTED_REQUEST_BODY);

  const raw = await readCappedText(request, MAX_BODY_BYTES, UNSUPPORTED_REQUEST_BODY);
  if (raw.length === 0) throw new Error(UNSUPPORTED_REQUEST_BODY);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
  if (!isRecord(body)) throw new Error(UNSUPPORTED_REQUEST_BODY);

  validateAnthropicDialect(body, attachmentsAllowed(service));

  const originalSerialized = JSON.stringify(body);

  const structuralBefore = collectAnthropicStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (identifier.includes(PSEUDONYM_TOKEN_PREFIX) || service.detectSensitive(identifier)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(UNSUPPORTED_REQUEST_BODY);

  const next = withOpaqueAttachments(service, body, (input) => {
    const masked = service.protectJsonForModel(sessionID, input);
    if (!masked.ok) throw new Error(MASK_FAILURE);
    const value = masked.value;
    if (!isRecord(value)) throw new Error(MASK_FAILURE);
    return value as Record<string, unknown>;
  });

  const structuralAfter = collectAnthropicStructuralStrings(next);
  if (
    structuralAfter.length !== structuralBefore.length ||
    structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
  ) {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
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
 * (string or item array: message | function_call | function_call_output),
 * flat `tools` ({type:"function", name, parameters}). Reasoning items,
 * item references, and unknown types refuse.
 */
function validateResponsesContentParts(content: unknown, allowAttachments: boolean): void {
  if (content === undefined || content === null || typeof content === "string") return;
  if (!Array.isArray(content)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  for (const part of content) {
    if (allowAttachments && isRecord(part) && (part.type === "media" || part.type === "file")) {
      continue;
    }
    if (
      !isRecord(part) ||
      (part.type !== "input_text" && part.type !== "output_text") ||
      typeof part.text !== "string"
    ) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
}

function validateResponsesInputItem(item: unknown, allowAttachments: boolean): void {
  if (typeof item === "string") return;
  if (!isRecord(item)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  switch (item.type) {
    case "message":
      if (typeof item.role !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
      validateResponsesContentParts(item.content, allowAttachments);
      return;
    case "function_call":
      if (typeof item.name !== "string" || typeof item.arguments !== "string") {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
      return;
    case "function_call_output":
      if (typeof item.output !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
      return;
    default:
      // reasoning / item_reference / unknown: cannot verify or place.
      throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
}

function validateResponsesDialect(body: Record<string, unknown>, allowAttachments: boolean): void {
  // A chat-completions/anthropic-shaped body on a /responses route is a
  // mixed dialect this masker cannot place; refuse it explicitly.
  if (body.messages !== undefined || body.system !== undefined) {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
  if (body.instructions !== undefined && typeof body.instructions !== "string") {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error(UNSUPPORTED_REQUEST_BODY);
    for (const tool of body.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") throw new Error(UNSUPPORTED_REQUEST_BODY);
      if (tool.parameters !== undefined && !isRecord(tool.parameters)) {
        throw new Error(UNSUPPORTED_REQUEST_BODY);
      }
    }
  }
  if (body.input !== undefined) {
    if (typeof body.input !== "string") {
      if (!Array.isArray(body.input)) throw new Error(UNSUPPORTED_REQUEST_BODY);
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
      if (item.type === "function_call") pushString(out, item.name);
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
  if (urlCarriesToken(request.url)) throw new Error(UNSUPPORTED_REQUEST_BODY);
  inspectTransportMetadata(service, request);
  if (request.body === null) throw new Error(UNSUPPORTED_REQUEST_BODY);

  const raw = await readCappedText(request, MAX_BODY_BYTES, UNSUPPORTED_REQUEST_BODY);
  if (raw.length === 0) throw new Error(UNSUPPORTED_REQUEST_BODY);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
  }
  if (!isRecord(body)) throw new Error(UNSUPPORTED_REQUEST_BODY);

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
          throw new Error(UNSUPPORTED_REQUEST_BODY);
        }
        transformedArguments.push(index);
      }
    }
  }

  const structuralBefore = collectResponsesStructuralStrings(body);
  for (const identifier of structuralBefore) {
    if (identifier.includes(PSEUDONYM_TOKEN_PREFIX) || service.detectSensitive(identifier)) {
      throw new Error(UNSUPPORTED_REQUEST_BODY);
    }
  }
  let unsafeNumber = false;
  walkNumbers(body, (value) => {
    if (service.detectSensitive(String(value))) unsafeNumber = true;
  });
  if (unsafeNumber) throw new Error(UNSUPPORTED_REQUEST_BODY);

  const next = withOpaqueAttachments(service, body, (input) => {
    const masked = service.protectJsonForModel(sessionID, input);
    if (!masked.ok) throw new Error(MASK_FAILURE);
    const value = masked.value;
    if (!isRecord(value)) throw new Error(MASK_FAILURE);
    return value as Record<string, unknown>;
  });

  const structuralAfter = collectResponsesStructuralStrings(next);
  if (
    structuralAfter.length !== structuralBefore.length ||
    structuralAfter.some((identifier, index) => identifier !== structuralBefore[index])
  ) {
    throw new Error(UNSUPPORTED_REQUEST_BODY);
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
  // Explicit unsupported-response policy: never emit a literal placeholder we
  // cannot place, but do not disturb token-free error/metadata bodies.
  return refuseIfTokenBearing(response);
}

/** Passes an unrestorable response through only when it carries no token. */
async function refuseIfTokenBearing(response: Response): Promise<Response> {
  if (response.body === null) return response;
  const raw = await readCappedText(response, MAX_BODY_BYTES, UNSUPPORTED_RESPONSE);
  if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
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
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (!isRecord(body)) {
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (body.choices === undefined) {
    // Not a chat-completions payload; tokens we cannot place must not leak to
    // display as literal placeholders.
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
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
  // A reserved token anywhere but an intentional tool-argument string is a
  // placeholder we cannot place; refuse rather than emit it literally.
  if (strayTokenIn(body)) throw new Error(UNSUPPORTED_RESPONSE);

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

function restoreDisplayText(service: TransportMaskingService, sessionID: string, text: string): string {
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
 * held tail is either a partial token from its LAST full prefix, or the
 * longest suffix that is a proper prefix of the reserved namespace prefix
 * (e.g. `[SG`): emitting that suffix literally would make the token
 * unrestorable. Complete tokens in the emit portion are restored by the
 * caller through the core (never emitted as literal placeholders).
 */
function splitRestorable(buffered: string): { emit: string; hold: string } {
  const at = buffered.lastIndexOf(PSEUDONYM_TOKEN_PREFIX);
  if (at !== -1) {
    const tail = buffered.slice(at);
    if (!tail.includes("]")) return { emit: buffered.slice(0, at), hold: tail };
  }
  for (let length = PSEUDONYM_TOKEN_PREFIX.length - 1; length >= 1; length--) {
    const partial = PSEUDONYM_TOKEN_PREFIX.slice(0, length);
    if (buffered.endsWith(partial)) {
      return { emit: buffered.slice(0, buffered.length - length), hold: partial };
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
 * before the value is accumulated. A choice whose token is still
 * unresolved at a terminal `finish_reason` refuses, and a choice that keeps
 * producing output after it is terminal refuses. Reading is pull-based: one
 * bounded batch of upstream data is consumed per downstream pull, so an unread
 * consumer never builds an unbounded downstream queue. Errors from the
 * underlying stream propagate; downstream cancellation cancels the underlying
 * reader; any failure cancels the underlying stream and errors the piped
 * stream.
 */
export function createSseRestoreStream(
  service: TransportMaskingService,
  sessionID: string,
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  /** Held-back content tails per choice index (tokens split across events). */
  const channels = new Map<number, string>();
  /** Choice indexes that have already seen a terminal `finish_reason`. */
  const terminalChannels = new Set<number>();
  let totalChannelBytes = 0;
  let pending = "";
  let pendingBytes = 0;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let finished = false;

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
    eventBytes = 0;
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
            // A terminal choice must not leave an unresolved token behind or
            // create unbounded per-choice state.
            if (terminal) {
              if (channels.has(channel)) throw new Error(MALFORMED_STREAM);
              if (!terminalChannels.has(channel) && terminalChannels.size >= MAX_CHANNELS) {
                throw new Error(STREAM_BUFFER_LIMIT);
              }
              terminalChannels.add(channel);
            }
          }
          // A reserved token outside intentional tool arguments cannot be placed.
          if (strayTokenIn(chunk)) throw new Error(UNSUPPORTED_RESPONSE);
          outputLines = emitPayload(JSON.stringify(chunk));
        } else {
          // Usage-only etc.: re-emit the original payload verbatim, but never
          // emit a reserved token we cannot place.
          if (strayTokenIn(chunk)) throw new Error(UNSUPPORTED_RESPONSE);
          outputLines = emitPayload(joined);
        }
      }
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return terminated ? `${text}\n\n` : text;
  };

  const pushLine = (line: string): void => {
    eventBytes += byteLength(line) + 1;
    if (eventBytes > MAX_EVENT_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    eventLines.push(line);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            pendingBytes += byteLength(tail);
            if (pendingBytes > MAX_PENDING_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
            pending += tail;
            if (pending.length > 0) {
              for (const line of pending.split("\n")) pushLine(line);
              pending = "";
              pendingBytes = 0;
            }
            let out = "";
            if (eventLines.length > 0) out += processEvent(false);
            requireEmptyChannels();
            finished = true;
            if (out.length > 0) controller.enqueue(encoder.encode(out));
            controller.close();
            return;
          }
          const decoded = decoder.decode(value, { stream: true });
          const decodedBytes = byteLength(decoded);
          if (pendingBytes + decodedBytes > MAX_PENDING_BYTES) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          pendingBytes += decodedBytes;
          pending += decoded;
          let out = "";
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            pendingBytes -= byteLength(line) + 1;
            if (line === "" || line === "\r") out += processEvent(true);
            else pushLine(line);
            newline = pending.indexOf("\n");
          }
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out));
            return;
          }
          // No complete event yet: keep reading, bounded by the caps above.
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        controller.error(error);
        try {
          await reader.cancel();
        } catch {
          // Underlying stream is already gone; the error above is the outcome.
        }
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

// ─── Anthropic Messages response restore ────────────────────────────────────

/**
 * Token in an Anthropic response may appear ONLY in content-block text
 * (restored below) or inside tool_use.input (deliberately kept tokenized for
 * the typed tool gate). Anywhere else it is a stray that must refuse.
 */
function anthropicStrayTokenIn(body: unknown): boolean {
  if (typeof body === "string") {
    return body.includes(PSEUDONYM_TOKEN_PREFIX);
  }
  if (body === null || typeof body !== "object") return false;
  if (Array.isArray(body)) {
    return body.some((item) => anthropicStrayTokenIn(item));
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
    const value = record[key];
    // content[].text is restored in place before this check runs; a surviving
    // token there was intentionally left by restore failure handling.
    if (key === "content" && Array.isArray(value)) {
      for (const block of value) {
        if (!isRecord(block)) return true;
        if (block.type === "tool_use") {
          if (typeof block.id === "string" && block.id.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
          continue; // input stays tokenized by design
        }
        if (anthropicStrayTokenIn(block)) return true;
      }
      continue;
    }
    if (anthropicStrayTokenIn(value)) return true;
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
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (!isRecord(body)) {
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (body.content === undefined) {
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (!Array.isArray(body.content)) throw new Error(UNSUPPORTED_RESPONSE);

  let changed = false;
  for (const block of body.content) {
    if (!isRecord(block)) throw new Error(UNSUPPORTED_RESPONSE);
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error(UNSUPPORTED_RESPONSE);
      if (block.text.length > 0) {
        block.text = restoreDisplayText(service, sessionID, block.text);
        changed = true;
      }
    }
    // tool_use / other blocks: input stays tokenized until the typed tool gate.
  }
  if (anthropicStrayTokenIn(body)) throw new Error(UNSUPPORTED_RESPONSE);
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
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const channels = new Map<number, string>();
  const terminalBlocks = new Set<number>();
  let totalChannelBytes = 0;
  let pending = "";
  let pendingBytes = 0;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let finished = false;
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
    eventBytes = 0;
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
      if (messageStopped.value) throw new Error(MALFORMED_STREAM);

      switch (chunk.type) {
        case "message_start": {
          const message = chunk.message;
          if (isRecord(message) && Array.isArray(message.content)) {
            for (const block of message.content) {
              if (!isRecord(block)) throw new Error(MALFORMED_STREAM);
              if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                block.text = restoreDisplayText(service, sessionID, block.text);
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
            if (hold === "") deleteChannel(index);
            else setChannel(index, hold);
          }
          // input_json_delta / thinking_delta / signature_delta: untouched.
          break;
        }
        case "content_block_stop": {
          const index = chunk.index;
          if (typeof index !== "number" || !Number.isInteger(index)) throw new Error(MALFORMED_STREAM);
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

      if (anthropicChunkStrayTokenIn(chunk)) throw new Error(UNSUPPORTED_RESPONSE);
      outputLines = emitPayload(JSON.stringify(chunk));
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return terminated ? `${text}\n\n` : text;
  };

  const pushLine = (line: string): void => {
    eventBytes += byteLength(line) + 1;
    if (eventBytes > MAX_EVENT_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    eventLines.push(line);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            pendingBytes += byteLength(tail);
            if (pendingBytes > MAX_PENDING_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
            pending += tail;
            if (pending.length > 0) {
              for (const line of pending.split("\n")) pushLine(line);
              pending = "";
              pendingBytes = 0;
            }
            let out = "";
            if (eventLines.length > 0) out += processEvent(false);
            if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
            finished = true;
            if (out.length > 0) controller.enqueue(encoder.encode(out));
            controller.close();
            return;
          }
          const decoded = decoder.decode(value, { stream: true });
          const decodedBytes = byteLength(decoded);
          if (pendingBytes + decodedBytes > MAX_PENDING_BYTES) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          pendingBytes += decodedBytes;
          pending += decoded;
          let out = "";
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            pendingBytes -= byteLength(line) + 1;
            if (line === "" || line === "\r") out += processEvent(true);
            else pushLine(line);
            newline = pending.indexOf("\n");
          }
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out));
            return;
          }
          // No complete event yet: keep reading, bounded by the caps above.
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        controller.error(error);
        try {
          await reader.cancel();
        } catch {
          // Underlying stream is already gone; the error above is the outcome.
        }
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

/** Stray-token policy for one Anthropic SSE chunk: tokens may live only in
 * text channels (already restored above) and tool_use/input_json payloads. */
function anthropicChunkStrayTokenIn(chunk: Record<string, unknown>): boolean {
  const check = (value: unknown, inToolPayload: boolean): boolean => {
    if (typeof value === "string") {
      return !inToolPayload && value.includes(PSEUDONYM_TOKEN_PREFIX);
    }
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) {
      return value.some((item) => check(item, inToolPayload));
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
      if (key === "partial_json" || key === "input") {
        continue; // tool-argument payloads stay tokenized by design
      }
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
  return refuseIfTokenBearing(response);
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

/** Restores output_text parts inside one Responses output item (in place). */
function restoreResponsesItemText(
  service: TransportMaskingService,
  sessionID: string,
  item: Record<string, unknown>,
): boolean {
  let changed = false;
  const content = item.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (
        isRecord(part) &&
        (part.type === "output_text" || part.type === "input_text") &&
        typeof part.text === "string" &&
        part.text.length > 0
      ) {
        part.text = restoreDisplayText(service, sessionID, part.text);
        changed = true;
      }
    }
  }
  if (typeof item.text === "string" && item.type === "output_text" && item.text.length > 0) {
    item.text = restoreDisplayText(service, sessionID, item.text);
    changed = true;
  }
  return changed;
}

/** Token in a Responses payload may appear only in output/input text (in
 * place before this check) and function_call arguments/output (tool gate). */
function responsesStrayTokenIn(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes(PSEUDONYM_TOKEN_PREFIX);
  }
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => responsesStrayTokenIn(item));
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.includes(PSEUDONYM_TOKEN_PREFIX)) return true;
    // Tool-gate payloads: function_call arguments/output, and SSE delta
    // payloads (output_text deltas are restored in place before this check,
    // so a surviving token under "delta" is a function_call_arguments delta,
    // which stays tokenized by design).
    if (key === "arguments" || key === "output" || key === "delta") continue;
    if (responsesStrayTokenIn(record[key])) return true;
  }
  return false;
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
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (!isRecord(body)) {
    if (raw.includes(PSEUDONYM_TOKEN_PREFIX)) throw new Error(UNSUPPORTED_RESPONSE);
    return response;
  }
  if (body.output_text !== undefined && typeof body.output_text === "string") {
    body.output_text = restoreDisplayText(service, sessionID, body.output_text);
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!isRecord(item)) throw new Error(UNSUPPORTED_RESPONSE);
      restoreResponsesItemText(service, sessionID, item);
      // function_call items stay tokenized for the typed tool gate.
    }
  }
  if (responsesStrayTokenIn(body)) throw new Error(UNSUPPORTED_RESPONSE);
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
  const decoder = new TextDecoder("utf-8");
  const encoder = new TextEncoder();
  const channels = new Map<string, string>();
  let totalChannelBytes = 0;
  let pending = "";
  let pendingBytes = 0;
  let eventLines: string[] = [];
  let eventBytes = 0;
  let finished = false;
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

  const processEvent = (terminated: boolean): string => {
    const lines = eventLines;
    eventLines = [];
    eventBytes = 0;
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
      if (terminal.value) throw new Error(MALFORMED_STREAM);

      const channelKey = (): string => {
        const item = chunk.item_id ?? chunk.id ?? chunk.output_index;
        return typeof item === "string" || typeof item === "number" ? String(item) : "0";
      };

      if (chunk.type === "response.output_text.delta") {
        if (typeof chunk.delta !== "string") throw new Error(MALFORMED_STREAM);
        const key = channelKey();
        if (!channels.has(key) && channels.size >= MAX_CHANNELS) throw new Error(STREAM_BUFFER_LIMIT);
        const held = channels.get(key) ?? "";
        if (byteLength(held) + byteLength(chunk.delta) > MAX_CHANNEL_BYTES) {
          throw new Error(STREAM_BUFFER_LIMIT);
        }
        const buffered = held + chunk.delta;
        const { emit, hold } = splitRestorable(buffered);
        chunk.delta = emit.length === 0 ? "" : restoreDisplayText(service, sessionID, emit);
        if (hold === "") deleteChannel(key);
        else setChannel(key, hold);
      } else if (chunk.type === "response.output_item.added" || chunk.type === "response.output_item.done") {
        const item = chunk.item;
        if (isRecord(item)) restoreResponsesItemText(service, sessionID, item);
      } else if (
        chunk.type === "response.completed" ||
        chunk.type === "response.failed" ||
        chunk.type === "response.incomplete"
      ) {
        if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
        terminal.value = true;
        const response = chunk.response;
        if (isRecord(response) && Array.isArray(response.output)) {
          for (const item of response.output) {
            if (isRecord(item)) restoreResponsesItemText(service, sessionID, item);
          }
        }
      }
      // function_call_arguments deltas, reasoning events, others: untouched.

      if (responsesStrayTokenIn(chunk)) throw new Error(UNSUPPORTED_RESPONSE);
      outputLines = emitPayload(JSON.stringify(chunk));
    }
    const text = outputLines.join("\n");
    if (text.length === 0) return terminated ? "\n" : "";
    return terminated ? `${text}\n\n` : text;
  };

  const pushLine = (line: string): void => {
    eventBytes += byteLength(line) + 1;
    if (eventBytes > MAX_EVENT_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
    eventLines.push(line);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            pendingBytes += byteLength(tail);
            if (pendingBytes > MAX_PENDING_BYTES) throw new Error(STREAM_BUFFER_LIMIT);
            pending += tail;
            if (pending.length > 0) {
              for (const line of pending.split("\n")) pushLine(line);
              pending = "";
              pendingBytes = 0;
            }
            let out = "";
            if (eventLines.length > 0) out += processEvent(false);
            if (channels.size !== 0) throw new Error(MALFORMED_STREAM);
            finished = true;
            if (out.length > 0) controller.enqueue(encoder.encode(out));
            controller.close();
            return;
          }
          const decoded = decoder.decode(value, { stream: true });
          const decodedBytes = byteLength(decoded);
          if (pendingBytes + decodedBytes > MAX_PENDING_BYTES) {
            throw new Error(STREAM_BUFFER_LIMIT);
          }
          pendingBytes += decodedBytes;
          pending += decoded;
          let out = "";
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            pendingBytes -= byteLength(line) + 1;
            if (line === "" || line === "\r") out += processEvent(true);
            else pushLine(line);
            newline = pending.indexOf("\n");
          }
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out));
            return;
          }
        }
      } catch (error) {
        if (finished) return;
        finished = true;
        controller.error(error);
        try {
          await reader.cancel();
        } catch {
          // Underlying stream is already gone; the error above is the outcome.
        }
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
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
  return refuseIfTokenBearing(response);
}

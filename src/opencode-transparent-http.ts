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

function validateMessages(body: Record<string, unknown>): void {
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
        // or unscanned content through the wire boundary.
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
  validateMessages(body);

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
  const masked = service.protectJsonForModel(sessionID, body);
  if (!masked.ok) throw new Error(MASK_FAILURE);
  const next = masked.value;
  if (!isRecord(next)) throw new Error(MASK_FAILURE);

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

/** Native Responses-family WS adapter. Selection is protocol/shape based,
 * never provider-brand based. No network I/O: a synthetic HTTP Request reuses
 * the established metadata admission and atomic Responses body masker.
 * OpenCode exposes no connection ID; attribution uses the hook's session,
 * kind and model lane, then the provider's response ID. */
import {
  admitModelRequest,
  classifyModelRoute,
  remaskResponsesRequest,
  RESPONSES_TEXT_DELTA_TYPES,
  RESPONSES_TEXT_DONE_TYPES,
  restoreDisplayText,
  restoreResponsesEventDisplay,
  splitRestorable,
  type TransportMaskingService,
} from "./opencode-transparent-http.js";

type Event = Record<string, unknown>;
const ROUTE_ERROR = "LeakShield transparent mode blocked an unsupported model transport route.";
const FRAME_ERROR = "LeakShield transparent mode blocked an unsupported or malformed WebSocket frame.";
const ATTRIBUTION_ERROR = "LeakShield transparent mode blocked a WebSocket frame without matching request attribution.";
const LIMIT_ERROR = "LeakShield transparent mode blocked an oversized WebSocket buffer.";
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_LANES = 1024;
const MAX_CHANNELS = 256;
const MAX_CHANNEL_BYTES = 65_536;
const MAX_TOTAL_BYTES = 1_048_576;
const TERMINAL_TYPES = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const record = (value: unknown): value is Event => typeof value === "object" && value !== null && !Array.isArray(value);

interface Lane {
  request: Request;
  restorable: boolean;
  sent: boolean;
  responseID?: string;
  terminal: boolean;
  holds: Map<string, string>;
  counts: Map<string, number>;
}

function laneKey(event: Event): string {
  const model = event.model;
  if (
    typeof event.sessionID !== "string" || !event.sessionID ||
    !["primary", "title", "compaction", "generate"].includes(String(event.kind)) ||
    !record(model) || typeof model.providerID !== "string" || typeof model.id !== "string"
  ) throw new Error(ROUTE_ERROR);
  const key = JSON.stringify([event.sessionID, event.kind, model.providerID, model.id]);
  if (bytes(key) > 4096) throw new Error(LIMIT_ERROR);
  return key;
}

function parseFrame(frame: unknown): Event {
  if (typeof frame !== "string") throw new Error(FRAME_ERROR);
  if (bytes(frame) > MAX_FRAME_BYTES) throw new Error(LIMIT_ERROR);
  let value: unknown;
  try { value = JSON.parse(frame); } catch { throw new Error(FRAME_ERROR); }
  if (!record(value) || typeof value.type !== "string") throw new Error(FRAME_ERROR);
  return value;
}

export function createResponsesWebSocketAdapter(
  service: TransportMaskingService,
  wireProtection: boolean,
  hasProtectedContext: (event: Event) => boolean = () => false,
) {
  const lanes = new Map<string, Lane>();
  let hookOnlyNoticed = false;
  let totalBytes = 0;
  const clearBuffers = (lane: Lane): void => {
    for (const hold of lane.holds.values()) totalBytes -= bytes(hold);
    for (const key of lane.counts.keys()) totalBytes -= bytes(key);
    lane.holds.clear();
    lane.counts.clear();
  };
  const reset = (event: Event): void => {
    const key = laneKey(event);
    const lane = lanes.get(key);
    if (lane) clearBuffers(lane);
    lanes.delete(key);
  };
  const resetRequest = (event: Event): void => {
    laneKey(event); // Validate attribution before invalidating any lane.
    const prefix = `${JSON.stringify([event.sessionID, event.kind]).slice(0, -1)},`;
    for (const [key, lane] of lanes) {
      if (!key.startsWith(prefix)) continue;
      clearBuffers(lane);
      lanes.delete(key);
    }
  };
  const getLane = (event: Event): Lane => {
    const lane = lanes.get(laneKey(event));
    if (!lane) throw new Error(ATTRIBUTION_ERROR);
    return lane;
  };
  return {
    handshake(event: Event): void {
      const key = laneKey(event);
      // Invalidate earlier attribution even if the replacement handshake fails.
      resetRequest(event);
      if (typeof event.url !== "string" || !record(event.headers)) throw new Error(ROUTE_ERROR);
      let url: URL;
      try { url = new URL(event.url); } catch { throw new Error(ROUTE_ERROR); }
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error(ROUTE_ERROR);
      const restorable = classifyModelRoute(url.href) === "openai-responses";
      if (!restorable && (wireProtection || !hasProtectedContext(event))) throw new Error(ROUTE_ERROR);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const headers = new Headers();
      for (const [name, value] of Object.entries(event.headers)) {
        if (typeof value !== "string") throw new Error(ROUTE_ERROR);
        headers.set(name, value);
      }
      const request = admitModelRequest(service, String(event.sessionID), new Request(url, { method: "POST", headers }), !restorable);
      if (lanes.size >= MAX_LANES) {
        const inactive = [...lanes].find(([, lane]) => !lane.sent || lane.terminal);
        if (!inactive) throw new Error(LIMIT_ERROR);
        lanes.delete(inactive[0]);
      }
      lanes.set(key, { request, restorable, sent: false, terminal: false, holds: new Map(), counts: new Map() });
      if (!restorable && !hookOnlyNoticed) {
        hookOnlyNoticed = true;
        console.warn("[leakshield] degraded: unknown WS route admitted with scoped context hooks only; frames are not inspected or restored");
      }
    },
    async send(event: Event): Promise<string> {
      const lane = getLane(event);
      // A rejected retry cannot leave the previous request eligible to receive.
      lane.sent = false;
      clearBuffers(lane);
      if (!lane.restorable) {
        if (!hasProtectedContext(event)) throw new Error(ROUTE_ERROR);
        if (typeof event.frame !== "string") throw new Error(FRAME_ERROR);
        lane.sent = true;
        return event.frame;
      }
      const body = parseFrame(event.frame);
      if (body.type !== "response.create") throw new Error(FRAME_ERROR);
      let frame = String(event.frame);
      if (wireProtection) {
        // Provider continuation IDs are identifiers, not display text. Never
        // remask them into new values, even when they look sensitive.
        const identifiers: Event = {};
        for (const name of ["type", "event_id", "previous_response_id", "conversation"]) {
          if (!(name in body)) continue;
          const value = body[name];
          if (value !== null && (typeof value !== "string" || !service.isStructuralIdentifierSafe(String(event.sessionID), value))) {
            throw new Error(FRAME_ERROR);
          }
          identifiers[name] = value;
          delete body[name];
        }
        const request = new Request(lane.request, { body: JSON.stringify(body) });
        const masked = await remaskResponsesRequest(service, String(event.sessionID), request);
        frame = JSON.stringify({ ...JSON.parse(await masked.text()), ...identifiers });
      }
      if (lanes.get(laneKey(event)) !== lane) throw new Error(ATTRIBUTION_ERROR);
      lane.sent = true;
      lane.terminal = false;
      lane.responseID = undefined;
      return frame;
    },
    receive(event: Event): string {
      const lane = getLane(event);
      if (!lane.restorable) {
        if (typeof event.frame !== "string") throw new Error(FRAME_ERROR);
        return event.frame;
      }
      if (!lane.sent || lane.terminal) throw new Error(ATTRIBUTION_ERROR);
      const chunk = parseFrame(event.frame);
      const type = String(chunk.type);
      const response = record(chunk.response) ? chunk.response : undefined;
      if (type === "response.created") {
        if (lane.responseID !== undefined || typeof response?.id !== "string") throw new Error(ATTRIBUTION_ERROR);
        if (bytes(response.id) > 4096) throw new Error(LIMIT_ERROR);
        lane.responseID = response.id;
      }
      if (type !== "error" && lane.responseID === undefined) throw new Error(ATTRIBUTION_ERROR);
      for (const id of [chunk.response_id, response?.id]) {
        if (id !== undefined && id !== lane.responseID) throw new Error(ATTRIBUTION_ERROR);
      }
      const channel = JSON.stringify([type.replace(/\.(delta|done)$/, ""), chunk.item_id ?? chunk.output_index ?? "0", chunk.content_index ?? chunk.summary_index ?? 0]);
      if (bytes(channel) > 4096) throw new Error(LIMIT_ERROR);
      if (RESPONSES_TEXT_DELTA_TYPES.has(type)) {
        if (typeof chunk.delta !== "string") throw new Error(FRAME_ERROR);
        if (!lane.counts.has(channel) && lane.counts.size >= MAX_CHANNELS) throw new Error(LIMIT_ERROR);
        const previous = lane.holds.get(channel) ?? "";
        if (bytes(previous) + bytes(chunk.delta) > MAX_CHANNEL_BYTES) throw new Error(LIMIT_ERROR);
        const { emit, hold } = splitRestorable(previous + chunk.delta);
        const nextTotal = totalBytes - bytes(previous) + bytes(hold) + (lane.counts.has(channel) ? 0 : bytes(channel));
        if (nextTotal > MAX_TOTAL_BYTES) throw new Error(LIMIT_ERROR);
        chunk.delta = restoreDisplayText(service, String(event.sessionID), emit);
        totalBytes = nextTotal;
        if (hold) lane.holds.set(channel, hold);
        else lane.holds.delete(channel);
        lane.counts.set(channel, (lane.counts.get(channel) ?? 0) + emit.length);
      } else if (RESPONSES_TEXT_DONE_TYPES.has(type)) {
        const held = lane.holds.get(channel);
        // A WS hook replaces ONE frame, unlike SSE's ability to insert an
        // extra delta. Keep done semantics and its complete restored field;
        // malformed providers that omit the final delta get a static notice.
        if (held) {
          console.warn("[leakshield] degraded: WS text ended with an incomplete delta tail; complete done field retained");
          totalBytes -= bytes(held);
          lane.holds.delete(channel);
        }
        if (lane.counts.delete(channel)) totalBytes -= bytes(channel);
      }
      restoreResponsesEventDisplay(service, String(event.sessionID), chunk);
      if (TERMINAL_TYPES.has(type)) {
        if (lane.holds.size) console.warn("[leakshield] degraded: WS terminal frame dropped incomplete placeholder tails");
        clearBuffers(lane);
        lane.terminal = true;
      }
      return JSON.stringify(chunk);
    },
    /** Response-only hook mode. The host event and prepared content scope
     * select the mapping; a provider response.created starts the bounded
     * response/channel state. No handshake, send, or transport gate is used.
     * Errors are caught by the ingress hook and keep frames literal. */
    receiveOnly(event: Event): string {
      if (wireProtection || !hasProtectedContext(event)) throw new Error(ATTRIBUTION_ERROR);
      const key = laneKey(event);
      const chunk = parseFrame(event.frame);
      if (chunk.type === "response.created") {
        const previous = lanes.get(key);
        if (!previous || !previous.sent || previous.terminal) {
          resetRequest(event);
          if (lanes.size >= MAX_LANES) throw new Error(LIMIT_ERROR);
          lanes.set(key, {
            request: new Request("https://hook-only.invalid/v1/responses"),
            restorable: true, sent: true, terminal: false, holds: new Map(), counts: new Map(),
          });
        }
      }
      return this.receive(event);
    },
    /** Keep a validated handshake reusable for the next response, but never
     * restore another frame from a failed response. A held literal prefix can
     * be flushed only into the very same verified text channel/response. */
    abandonResponse(event: Event): string | undefined {
      const lane = lanes.get(laneKey(event));
      if (!lane) return undefined;
      let frame: string | undefined;
      try {
        const chunk = parseFrame(event.frame);
        const id = record(chunk.response) ? chunk.response.id : chunk.response_id;
        if (lane.sent && !lane.terminal && lane.responseID !== undefined && (id === undefined || id === lane.responseID) &&
          RESPONSES_TEXT_DELTA_TYPES.has(String(chunk.type)) && typeof chunk.delta === "string") {
          const channel = JSON.stringify([String(chunk.type).replace(/\.(delta|done)$/, ""), chunk.item_id ?? chunk.output_index ?? "0", chunk.content_index ?? chunk.summary_index ?? 0]);
          const held = lane.holds.get(channel);
          if (held) frame = JSON.stringify({ ...chunk, delta: held + chunk.delta });
        }
      } catch { /* Unparseable/unattributed frames stay byte-for-byte original. */ }
      clearBuffers(lane);
      lane.sent = false;
      lane.terminal = true;
      lane.responseID = undefined;
      return frame;
    },
    reset,
    resetRequest,
    clearSession(sessionID: string): void {
      const prefix = `${JSON.stringify([sessionID]).slice(0, -1)},`;
      for (const [key, lane] of lanes) {
        if (!key.startsWith(prefix)) continue;
        clearBuffers(lane);
        lanes.delete(key);
      }
    },
    dispose(): void {
      lanes.clear();
      totalBytes = 0;
      hookOnlyNoticed = false;
    },
  };
}

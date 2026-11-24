/**
 * In-process provider boundary for pi.
 *
 * pi's provider SDKs resolve `fetch` when they issue a request, so an
 * extension that replaces `globalThis.fetch` sees every model request on the
 * three supported wire APIs. The wrapper sends those requests through the
 * shared guard core, which masks them and restores the assistant text of the
 * reply. Anything that is not provider traffic passes through untouched.
 *
 * The boundary is only as wide as this process: transports that do not use
 * `fetch` (OpenAI Codex over WebSocket, Bedrock, Google service-account auth)
 * are refused by model/API check rather than guarded here.
 */
import { classifyModelRoute } from "../../core/wire.js";
import { createGuardCore, type GuardCore, type GuardPersistenceOptions } from "../../core/session-guard.js";
import type { GuardConfig } from "../../types.js";
import { isSupportedPiApi } from "./settings.js";
import { assertPiToolBoundary, piToolPolicy } from "./tool-policy.js";

export { SUPPORTED_PI_APIS } from "./settings.js";

export const PROTECT_FAILED = "LeakShield could not protect this provider request. [protect]";
export const UNSUPPORTED_ROUTE = "LeakShield refused a provider request on a route it cannot mask. [route]";
export const UNSUPPORTED_MODEL =
  "LeakShield cannot protect the selected model: pi's transport for this API does not go through fetch. Use an openai-completions, openai-responses or anthropic-messages model.";
export const MISSING_SESSION = "LeakShield refused a provider request before a session was active. [session]";

export interface PiGuardModel {
  api: string;
  provider: string;
  id: string;
  baseUrl: string;
}

export interface PiGuard {
  /** The reason the current model cannot be protected, or null. */
  readonly refusal: string | null;
  setSession(sessionID: string | null): void;
  setModel(model: PiGuardModel | null): void;
  /** Handles one fetch call: provider traffic is guarded, everything else passes through. */
  handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Restores placeholders in a pi tool call, refusing unknown tools. */
  restoreTool(tool: string, input: unknown): unknown;
  /** Points globalThis.fetch at this guard. */
  install(): void;
}

export interface PiGuardOptions {
  config: GuardConfig;
  /** Encrypted mapping store; omitted means process-lifetime mappings. */
  persistence?: GuardPersistenceOptions;
  fetchImpl?: typeof fetch;
  createCore?: typeof createGuardCore;
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (typeof init?.method === "string") return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function originOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname.length > 0 ? url.origin : null;
  } catch {
    return null;
  }
}

function refusalText(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("LeakShield ")) return error.message;
  return PROTECT_FAILED;
}

function refusalResponse(message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

export function createPiGuard(options: PiGuardOptions): PiGuard {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const core = (options.createCore ?? createGuardCore)(
    options.config,
    "block",
    true,
    options.persistence,
    { anthropicThinking: "mask" },
    piToolPolicy,
  );
  let sessionID: string | null = null;
  let model: PiGuardModel | null = null;
  let origin: string | null = null;
  let invalidBase = false;

  const refusal = (): string | null => {
    if (core === null) return PROTECT_FAILED;
    if (model === null) return UNSUPPORTED_MODEL;
    if (invalidBase || !isSupportedPiApi(model.api)) return UNSUPPORTED_MODEL;
    return null;
  };

  const guard: PiGuard = {
    get refusal() {
      return refusal();
    },
    setSession(next: string | null) {
      sessionID = next !== null && next.length > 0 ? next : null;
    },
    setModel(next: PiGuardModel | null) {
      model = next;
      origin = next === null ? null : originOf(next.baseUrl);
      invalidBase = next !== null && origin === null;
    },
    async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = urlOf(input);
      const route = classifyModelRoute(url);
      // A model-shaped POST is guarded wherever it goes: a missed or skipped
      // model switch must not fail open just because the origin changed.
      // Other provider-origin routes are classified below (GET passes, an
      // unknown POST is refused).
      let isProvider = route !== null;
      if (!isProvider && origin !== null) {
        try {
          isProvider = new URL(url).origin === origin;
        } catch {
          // An unparsable URL cannot be sent by fetch either; let it surface
          // the native error instead of masking it as a guard refusal.
          return fetchImpl(input, init);
        }
      }
      if (!isProvider) return fetchImpl(input, init);

      // Model catalogs and response lookups are read-only and carry no
      // conversation. They also keep features like OpenRouter's key catalog.
      const method = methodOf(input, init);
      if (method === "GET" || method === "HEAD") return fetchImpl(input, init);

      const reason = refusal() ?? (sessionID === null ? MISSING_SESSION : null);
      if (reason !== null) return refusalResponse(reason);
      if (route === null) return refusalResponse(UNSUPPORTED_ROUTE);

      let request: Request;
      try {
        request = input instanceof Request && init === undefined ? input : new Request(input, init);
      } catch {
        return refusalResponse(PROTECT_FAILED);
      }
      const masked: Record<string, unknown> = { sessionID, request };
      try {
        await (core as GuardCore).onHttpRequest(masked);
      } catch (error) {
        return refusalResponse(refusalText(error));
      }
      const sent = masked.request as Request;
      // Network errors and aborts are not masking failures: propagate them so
      // the SDK keeps its retry/cancel semantics. The request is already masked.
      const response = await fetchImpl(sent);
      const reply: Record<string, unknown> = { sessionID, request: sent, response };
      await (core as GuardCore).onHttpResponse(reply);
      return reply.response as Response;
    },
    restoreTool(tool: string, input: unknown): unknown {
      if (core === null) throw new Error(PROTECT_FAILED);
      if (sessionID === null) throw new Error(MISSING_SESSION);
      assertPiToolBoundary(tool, input);
      const event: Record<string, unknown> = { sessionID, tool, input };
      core.onToolBefore(event);
      return event.input;
    },
    install() {
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => guard.handle(input, init);
    },
  };
  return guard;
}

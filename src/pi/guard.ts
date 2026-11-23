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
import { classifyModelRoute } from "../core/wire.js";
import { createGuardCore, type GuardCore } from "../core/session-guard.js";
import type { GuardConfig } from "../types.js";
import { assertPiToolBoundary, piToolPolicy } from "./tool-policy.js";

export const SUPPORTED_PI_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

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
  readonly core: GuardCore | null;
  /** The reason the current model cannot be protected, or null. */
  readonly refusal: string | null;
  setSession(sessionID: string | null): void;
  setModel(model: PiGuardModel | null): void;
  /** Handles one fetch call: provider traffic is guarded, everything else passes through. */
  handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Restores placeholders in a pi tool call, refusing unknown tools. */
  restoreTool(tool: string, input: unknown): unknown;
  /** Points globalThis.fetch at this guard. Returns the previous implementation. */
  install(): typeof fetch;
  restore(previous: typeof fetch): void;
}

export interface PiGuardOptions {
  config: GuardConfig;
  fetchImpl?: typeof fetch;
  createCore?: typeof createGuardCore;
}

function providerOriginOf(model: PiGuardModel | null): string | null {
  if (model === null) return null;
  try {
    return new URL(model.baseUrl).origin;
  } catch {
    return null;
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
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
    undefined,
    { anthropicThinking: "mask" },
    piToolPolicy,
  );
  let sessionID: string | null = null;
  let model: PiGuardModel | null = null;

  const refusal = (): string | null => {
    if (core === null) return PROTECT_FAILED;
    if (model === null || !SUPPORTED_PI_APIS.has(model.api)) return UNSUPPORTED_MODEL;
    return null;
  };

  const guard = {
    get core() {
      return core;
    },
    get refusal() {
      return refusal();
    },
    setSession(next: string | null) {
      sessionID = next !== null && next.length > 0 ? next : null;
    },
    setModel(next: PiGuardModel | null) {
      model = next;
    },
    async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = urlOf(input);
      const route = classifyModelRoute(url);
      const origin = providerOriginOf(model);
      let isProvider = route !== null;
      if (origin !== null) {
        try {
          isProvider = new URL(url).origin === origin;
        } catch {
          return fetchImpl(input, init);
        }
      }
      if (!isProvider) return fetchImpl(input, init);

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
      let response: Response;
      try {
        response = await fetchImpl(sent);
      } catch {
        return refusalResponse(PROTECT_FAILED);
      }
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
    install(): typeof fetch {
      const previous = globalThis.fetch;
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => guard.handle(input, init);
      return previous;
    },
    restore(previous: typeof fetch) {
      globalThis.fetch = previous;
    },
  } satisfies PiGuard;
  return guard;
}

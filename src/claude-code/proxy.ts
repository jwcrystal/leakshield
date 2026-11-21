/**
 * Claude Code host adapter (issue #86): a loopback HTTP proxy that Claude Code
 * reaches through `ANTHROPIC_BASE_URL`. Anthropic Messages requests are masked
 * by the host-independent core before they leave the machine, and assistant
 * text in JSON and SSE replies is restored before Claude Code shows it.
 *
 * Fail closed: a request the proxy cannot mask (unknown route with a body,
 * unrecognised body shape, masking error) is answered locally with a 400
 * Anthropic-style error and nothing is forwarded. Bodyless GET/HEAD probes
 * (Claude Code sends `HEAD /api/hello`) are forwarded when their URL carries
 * no finding.
 *
 * Not covered here: tool-execution restoration (tool_use input stays
 * tokenized, so Claude Code's tools receive placeholders), and anything
 * Claude Code sends outside the base URL.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { createGuardCore, PROTECT_FAILED_ERROR, type GuardCore } from "../core/session-guard.js";
import { containsTokenPrefix } from "../decision/pseudonymization.js";
import { scanText } from "../scanner/engine.js";
import type { GuardConfig } from "../types.js";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 8787;
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const HEALTH_PATH = "/__leakshield/health";
export const HEALTH_SERVICE = "leakshield-claude-code-proxy";

const SESSION_HEADER = "x-claude-code-session-id";
const SESSION_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;
// Claude Code always sends its session header today; the shared fallback
// keeps one stable mapping if a version stops sending it.
const FALLBACK_SESSION = "claude-code";

const MESSAGES_PATH = /\/v1\/messages\/?$/;
const COUNT_TOKENS_PATH = /\/v1\/messages\/count_tokens\/?$/;

// undici sets its own accept-encoding and decompresses; forwarding the
// client's value would hand the core compressed bytes it cannot read.
const DROP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "accept-encoding",
]);
// The body is decompressed by fetch and may change length during restore.
const DROP_RESPONSE_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "trailer", "upgrade",
]);

const UNSUPPORTED_ROUTE =
  "LeakShield blocked a request on a route the Claude Code proxy cannot mask. [proxy-route]";
const UNSAFE_URL =
  "LeakShield blocked a request whose URL carries sensitive content. [proxy-url]";
const UPSTREAM_UNREACHABLE =
  "LeakShield could not reach the upstream API. [proxy-upstream]";

export interface ClaudeCodeProxyOptions {
  config: GuardConfig;
  upstream?: string;
  attachments?: "block" | "allow";
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface ClaudeCodeProxy {
  readonly upstream: string;
  handle(request: Request, signal?: AbortSignal): Promise<Response>;
  dispose(): void;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** Plain http is accepted only for a loopback upstream (a local stub or gateway). */
export function parseUpstream(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error("upstream must be https (plain http is allowed only on loopback)");
  }
  if (url.search !== "" || url.hash !== "") throw new Error("upstream must not carry a query or fragment");
  return url;
}

function anthropicError(status: number, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sessionOf(request: Request): string {
  const value = request.headers.get(SESSION_HEADER);
  return value !== null && SESSION_ID_SHAPE.test(value) ? value : FALLBACK_SESSION;
}

function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key)) headers.set(key, value);
  });
  return headers;
}

function relay(response: Response, method: string): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key)) headers.set(key, value);
  });
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function urlCarriesFinding(url: URL, config: GuardConfig): boolean {
  let text = url.pathname + url.search;
  try {
    text = decodeURIComponent(text);
  } catch {
    return true;
  }
  return containsTokenPrefix(text) || scanText(text, config).findings.length > 0;
}

/** Static refusal text only: native errors may embed a URL or header value. */
function refusalMessage(error: unknown): string {
  return error instanceof Error && error.message.startsWith("LeakShield ") ? error.message : PROTECT_FAILED_ERROR;
}

export function createClaudeCodeProxy(options: ClaudeCodeProxyOptions): ClaudeCodeProxy {
  const upstream = parseUpstream(options.upstream ?? DEFAULT_UPSTREAM);
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.error(line));
  const core: GuardCore | null = createGuardCore(options.config, options.attachments ?? "block", true, undefined, {
    anthropicThinking: "mask",
  });

  const targetOf = (incoming: URL, pathname = incoming.pathname): URL => {
    const target = new URL(upstream);
    target.pathname = upstream.pathname.replace(/\/+$/, "") + pathname;
    target.search = incoming.search;
    return target;
  };

  const refuse = (method: string, path: string, message: string): Response => {
    log(`[leakshield] blocked ${method} ${path}: ${message}`);
    return anthropicError(400, message);
  };

  const send = async (request: Request, signal?: AbortSignal): Promise<Response | null> => {
    try {
      return await fetchImpl(request, { signal });
    } catch {
      return null;
    }
  };

  const handle = async (request: Request, signal?: AbortSignal): Promise<Response> => {
    const incoming = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = incoming.pathname;

    if (path === HEALTH_PATH && (method === "GET" || method === "HEAD")) {
      return new Response(method === "HEAD" ? null : JSON.stringify({ service: HEALTH_SERVICE, upstream: upstream.origin }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (core === null) return refuse(method, path, PROTECT_FAILED_ERROR);

    const headers = forwardHeaders(request.headers);
    const sessionID = sessionOf(request);

    if (method === "POST" && COUNT_TOKENS_PATH.test(path)) {
      // count_tokens carries the whole conversation in Messages shape. The
      // core masks only a /messages URL, so it masks under that path and the
      // masked body is then sent to the real count_tokens route.
      const event: Record<string, unknown> = {
        sessionID,
        request: new Request(targetOf(incoming, path.replace(/\/count_tokens\/?$/, "")), {
          method, headers, body: request.body, duplex: "half",
        } as RequestInit),
      };
      try {
        await core.onHttpRequest(event);
      } catch (error) {
        return refuse(method, path, refusalMessage(error));
      }
      const masked = event.request as Request;
      const response = await send(new Request(targetOf(incoming), {
        method, headers: masked.headers, body: await masked.arrayBuffer(),
      }), signal);
      return response === null ? anthropicError(502, UPSTREAM_UNREACHABLE) : relay(response, method);
    }

    if (method === "POST" && MESSAGES_PATH.test(path)) {
      const event: Record<string, unknown> = {
        sessionID,
        request: new Request(targetOf(incoming), { method, headers, body: request.body, duplex: "half" } as RequestInit),
      };
      try {
        await core.onHttpRequest(event);
      } catch (error) {
        return refuse(method, path, refusalMessage(error));
      }
      const sent = event.request as Request;
      const response = await send(sent, signal);
      if (response === null) return anthropicError(502, UPSTREAM_UNREACHABLE);
      // Same request object and session as the masking call: the core only
      // restores a reply it can attribute to a request it masked.
      const reply: Record<string, unknown> = { sessionID, request: sent, response };
      await core.onHttpResponse(reply);
      return relay(reply.response as Response, method);
    }

    if ((method === "GET" || method === "HEAD") && request.body === null) {
      if (urlCarriesFinding(incoming, options.config)) return refuse(method, path, UNSAFE_URL);
      const response = await send(new Request(targetOf(incoming), { method, headers }), signal);
      return response === null ? anthropicError(502, UPSTREAM_UNREACHABLE) : relay(response, method);
    }

    return refuse(method, path, UNSUPPORTED_ROUTE);
  };

  return {
    upstream: upstream.toString(),
    handle,
    dispose: () => core?.dispose(),
  };
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

export interface RunningClaudeCodeProxy {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startClaudeCodeProxy(
  options: ClaudeCodeProxyOptions & { port?: number; host?: string },
): Promise<RunningClaudeCodeProxy> {
  const host = options.host ?? DEFAULT_PROXY_HOST;
  if (!isLoopbackHost(host)) throw new Error("the proxy listens on loopback only");
  const proxy = createClaudeCodeProxy(options);

  const server = createServer((req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    void (async () => {
      const method = (req.method ?? "GET").toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";
      const request = new Request(new URL(req.url ?? "/", `http://${host}`), {
        method,
        headers: toHeaders(req.headers),
        body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : null,
        duplex: "half",
      } as RequestInit);
      let response: Response;
      try {
        response = await proxy.handle(request, controller.signal);
      } catch {
        response = anthropicError(500, PROTECT_FAILED_ERROR);
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      if (response.body === null) {
        res.end();
        return;
      }
      const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      // A restore failure mid-stream must cut the connection, not end it
      // cleanly: a clean end would look like a complete reply.
      body.on("error", () => res.destroy());
      body.pipe(res);
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PROXY_PORT, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        proxy.dispose();
      }),
  };
}

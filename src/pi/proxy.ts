/**
 * Loopback provider boundary for the pi coding agent.
 *
 * The verified pi hook surface cannot stop a provider request on its own:
 * `before_provider_request` ignores handler exceptions and continues with the
 * original payload, and compaction/summarization calls bypass it entirely.
 * The enforceable boundary is therefore the transport: pi is launched with a
 * generated configuration whose only provider is this loopback server, and
 * every provider request is masked here before any upstream fetch.
 *
 * The proxy owns the single Core instance for a launch. The extension reaches
 * it over the same authenticated loopback connection for tool restoration and
 * display, so there is one mapping and one session identity.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGuardCore, type GuardCore } from "../core/session-guard.js";
import type { GuardConfig } from "../types.js";
import { assertPiToolBoundary, piToolPolicy } from "./tool-policy.js";

export type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export const PI_SESSION_HEADER = "x-leakshield-session";
export const PI_HEALTH_PATH = "/health";
export const PI_DISPLAY_PATH = "/control/display";
export const PI_TOOL_PATH = "/control/tool";
export const PI_HEALTH_SERVICE = "leakshield-pi";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONTROL_TEXT = 64 * 1024;
const MAX_DISPLAY_TOKENS = 512;
const SESSION_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "x-api-key",
  PI_SESSION_HEADER,
]);

const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-connection",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface PiUpstream {
  /** Full API base, e.g. https://api.anthropic.com or https://api.openai.com/v1. */
  baseUrl: string;
  api: PiApi;
  /** Resolved upstream credential. The pi child never receives it. */
  apiKey: string;
  headers?: Readonly<Record<string, string>>;
}

export interface PiProxyOptions {
  config: GuardConfig;
  upstream: PiUpstream;
  /** Model ids pi may request. Empty means "any non-empty model string". */
  models?: readonly string[];
  host?: string;
  port?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface PiProxy {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  /** Test seam: runs one request without a socket. */
  handle(request: Request): Promise<Response>;
  close(): Promise<void>;
}

const PROTECT_FAILED = "LeakShield refused the provider request because masking did not complete. [protect]";
const UNSUPPORTED_ROUTE = "LeakShield refused an unsupported provider route. [route]";
const UNSUPPORTED_MODEL = "LeakShield refused an unconfigured model. [model]";
const UNREADABLE_BODY = "LeakShield refused a provider request whose body could not be read as JSON. [body]";
const UNAUTHORIZED = "LeakShield refused an unauthenticated loopback request. [auth]";
const MISSING_SESSION = "LeakShield refused a request without a pi session identity. [session]";
const UPSTREAM_REDIRECT =
  "LeakShield refused an upstream redirect; following it would resend the request outside the configured provider. [redirect]";
const UPSTREAM_UNREACHABLE = "LeakShield could not reach the configured provider. [upstream]";
const CONTROL_INVALID = "LeakShield refused an invalid local control request. [control]";

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** Plain http is accepted only for a loopback upstream (a local stub or gateway). */
export function parsePiUpstream(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("pi upstream must be https (plain http is allowed only on loopback)");
  }
  if (url.search !== "" || url.hash !== "") throw new Error("pi upstream must not carry a query or fragment");
  if (url.username !== "" || url.password !== "") throw new Error("pi upstream must not carry credentials");
  return url;
}

function errorBody(api: PiApi, message: string): string {
  if (api === "anthropic-messages") {
    return JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } });
  }
  return JSON.stringify({ error: { type: "invalid_request_error", message } });
}

function refusalStatus(message: string): number {
  if (message === UNAUTHORIZED) return 401;
  if (message === UPSTREAM_UNREACHABLE) return 502;
  return 400;
}

function refusalMessage(error: unknown): string {
  return error instanceof Error && error.message.startsWith("LeakShield ") ? error.message : PROTECT_FAILED;
}

function sessionOf(request: Request): string | null {
  const value = request.headers.get(PI_SESSION_HEADER);
  return value !== null && SESSION_SHAPE.test(value) ? value : null;
}

function credentialOf(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (value !== null) {
    const match = /^Bearer ([A-Za-z0-9._-]{16,})$/.exec(value);
    if (match?.[1] !== undefined) return match[1];
  }
  // pi's Anthropic provider sends the configured apiKey as x-api-key, not as
  // a Bearer token; both identify the same loopback credential.
  const key = request.headers.get("x-api-key");
  if (key !== null && /^[A-Za-z0-9._-]{16,}$/.test(key)) return key;
  return null;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(request: Request): Promise<string | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(step.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function canonicalJsonBody(request: Request): Promise<string | null> {
  const raw = await readBody(request).catch(() => null);
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return null;
  }
}

function relayHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!DROP_RESPONSE_HEADERS.has(key)) headers.set(key, value);
  });
  return headers;
}

function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (!DROP_REQUEST_HEADERS.has(key)) headers.set(key, value);
  });
  return headers;
}

function routeMatches(api: PiApi, pathname: string): boolean {
  const suffix =
    api === "openai-completions" ? "/chat/completions" : api === "openai-responses" ? "/responses" : "/messages";
  return pathname.endsWith(suffix);
}

function targetOf(base: URL, incoming: URL): URL {
  const target = new URL(base);
  const basePath = base.pathname.replace(/\/+$/, "");
  const incomingPath = incoming.pathname;
  target.pathname =
    basePath !== "" && !incomingPath.startsWith(`${basePath}/`) ? `${basePath}${incomingPath}` : incomingPath;
  // pi's providers add request parameters (for example Anthropic's ?beta=true).
  // The host is fixed by the launcher, so the query cannot redirect the call.
  target.search = incoming.search;
  target.hash = "";
  return target;
}

function parseControlDisplay(value: unknown): { text?: string; tokens?: string[] } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { text?: unknown; tokens?: unknown };
  if (typeof record.text === "string" && record.text.length <= MAX_CONTROL_TEXT) return { text: record.text };
  if (Array.isArray(record.tokens)) {
    if (record.tokens.length === 0 || record.tokens.length > MAX_DISPLAY_TOKENS) return null;
    const tokens: string[] = [];
    for (const token of record.tokens) {
      if (typeof token !== "string" || token.length === 0 || token.length > 256) return null;
      tokens.push(token);
    }
    return { tokens };
  }
  return null;
}

function parseControlTool(value: unknown): { tool: string; input: unknown } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const tool = (value as { tool?: unknown }).tool;
  const input = (value as { input?: unknown }).input;
  if (typeof tool !== "string" || tool.length === 0 || tool.length > 128) return null;
  if (input === undefined) return null;
  return { tool, input };
}

interface BuiltProxy {
  proxy: PiProxy;
  attach(server: Server, port: number): void;
}

function buildProxy(options: PiProxyOptions): BuiltProxy {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopback(host)) throw new Error("the pi proxy must listen on a loopback address");
  const upstreamBase = parsePiUpstream(options.upstream.baseUrl);
  const api = options.upstream.api;
  const models = new Set((options.models ?? []).map((model) => model.trim()).filter((model) => model.length > 0));
  const fetchImpl = options.fetch ?? fetch;
  const log = options.log ?? ((line: string) => console.error(line));
  const token = randomBytes(32).toString("hex");
  const core: GuardCore | null = createGuardCore(options.config, "block", true, undefined, {
    anthropicThinking: "mask",
  }, piToolPolicy);

  let server: Server | null = null;
  let port = 0;

  const refuse = (message: string): Response =>
    new Response(errorBody(api, message), {
      status: refusalStatus(message),
      headers: { "content-type": "application/json" },
    });

  /**
   * The Core restores text only through a paired request/response it has seen.
   * A synthetic Chat Completions pair keeps that attribution intact and stays
   * independent of the upstream's dialect.
   */
  const restoreText = async (sessionID: string, text: string): Promise<string> => {
    if (core === null) return text;
    const event: Record<string, unknown> = {
      sessionID,
      request: new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "leakshield-control", messages: [{ role: "user", content: "display" }] }),
      }),
    };
    await core.onHttpRequest(event);
    event.response = Response.json({ choices: [{ message: { role: "assistant", content: text } }] });
    await core.onHttpResponse(event);
    const restored = (await (event.response as Response).json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = restored.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : text;
  };

  const control = async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return refuse(UNSUPPORTED_ROUTE);
    const sessionID = sessionOf(request);
    if (sessionID === null) return refuse(MISSING_SESSION);
    const body = await canonicalJsonBody(request);
    if (body === null) return refuse(CONTROL_INVALID);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return refuse(CONTROL_INVALID);
    }
    const pathname = new URL(request.url).pathname;
    if (pathname === PI_DISPLAY_PATH) {
      const display = parseControlDisplay(parsed);
      if (display === null) return refuse(CONTROL_INVALID);
      try {
        if (display.tokens !== undefined) {
          const texts: string[] = [];
          for (const token of display.tokens) texts.push(await restoreText(sessionID, token));
          return Response.json({ texts });
        }
        return Response.json({ text: await restoreText(sessionID, display.text ?? "") });
      } catch {
        return display.tokens !== undefined
          ? Response.json({ texts: display.tokens })
          : Response.json({ text: display.text ?? "" });
      }
    }
    if (core === null) return refuse(PROTECT_FAILED);
    const tool = parseControlTool(parsed);
    if (tool === null) return refuse(CONTROL_INVALID);
    try {
      assertPiToolBoundary(tool.tool, tool.input);
      const event: Record<string, unknown> = { sessionID, tool: tool.tool, input: tool.input };
      core.onToolBefore(event);
      return Response.json({ input: event.input });
    } catch (error) {
      log(`[leakshield] refused tool ${tool.tool}: ${refusalMessage(error)}`);
      return refuse(refusalMessage(error));
    }
  };

  const provider = async (request: Request): Promise<Response> => {
    const incoming = new URL(request.url);
    if (request.method !== "POST" || !routeMatches(api, incoming.pathname)) {
      log(`[leakshield] blocked ${request.method} provider route`);
      return refuse(UNSUPPORTED_ROUTE);
    }
    if (core === null) return refuse(PROTECT_FAILED);
    const sessionID = sessionOf(request);
    if (sessionID === null) return refuse(MISSING_SESSION);
    const body = await canonicalJsonBody(request);
    if (body === null) return refuse(UNREADABLE_BODY);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return refuse(UNREADABLE_BODY);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return refuse(UNREADABLE_BODY);
    const model = (payload as { model?: unknown }).model;
    if (typeof model !== "string" || model.length === 0 || model.length > 256) return refuse(UNSUPPORTED_MODEL);
    if (models.size > 0 && !models.has(model)) return refuse(UNSUPPORTED_MODEL);

    const headers = forwardHeaders(request.headers);
    headers.set("content-type", "application/json");
    if (api === "anthropic-messages") {
      headers.set("x-api-key", options.upstream.apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${options.upstream.apiKey}`);
    }
    for (const [name, value] of Object.entries(options.upstream.headers ?? {})) headers.set(name, value);

    const event: Record<string, unknown> = {
      sessionID,
      request: new Request(targetOf(upstreamBase, incoming), { method: "POST", headers, body }),
    };
    try {
      await core.onHttpRequest(event);
    } catch (error) {
      log(`[leakshield] blocked provider request: ${refusalMessage(error)}`);
      return refuse(refusalMessage(error));
    }
    const masked = event.request as Request;
    let upstream: Response;
    try {
      upstream = await fetchImpl(masked, { redirect: "manual", signal: request.signal });
    } catch {
      return refuse(UPSTREAM_UNREACHABLE);
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      void upstream.body?.cancel().catch(() => {});
      log("[leakshield] blocked upstream redirect");
      return refuse(UPSTREAM_REDIRECT);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: relayHeaders(upstream.headers),
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if ((request.method === "GET" || request.method === "HEAD") && pathname === PI_HEALTH_PATH) {
      return new Response(
        request.method === "HEAD"
          ? null
          : JSON.stringify({ service: PI_HEALTH_SERVICE, upstream: upstreamBase.origin, api }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const credential = credentialOf(request);
    if (credential === null || !sameSecret(credential, token)) return refuse(UNAUTHORIZED);
    if (pathname === PI_DISPLAY_PATH || pathname === PI_TOOL_PATH) return control(request);
    return provider(request);
  };

  const proxy: PiProxy = {
    get url() {
      const display = host.startsWith("[") ? host : host.includes(":") ? `[${host}]` : host;
      return `http://${display}:${port}`;
    },
    get port() {
      return port;
    },
    token,
    handle,
    async close() {
      core?.dispose();
      const running = server;
      server = null;
      if (running !== null) await new Promise<void>((resolve) => running.close(() => resolve()));
    },
  };

  return {
    proxy,
    attach(next, nextPort) {
      server = next;
      port = nextPort;
    },
  };
}

export function createPiProxy(options: PiProxyOptions): PiProxy {
  return buildProxy(options).proxy;
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : null,
    // A streaming request body is half-duplex in Node's fetch implementation.
    duplex: "half",
    signal,
  } as RequestInit);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as never), res);
}

export async function startPiProxy(options: PiProxyOptions): Promise<PiProxy> {
  const { proxy, attach } = buildProxy(options);
  const server = createServer((req, res) => {
    const controller = new AbortController();
    // `IncomingMessage` also emits "close" after a normal body read, so abort
    // only when the response ends early (client gone) or the request aborts.
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const fail = () => {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end();
    };
    void proxy
      .handle(toRequest(req, controller.signal))
      .then((response) => writeResponse(res, response))
      .catch(fail);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("pi proxy did not get a TCP address");
  }
  attach(server, address.port);
  return proxy;
}

// Component under test: the pi extension surface (src/pi/extension.ts),
// exercised against a real loopback boundary and a fake pi ExtensionAPI.
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import leakshieldPiExtension, {
  PI_LAUNCH_TOKEN_ENV,
  PI_LAUNCH_URL_ENV,
  readExtensionConfig,
  type PiContext,
} from "../src/pi/extension.js";
import { PI_SESSION_HEADER, startPiProxy, type PiProxy } from "../src/pi/proxy.js";

const SECRET = ["PI", "EXT", "SECRET"].join("_");
const UNKNOWN = ["[SGP2", ":API_KEY-aaaa-bbbb-cccc]"].join("");
const SESSION = "pi-extension-session";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`);

const config = (() => {
  const base = loadConfig(undefined, process.cwd());
  return { ...base, nda_keywords: [SECRET], private_domains: [], custom_rules: [] };
})();

type Handler = (event: unknown, ctx: PiContext) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  let transformer: ((markdown: string) => string) | null = null;
  let transformerOptions: { messageTypes?: string[] } | undefined;
  return {
    api: {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerMarkdownTransformer(transform: (markdown: string) => string, options?: { messageTypes?: string[] }) {
        transformer = transform;
        transformerOptions = options;
      },
    },
    async emit(event: string, payload: unknown, ctx: PiContext) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, ctx);
        if (next !== undefined) result = next;
      }
      return result;
    },
    transform(markdown: string) {
      if (transformer === null) throw new Error("no transformer registered");
      return transformer(markdown);
    },
    get transformerOptions() {
      return transformerOptions;
    },
  };
}

function context(ui?: { notify(message: string, level?: string): void }, entries: unknown = []): PiContext {
  return {
    sessionManager: { getSessionId: () => SESSION, getEntries: () => entries },
    hasUI: ui !== undefined,
    ui,
  };
}

const started: PiProxy[] = [];

function useBoundary(proxy: PiProxy): void {
  process.env[PI_LAUNCH_URL_ENV] = proxy.url;
  process.env[PI_LAUNCH_TOKEN_ENV] = proxy.token;
}

async function boundary(): Promise<{ proxy: PiProxy; upstreamBody: () => string }> {
  let body = "";
  const proxy = await startPiProxy({
    config,
    upstream: { baseUrl: "https://api.example.test/v1", api: "openai-completions", apiKey: "sk-upstream-test" },
    models: ["stub-model"],
    fetch: (async (input: Request) => {
      body = await input.text();
      return Response.json({ ok: true });
    }) as unknown as typeof fetch,
    port: 0,
    log: () => {},
  });
  started.push(proxy);
  useBoundary(proxy);
  return { proxy, upstreamBody: () => body };
}

async function mint(proxy: PiProxy, upstreamBody: () => string): Promise<string> {
  const response = await proxy.handle(
    new Request(`${proxy.url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${proxy.token}`,
        [PI_SESSION_HEADER]: SESSION,
      },
      body: JSON.stringify({ model: "stub-model", messages: [{ role: "user", content: `use ${SECRET}` }] }),
    }),
  );
  expect(response.status).toBe(200);
  const token = TOKEN.exec(upstreamBody())?.[0];
  if (token === undefined) throw new Error("no token reached the fake upstream");
  return token;
}

afterEach(async () => {
  delete process.env[PI_LAUNCH_URL_ENV];
  delete process.env[PI_LAUNCH_TOKEN_ENV];
  while (started.length > 0) await (started.pop() as PiProxy).close();
});

describe("pi extension configuration", () => {
  it("accepts only a loopback endpoint with a plausible token", () => {
    expect(readExtensionConfig({})).toBeNull();
    expect(readExtensionConfig({ [PI_LAUNCH_URL_ENV]: "http://127.0.0.1:1", [PI_LAUNCH_TOKEN_ENV]: "short" })).toBeNull();
    expect(readExtensionConfig({ [PI_LAUNCH_URL_ENV]: "https://example.test", [PI_LAUNCH_TOKEN_ENV]: "a".repeat(32) })).toBeNull();
    expect(readExtensionConfig({ [PI_LAUNCH_URL_ENV]: "http://10.0.0.1:1", [PI_LAUNCH_TOKEN_ENV]: "a".repeat(32) })).toBeNull();
    const ok = readExtensionConfig({ [PI_LAUNCH_URL_ENV]: "http://127.0.0.1:4321", [PI_LAUNCH_TOKEN_ENV]: "a".repeat(32) });
    expect(ok?.origin.port).toBe("4321");
  });
});

describe("pi extension unmanaged mode", () => {
  it("refuses input and every tool call instead of pretending to protect", async () => {
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const notices: string[] = [];
    const ctx = context({ notify: (message) => notices.push(message) });

    expect(await pi.emit("input", { source: "interactive", text: "hello" }, ctx)).toEqual({ action: "handled" });
    expect(await pi.emit("tool_call", { toolName: "read", input: { path: "a.txt" } }, ctx)).toMatchObject({
      block: true,
      terminate: true,
    });
    await pi.emit("session_start", {}, ctx);
    expect(notices[0]).toContain("leakshield pi");
    // Extension-injected messages stay allowed so the host can surface errors.
    expect(await pi.emit("input", { source: "extension", text: "x" }, ctx)).toEqual({ action: "continue" });
  });
});

describe("pi extension managed mode", () => {
  it("binds the session header and restores tool arguments at the local boundary", async () => {
    const { proxy, upstreamBody } = await boundary();
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const token = await mint(proxy, upstreamBody);

    const headers: Record<string, string | null> = {};
    await pi.emit("before_provider_headers", { headers }, context());
    expect(headers[PI_SESSION_HEADER]).toBe(SESSION);

    const input = { path: `${token}.txt` };
    expect(await pi.emit("tool_call", { toolName: "read", input }, context())).toBeUndefined();
    expect(input).toEqual({ path: `${SECRET}.txt` });

    const writeInput = { path: "out.txt", content: `v=${token}` };
    expect(await pi.emit("tool_call", { toolName: "write", input: writeInput }, context())).toBeUndefined();
    expect(writeInput).toEqual({ path: "out.txt", content: `v=${SECRET}` });
  });

  it("blocks a tool call when the boundary refuses it or is unreachable", async () => {
    const { proxy, upstreamBody } = await boundary();
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    const token = await mint(proxy, upstreamBody);

    const unknown = { text: token };
    const blocked = await pi.emit("tool_call", { toolName: "mcp__remote__send", input: unknown }, context());
    expect(blocked).toMatchObject({ block: true });
    expect(unknown.text).toBe(token);

    await proxy.close();
    const offline = await pi.emit("tool_call", { toolName: "read", input: { path: "a.txt" } }, context());
    expect(offline).toMatchObject({ block: true });
  });

  it("restores placeholders in assistant display only, never in stored messages", async () => {
    const { proxy, upstreamBody } = await boundary();
    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    expect(pi.transformerOptions).toEqual({ messageTypes: ["assistant", "assistant-thinking"] });
    const token = await mint(proxy, upstreamBody);
    const stored = `your value is ${token}`;

    const message = { role: "assistant", content: [{ type: "text", text: stored }] };
    await pi.emit("message_end", { message }, context());
    expect(pi.transform(stored)).toBe(`your value is ${SECRET}`);
    // The stored message is untouched: only rendering substitutes.
    expect(message.content[0]?.text).toBe(stored);
    expect(pi.transform("plain text")).toBe("plain text");
    expect(pi.transform(`unknown ${UNKNOWN}`)).toBe(`unknown ${UNKNOWN}`);
  });

  it("seeds display substitutions from a resumed session's saved entries", async () => {
    const { proxy, upstreamBody } = await boundary();
    const token = await mint(proxy, upstreamBody);

    const pi = fakePi();
    leakshieldPiExtension(pi.api);
    await pi.emit("session_start", {}, context(undefined, [{ role: "assistant", content: `earlier ${token}` }]));
    expect(pi.transform(`earlier ${token}`)).toBe(`earlier ${SECRET}`);
  });
});

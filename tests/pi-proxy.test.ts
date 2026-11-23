// Component under test: the loopback provider boundary for pi
// (src/pi/proxy.ts). The upstream is a fake fetch, so every assertion is about
// exactly what a provider would have received.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import {
  createPiProxy,
  PI_DISPLAY_PATH,
  PI_HEALTH_PATH,
  PI_SESSION_HEADER,
  PI_TOOL_PATH,
  type PiApi,
  type PiProxy,
} from "../src/pi/proxy.js";
import type { GuardConfig } from "../src/types.js";

const SECRET = ["PI", "PROXY", "SECRET"].join("_");
const UPSTREAM_KEY = "sk-upstream-synthetic";
const TOKEN = new RegExp(`${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&")}[^\\]]+\\]`);
const TOKEN_G = new RegExp(TOKEN.source, "g");
const quiet = () => {};

function testConfig(overrides: Partial<GuardConfig["settings"]> = {}): GuardConfig {
  const base = loadConfig(undefined, process.cwd());
  return {
    ...base,
    nda_keywords: [SECRET],
    private_domains: [],
    custom_rules: [],
    settings: { ...base.settings, encoding_detection: true, ...overrides },
  };
}

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function fakeUpstream(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: Request) => {
    const record = { url: input.url, method: input.method, headers: input.headers, body: await input.text() };
    sent.push(record);
    return answer(record);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function makeProxy(options: {
  api?: PiApi;
  baseUrl?: string;
  models?: string[];
  config?: GuardConfig;
  fetch: typeof fetch;
}): PiProxy {
  return createPiProxy({
    config: options.config ?? testConfig(),
    upstream: {
      baseUrl: options.baseUrl ?? "https://api.example.test/v1",
      api: options.api ?? "openai-completions",
      apiKey: UPSTREAM_KEY,
    },
    models: options.models ?? ["stub-model"],
    fetch: options.fetch,
    log: quiet,
  });
}

function proxyRequest(
  proxy: PiProxy,
  path: string,
  body: unknown,
  options: { session?: string | null; token?: string; raw?: string } = {},
): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${options.token ?? proxy.token}`,
  };
  const session = options.session === undefined ? "session-a" : options.session;
  if (session !== null) headers[PI_SESSION_HEADER] = session;
  return new Request(`http://127.0.0.1:9999${path}`, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

function chatBody(text: string): unknown {
  return { model: "stub-model", messages: [{ role: "user", content: text }], stream: true };
}

describe("pi provider boundary", () => {
  it("masks Chat Completions requests and injects the upstream credential", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(
      proxyRequest(proxy, "/chat/completions", chatBody(`use ${SECRET} please`)),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    const upstream = sent[0] as Sent;
    expect(upstream.url).toBe("https://api.example.test/v1/chat/completions");
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(upstream.headers.get(PI_SESSION_HEADER)).toBeNull();
    expect(upstream.body).not.toContain(SECRET);
    expect(upstream.body).toMatch(TOKEN);
    expect(JSON.parse(upstream.body).messages[0].content).toMatch(TOKEN);
    await proxy.close();
  });

  it("does not duplicate a base path pi already sends", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    await proxy.handle(proxyRequest(proxy, "/v1/chat/completions", chatBody(`use ${SECRET}`)));
    expect((sent[0] as Sent).url).toBe("https://api.example.test/v1/chat/completions");
    await proxy.close();
  });

  it("masks Anthropic Messages system and user content", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ api: "anthropic-messages", baseUrl: "https://api.example.test", fetch: fetchImpl });
    const response = await proxy.handle(
      proxyRequest(proxy, "/messages", {
        model: "stub-model",
        max_tokens: 64,
        system: `system says ${SECRET}`,
        messages: [{ role: "user", content: [{ type: "text", text: `user says ${SECRET}` }] }],
      }),
    );
    expect(response.status).toBe(200);
    const upstream = sent[0] as Sent;
    expect(upstream.url).toBe("https://api.example.test/messages");
    expect(upstream.headers.get("x-api-key")).toBe(UPSTREAM_KEY);
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.body).not.toContain(SECRET);
    expect((upstream.body.match(TOKEN_G) ?? []).length).toBeGreaterThanOrEqual(2);
    await proxy.close();
  });

  it("masks OpenAI Responses input", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ api: "openai-responses", fetch: fetchImpl });
    const response = await proxy.handle(
      proxyRequest(proxy, "/responses", {
        model: "stub-model",
        input: [{ role: "user", content: [{ type: "input_text", text: `use ${SECRET}` }] }],
      }),
    );
    expect(response.status).toBe(200);
    expect((sent[0] as Sent).url).toBe("https://api.example.test/v1/responses");
    expect((sent[0] as Sent).body).not.toContain(SECRET);
    await proxy.close();
  });

  it("masks summarization and background-shaped requests on the same route", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ api: "anthropic-messages", baseUrl: "https://api.example.test", fetch: fetchImpl });
    // Compaction sends a serialized conversation through the ordinary route.
    const transcript = `Summarize this conversation:\nuser: rotate ${SECRET}\nassistant: ok`;
    const response = await proxy.handle(
      proxyRequest(proxy, "/messages", {
        model: "stub-model",
        max_tokens: 2048,
        messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
      }),
    );
    expect(response.status).toBe(200);
    expect((sent[0] as Sent).body).not.toContain(SECRET);
    await proxy.close();
  });

  it("refuses unauthenticated, unbound and unknown-model requests without an upstream call", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody("hi"), { token: "x".repeat(40) }))).status).toBe(401);
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody("hi"), { session: null }))).status).toBe(400);
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", { model: "other-model", messages: [] }))).status).toBe(400);
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", { messages: [] }))).status).toBe(400);
    expect(sent).toHaveLength(0);
    await proxy.close();
  });

  it("accepts the loopback credential as x-api-key for Anthropic", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ api: "anthropic-messages", baseUrl: "https://api.example.test", fetch: fetchImpl });
    const response = await proxy.handle(
      new Request("http://127.0.0.1:9999/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": proxy.token,
          [PI_SESSION_HEADER]: "session-a",
        },
        body: JSON.stringify({ model: "stub-model", max_tokens: 8, messages: [{ role: "user", content: `use ${SECRET}` }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(sent[0]?.headers.get("x-api-key")).toBe(UPSTREAM_KEY);
    expect(sent[0]?.body).not.toContain(SECRET);
    await proxy.close();
  });

  it("forwards provider query parameters without changing the host", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(
      proxyRequest(proxy, "/chat/completions?beta=true", chatBody(`use ${SECRET}`)),
    );
    expect(response.status).toBe(200);
    expect(sent[0]?.url).toBe("https://api.example.test/v1/chat/completions?beta=true");
    await proxy.close();
  });

  it("refuses unsupported routes and malformed bodies", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    expect((await proxy.handle(proxyRequest(proxy, "/embeddings", { model: "stub-model", input: "x" }))).status).toBe(400);
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", null, { raw: "{not json" }))).status).toBe(400);
    expect((await proxy.handle(proxyRequest(proxy, "/chat/completions", []))).status).toBe(400);
    expect(
      (await proxy.handle(proxyRequest(proxy, "/chat/completions", { model: "stub-model", messages: [] }, { raw: "" })))
        .status,
    ).toBe(400);
    expect(sent).toHaveLength(0);
    await proxy.close();
  });

  it("refuses a non-loopback listen host", () => {
    expect(() =>
      createPiProxy({
        config: testConfig(),
        upstream: { baseUrl: "https://api.example.test/v1", api: "openai-completions", apiKey: UPSTREAM_KEY },
        models: ["stub-model"],
        host: "0.0.0.0",
        fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
        log: quiet,
      }),
    ).toThrow("loopback");
  });

  it("fails closed when masking fails", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({
      config: testConfig({ max_chars: 32 }),
      fetch: fetchImpl,
    });
    const response = await proxy.handle(
      proxyRequest(proxy, "/chat/completions", chatBody(`${"a".repeat(80)} ${SECRET}`)),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("could not be masked safely");
    expect(sent).toHaveLength(0);
    await proxy.close();
  });

  it("refuses an upstream redirect instead of relaying it", async () => {
    const { sent, fetchImpl } = fakeUpstream(
      () => new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }),
    );
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody(`use ${SECRET}`)));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(1);
    await proxy.close();
  });

  it("reports upstream failure without falling back", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => {
      throw new Error("offline");
    });
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody(`use ${SECRET}`)));
    expect(response.status).toBe(502);
    expect(sent).toHaveLength(1);
    await proxy.close();
  });

  it("streams the upstream body as it arrives", async () => {
    let releaseSecond: (() => void) | null = null;
    const second = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        await second;
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody(`use ${SECRET}`)));
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    (releaseSecond as (() => void) | null)?.();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toContain("second");
    await proxy.close();
  });
});

describe("pi control endpoints", () => {
  async function minted(proxy: PiProxy, fetchImpl: typeof fetch, sent: Sent[]): Promise<string> {
    await proxy.handle(proxyRequest(proxy, "/chat/completions", chatBody(`use ${SECRET}`)));
    void fetchImpl;
    const token = TOKEN.exec(sent[0]?.body ?? "")?.[0];
    if (token === undefined) throw new Error("no token reached the upstream");
    return token;
  }

  it("restores a placeholder for local display only", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const token = await minted(proxy, fetchImpl, sent);
    const response = await proxy.handle(proxyRequest(proxy, PI_DISPLAY_PATH, { text: `value ${token}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: `value ${SECRET}` });
    const batch = await proxy.handle(proxyRequest(proxy, PI_DISPLAY_PATH, { tokens: [token, "literal"] }));
    expect(await batch.json()).toEqual({ texts: [SECRET, "literal"] });
    await proxy.close();
  });

  it("keeps a foreign session's token literal", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const token = await minted(proxy, fetchImpl, sent);
    const response = await proxy.handle(
      proxyRequest(proxy, PI_DISPLAY_PATH, { text: `value ${token}` }, { session: "session-b" }),
    );
    expect(await response.json()).toEqual({ text: `value ${token}` });
    await proxy.close();
  });

  it("restores read, write and edit tool inputs", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const token = await minted(proxy, fetchImpl, sent);

    const read = await proxy.handle(proxyRequest(proxy, PI_TOOL_PATH, { tool: "read", input: { path: `${token}.txt` } }));
    expect(await read.json()).toEqual({ input: { path: `${SECRET}.txt` } });

    const write = await proxy.handle(
      proxyRequest(proxy, PI_TOOL_PATH, { tool: "write", input: { path: "out.txt", content: `v=${token}` } }),
    );
    expect(await write.json()).toEqual({ input: { path: "out.txt", content: `v=${SECRET}` } });

    const edit = await proxy.handle(
      proxyRequest(proxy, PI_TOOL_PATH, {
        tool: "edit",
        input: { path: "f.txt", edits: [{ oldText: "a", newText: token }] },
      }),
    );
    expect(await edit.json()).toEqual({ input: { path: "f.txt", edits: [{ oldText: "a", newText: SECRET }] } });
    await proxy.close();
  });

  it("refuses unknown tools, unsafe shell positions and invalid control bodies", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const token = await minted(proxy, fetchImpl, sent);
    const unknown = await proxy.handle(
      proxyRequest(proxy, PI_TOOL_PATH, { tool: "mcp__remote__send", input: { text: token } }),
    );
    expect(unknown.status).toBe(400);
    const embedded = await proxy.handle(
      proxyRequest(proxy, PI_TOOL_PATH, { tool: "bash", input: { command: `cat ${token}.txt` } }),
    );
    expect(embedded.status).toBe(400);
    const invalid = await proxy.handle(proxyRequest(proxy, PI_TOOL_PATH, { tool: "", input: {} }));
    expect(invalid.status).toBe(400);
    const noSession = await proxy.handle(
      proxyRequest(proxy, PI_TOOL_PATH, { tool: "read", input: { path: "a" } }, { session: null }),
    );
    expect(noSession.status).toBe(400);
    await proxy.close();
  });

  it("serves health without exposing the credential", async () => {
    const { fetchImpl } = fakeUpstream(() => Response.json({ ok: true }));
    const proxy = makeProxy({ fetch: fetchImpl });
    const response = await proxy.handle(new Request(`http://127.0.0.1:9999${PI_HEALTH_PATH}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.service).toBe("leakshield-pi");
    expect(body.upstream).toBe("https://api.example.test");
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_KEY);
    expect(JSON.stringify(body)).not.toContain(proxy.token);
    await proxy.close();
  });
});

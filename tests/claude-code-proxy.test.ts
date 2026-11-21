// Component under test: the Claude Code proxy adapter (src/claude-code/proxy.ts).
// The upstream is a fake fetch (or, in the last block, a loopback HTTP
// server) that records exactly what would have reached Anthropic.
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeProxy, parseUpstream, startClaudeCodeProxy, HEALTH_PATH } from "../src/claude-code/proxy.js";
import { loadConfig } from "../src/config/loader.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";

const CANARY = "sk-proj-Q7vR2mX9pL4kT8wN3zB6yH1cF5dJ0sGa";
const escaped = PSEUDONYM_TOKEN_PREFIX_V2.replace(/[[\]]/g, "\\$&");
const TOKEN = new RegExp(`${escaped}[A-Z_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`);
const config = loadConfig(undefined, process.cwd());
const quiet = () => {};

interface Sent {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

function fakeUpstream(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: Request) => {
    const record = { method: input.method, url: input.url, headers: input.headers, body: await input.text() };
    sent.push(record);
    return answer(record);
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

function messagesRequest(body: unknown, session = "sess-1", path = "/v1/messages?beta=true"): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-api03-synthetic", "x-claude-code-session-id": session },
    body: JSON.stringify(body),
  });
}

const userTurn = (text: string) => ({
  model: "claude-test",
  max_tokens: 64,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

function sseOf(events: Array<[string, unknown]>): Response {
  const text = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "gzip" } });
}

function echoTokenStream(sent: Sent): Response {
  const token = sent.body.match(TOKEN)?.[0] ?? "none";
  const reply = `your key is ${token}.`;
  const cut = reply.indexOf(PSEUDONYM_TOKEN_PREFIX_V2) + 8;
  return sseOf([
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [], model: "c" } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(0, cut) } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.slice(cut) } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" } }],
    ["message_stop", { type: "message_stop" }],
  ]);
}

describe("Claude Code proxy: masking", () => {
  it("masks a Messages request before forwarding it to the upstream", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest(userTurn(`my key is ${CANARY}`)));
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent[0].body).not.toContain(CANARY);
    expect(sent[0].body).toMatch(TOKEN);
    expect(sent[0].headers.get("x-api-key")).toBe("sk-ant-api03-synthetic");
    expect(sent[0].headers.get("accept-encoding")).toBeNull();
    proxy.dispose();
  });

  it("restores the placeholder in a streamed reply and drops the upstream encoding header", async () => {
    const { fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest(userTurn(`my key is ${CANARY}`)));
    expect(response.headers.get("content-encoding")).toBeNull();
    const text = await response.text();
    expect(text).toContain(CANARY);
    expect(text).not.toMatch(TOKEN);
    proxy.dispose();
  });

  it("restores the placeholder in a JSON reply", async () => {
    const { fetchImpl } = fakeUpstream((sent) => new Response(JSON.stringify({
      id: "m", type: "message", role: "assistant", model: "c",
      content: [{ type: "text", text: `key ${sent.body.match(TOKEN)?.[0]}` }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const body = await (await proxy.handle(messagesRequest(userTurn(`my key is ${CANARY}`)))).json();
    expect(body.content[0].text).toBe(`key ${CANARY}`);
    proxy.dispose();
  });

  it("keeps one placeholder per value across requests of the same session", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    await (await proxy.handle(messagesRequest(userTurn(`a ${CANARY}`)))).text();
    await (await proxy.handle(messagesRequest(userTurn(`b ${CANARY}`)))).text();
    expect(sent[0].body.match(TOKEN)?.[0]).toBe(sent[1].body.match(TOKEN)?.[0]);
    proxy.dispose();
  });

  it("accepts Claude Code's thinking history and forwards the signature verbatim", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest({
      model: "claude-test",
      max_tokens: 64,
      messages: [
        { role: "user", content: [{ type: "text", text: `key ${CANARY}` }] },
        { role: "system", content: "mid-conversation note" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "read it", signature: "c2lnbmF0dXJl" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat notes.txt" } },
          ],
        },
        { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: `deploy key: ${CANARY}`, is_error: false }] },
      ],
    }));
    expect(response.status).toBe(200);
    expect(sent[0].body).not.toContain(CANARY);
    expect(JSON.parse(sent[0].body).messages[2].content[0].signature).toBe("c2lnbmF0dXJl");
    proxy.dispose();
  });

  it("masks count_tokens and sends it to the count_tokens route", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => new Response(JSON.stringify({ input_tokens: 5 }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest(userTurn(`key ${CANARY}`), "s", "/v1/messages/count_tokens?beta=true"));
    expect(await response.json()).toEqual({ input_tokens: 5 });
    expect(sent[0].url).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
    expect(sent[0].body).not.toContain(CANARY);
    expect(sent[0].body).toMatch(TOKEN);
    proxy.dispose();
  });

  it("keeps an upstream path prefix", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, upstream: "https://gateway.example/anthropic/", log: quiet });
    await (await proxy.handle(messagesRequest(userTurn("hello")))).text();
    expect(sent[0].url).toBe("https://gateway.example/anthropic/v1/messages?beta=true");
    proxy.dispose();
  });
});

describe("Claude Code proxy: fail closed", () => {
  it("blocks an unrecognised Messages body without forwarding anything", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest({ model: "c", messages: `raw ${CANARY}` }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.type).toBe("error");
    expect(body.error.message).toMatch(/^LeakShield blocked/);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("blocks a content block type it cannot mask", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest({
      model: "c", max_tokens: 8,
      messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "x", name: "web_search", input: { query: CANARY } }] }],
    }));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("blocks a body on a route it does not know", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest(userTurn(`key ${CANARY}`), "s", "/v1/files"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("[proxy-route]");
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("forwards a bodyless probe but blocks one whose URL carries a finding", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => new Response(null, { status: 200 }));
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const hello = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello", { method: "HEAD" }));
    expect(hello.status).toBe(200);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual(["HEAD https://api.anthropic.com/api/hello"]);
    const leaky = await proxy.handle(new Request(`http://127.0.0.1:8787/api/x?k=${CANARY}`));
    expect(leaky.status).toBe(400);
    expect(sent).toHaveLength(1);
    proxy.dispose();
  });

  it("blocks a bodyless probe whose headers carry a finding", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => new Response(null, { status: 200 }));
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello", {
      method: "HEAD", headers: { "x-custom": CANARY, "x-api-key": "sk-ant-api03-synthetic" },
    }));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("blocks a bodyless probe whose header name carries a finding", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => new Response(null, { status: 200 }));
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello", {
      method: "HEAD", headers: { [CANARY]: "present" },
    }));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("blocks a Messages request whose path carries a finding, without logging the path", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const lines: string[] = [];
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: (line) => lines.push(line) });
    const response = await proxy.handle(messagesRequest(userTurn("hello"), "s", `/${CANARY}/v1/messages`));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(lines.join("\n")).not.toContain(CANARY);
    proxy.dispose();
  });

  it("forwards the bytes it scanned, not bytes that parse differently", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const clean = JSON.stringify(userTurn("hello"));
    const raw = `{"messages":[{"role":"user","content":"${CANARY}"}],${clean.slice(1)}`;
    const response = await proxy.handle(new Request("http://127.0.0.1:8787/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: raw,
    }));
    await response.text();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).not.toContain(CANARY);
    proxy.dispose();
  });

  it("refuses an upstream redirect instead of relaying it", async () => {
    let init: RequestInit | undefined;
    const fetchImpl = (async (_input: Request, options?: RequestInit) => {
      init = options;
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v1/messages" } });
    }) as unknown as typeof fetch;
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    for (const request of [
      new Request("http://127.0.0.1:8787/api/hello"),
      messagesRequest(userTurn(`key ${CANARY}`)),
    ]) {
      const response = await proxy.handle(request);
      expect(init?.redirect).toBe("manual");
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect((await response.json()).error.message).toContain("[proxy-redirect]");
    }
    proxy.dispose();
  });

  it("keeps every set-cookie", async () => {
    const fetchImpl = (async () => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      return new Response(null, { status: 200, headers });
    }) as unknown as typeof fetch;
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello"));
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    proxy.dispose();
  });

  it("does not let metadata opt itself out with an ignore directive", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const probe = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello", {
      headers: { "x-note": `${CANARY} sg-ignore` },
    }));
    expect(probe.status).toBe(400);
    const post = await proxy.handle(messagesRequest(userTurn("hello"), "s", `/${CANARY}/sg-ignore/v1/messages`));
    expect(post.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("refuses metadata whose scan would be truncated", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const small = { ...config, settings: { ...config.settings, max_chars: 64 } };
    const proxy = createClaudeCodeProxy({ config: small, fetch: fetchImpl, log: quiet });
    const padding = "a".repeat(80);
    const probe = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello", { headers: { "x-note": `${padding} ${CANARY}` } }));
    expect(probe.status).toBe(400);
    const post = await proxy.handle(messagesRequest(userTurn("hi"), "s", `/${padding}/${CANARY}/v1/messages`));
    expect(post.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("scans form-decoded query parameters", async () => {
    const { sent, fetchImpl } = fakeUpstream(() => new Response(null, { status: 200 }));
    const proxy = createClaudeCodeProxy({
      config: { ...config, nda_keywords: ["Project Nightfall"] },
      fetch: fetchImpl,
      log: quiet,
    });
    const response = await proxy.handle(new Request("http://127.0.0.1:8787/api/hello?note=Project+Nightfall"));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("answers its health probe locally", async () => {
    const { sent, fetchImpl } = fakeUpstream(echoTokenStream);
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(new Request(`http://127.0.0.1:8787${HEALTH_PATH}`));
    expect(await response.json()).toEqual({ service: "leakshield-claude-code-proxy", upstream: "https://api.anthropic.com" });
    expect(sent).toHaveLength(0);
    proxy.dispose();
  });

  it("returns 502 without detail when the upstream is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect failed for ${CANARY}`);
    }) as unknown as typeof fetch;
    const proxy = createClaudeCodeProxy({ config, fetch: fetchImpl, log: quiet });
    const response = await proxy.handle(messagesRequest(userTurn("hello")));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(CANARY);
    proxy.dispose();
  });

  it("accepts plain http only for a loopback upstream", () => {
    expect(() => parseUpstream("http://api.example.com")).toThrow();
    expect(parseUpstream("http://127.0.0.1:9999").port).toBe("9999");
    expect(parseUpstream("https://api.example.com").hostname).toBe("api.example.com");
  });
});

describe("Claude Code proxy over HTTP", () => {
  let upstream: Server | undefined;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
    close = undefined;
  });

  it("survives a malformed request target and keeps serving", async () => {
    const running = await startClaudeCodeProxy({ config, port: 0, log: quiet });
    close = running.close;
    const port = Number(new URL(running.url).port);
    const firstLine = await new Promise<string>((resolve) => {
      const socket = netConnect(port, "127.0.0.1", () => socket.write("GET //[/ HTTP/1.1\r\nHost: x\r\n\r\n"));
      let out = "";
      socket.on("data", (d) => (out += d));
      socket.on("close", () => resolve(out.split("\r\n")[0]));
      socket.on("error", () => resolve(""));
      setTimeout(() => socket.destroy(), 1000);
    });
    expect(firstLine).toContain("400");
    const health = await fetch(`${running.url}${HEALTH_PATH}`);
    expect(health.status).toBe(200);
  });

  it("streams a masked request out and a restored reply back", async () => {
    const received: string[] = [];
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push(body);
        const reply = echoTokenStream({ method: "POST", url: "", headers: new Headers(), body });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(await reply.text());
      });
    });
    await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", () => resolve()));
    const port = (upstream.address() as AddressInfo).port;
    const running = await startClaudeCodeProxy({ config, port: 0, upstream: `http://127.0.0.1:${port}`, log: quiet });
    close = running.close;

    const response = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": "s-http", "accept-encoding": "gzip, br" },
      body: JSON.stringify({ ...userTurn(`key ${CANARY}`), stream: true }),
    });
    const text = await response.text();
    expect(received).toHaveLength(1);
    expect(received[0]).not.toContain(CANARY);
    expect(received[0]).toMatch(TOKEN);
    expect(text).toContain(CANARY);
    expect(text).not.toMatch(TOKEN);
  });
});

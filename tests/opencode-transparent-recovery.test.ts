import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransparentSessionGuard } from "../src/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const EMAIL = "alice.canary@example-test.invalid";
const config: GuardConfig = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: true },
};
const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.dispose();
  vi.restoreAllMocks();
});

async function arm(wireProtection: boolean) {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
    hooks.set(`${domain}:${name}`, callback);
    return { dispose: async () => {} };
  };
  const guard = createTransparentSessionGuard(config, "block", wireProtection);
  guards.push(guard);
  await guard.setup({ session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") }, aisdk: { hook: hookFor("aisdk") } } as never);
  // Model the host emitting an event: absent outbound hooks leave it alone.
  const call = async (name: string, event: unknown) => {
    const callback = hooks.get(name);
    if (callback) return callback(event);
    if (!wireProtection && ["session:http.request", "session:experimental.ws.handshake", "session:experimental.ws.send", "aisdk:sdk", "aisdk:language"].includes(name)) return;
    throw new Error(`missing hook ${name}`);
  };
  const route = { sessionID: "s", kind: "primary", model: { providerID: "gateway", id: "model-a" } };
  const prepare = async (extra = {}) => {
    const event = { ...route, system: [], messages: [{ role: "user", content: [{ type: "text", text: EMAIL }] }], options: {}, ...extra };
    await call("session:context", event);
    return event.messages[0].content[0].text;
  };
  return { call, route, prepare };
}

function source(chunks: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
  });
}

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const protocols = [
  {
    name: "chat", path: "/v1/chat/completions",
    body: (token: string) => ({ messages: [{ role: "user", content: token }] }),
    delta: (text: string, index = 0) => sse({ choices: [{ index, delta: { content: text } }] }),
    terminal: () => "data: [DONE]\r\n\r\n",
    error: () => sse({ error: { message: "synthetic provider failure", code: "canary_failure" } }),
  },
  {
    name: "anthropic", path: "/v1/messages",
    body: (token: string) => ({ messages: [{ role: "user", content: token }] }),
    delta: (text: string, index = 0) => sse({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
    terminal: () => sse({ type: "message_stop" }),
    error: () => sse({ type: "error", error: { type: "api_error", message: "synthetic provider failure" } }),
  },
  {
    name: "responses", path: "/v1/responses",
    body: (token: string) => ({ input: token }),
    delta: (text: string, index = 0) => sse({ type: "response.output_text.delta", item_id: `item_${index}`, content_index: 0, delta: text }),
    terminal: () => sse({ type: "response.completed", response: { id: "r", output: [] } }),
    error: () => sse({ type: "error", code: "canary_failure", message: "synthetic provider failure" }),
  },
];

describe.each(protocols)("$name ingress recovery", (protocol) => {
  it("releases the exact original bytes on invalid UTF-8, without replacement characters", async () => {
    const { call, route } = await arm(true);
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body("safe")) }) };
    await call("session:http.request", event);
    const bytes = new Uint8Array([...new TextEncoder().encode("data: "), 0xff, ...new TextEncoder().encode("\r\n\r\n" + protocol.terminal())]);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    const reply = { ...event, response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    expect(new Uint8Array(await reply.response.arrayBuffer())).toEqual(bytes);
  });

  it("bounds retained fragment bookkeeping without losing an unterminated event", async () => {
    const { call, route } = await arm(true);
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body("safe")) }) };
    await call("session:http.request", event);
    const chunks = ["data: ", ...Array.from({ length: 4100 }, () => "x"), "\r\n\r\n", protocol.terminal()];
    const raw = chunks.join("");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reply = { ...event, response: new Response(source(chunks), { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    expect(await reply.response.text()).toBe(raw);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("delivers a provider error immediately even when text is held and upstream remains open", async () => {
    const { call, route, prepare } = await arm(true);
    const token = await prepare();
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body(token)) }) };
    await call("session:http.request", event);
    const held = protocol.delta(token.slice(0, 12));
    const error = protocol.error();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(held + error)); }, cancel,
    });
    const reply = { ...event, response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    const reader = reply.response.body!.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const first = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("SG withheld a provider error")), 200);
      })]);
      expect(new TextDecoder().decode(first.value)).toBe(held);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(error);
      expect(cancel).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); await reader.cancel(); }
  });

  it.each([false, true])("retains unresolved original tails at a terminal boundary (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body(token)) }) };
    await call("session:http.request", event);
    const raw = protocol.delta(`before ${token.slice(0, 12)}`) + protocol.terminal();
    const reply = { ...event, response: new Response(source([raw]), { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    expect(await reply.response.text()).toBe(raw);
  });

  it.each([false, true])("keeps held and interleaved frames in exact order after parser failure (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body(token)) }) };
    await call("session:http.request", event);
    const complete = protocol.delta(`café ${token} ☕`);
    const held = protocol.delta(`pending ${token.slice(0, 12)}`);
    const interleaved = protocol.delta(`different channel ${token}`, 1);
    const rest = held + interleaved + "data: {bad JSON}\r\n\r\n" + protocol.delta(token.slice(12)) + protocol.terminal();
    const bytes = new TextEncoder().encode(complete + rest);
    let at = 0;
    // Split UTF-8, CRLF, delimiters and placeholder prefixes across chunks.
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (at === bytes.length) controller.close();
      else { const end = Math.min(at + (at % 13 + 1), bytes.length); controller.enqueue(bytes.slice(at, end)); at = end; }
    } });
    const reply = { ...event, response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    const output = await reply.response.text();
    expect(output).toContain(`café ${EMAIL} ☕`);
    expect(output.endsWith(rest)).toBe(true);
    expect(output.split(EMAIL)).toHaveLength(2);
  });

  it("forwards consumer cancellation after degradation to the original source", async () => {
    const { call, route } = await arm(true);
    const event = { ...route, request: new Request(`https://gateway.example${protocol.path}`, { method: "POST", body: JSON.stringify(protocol.body("safe")) }) };
    await call("session:http.request", event);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: {bad JSON}\r\n\r\n")); }, cancel,
    });
    const reply = { ...event, response: new Response(stream, { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    const reader = reply.response.body!.getReader();
    await reader.read();
    expect(cancel).not.toHaveBeenCalled();
    const reason = new DOMException("synthetic abort", "AbortError");
    await reader.cancel(reason);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  });
});

describe("experience-first response recovery", () => {
  it.each([false, true])("keeps an HTTP reply literal when the model identity changed (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: token }) }) };
    await call("session:http.request", event);
    const response = new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } });
    const reply = { ...event, model: { ...route.model, id: "other-model" }, response };
    await call("session:http.response", reply);
    expect(reply.response).toBe(response);
    expect(await reply.response.text()).not.toContain(EMAIL);
  });

  it.each([false, true])("recovers the next WS request, but does not restart restoration midway through a failed reply (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    await call("session:experimental.ws.handshake", { ...route, url: "wss://gateway.example/v1/responses", headers: {} });
    const send = () => call("session:experimental.ws.send", { ...route, frame: JSON.stringify({ type: "response.create", input: token }) });
    const receive = async (frame: string) => {
      const event = { ...route, frame };
      await call("session:experimental.ws.receive", event);
      return event.frame;
    };
    await send();
    await receive(JSON.stringify({ type: "response.created", response: { id: "r1" } }));
    expect(await receive("unparseable provider extension")).toBe("unparseable provider extension");
    const raw = JSON.stringify({ type: "response.output_text.delta", response_id: "r1", delta: token });
    expect(await receive(raw)).toBe(raw);
    await send();
    await receive(JSON.stringify({ type: "response.created", response: { id: "r2" } }));
    expect(JSON.parse(await receive(JSON.stringify({ type: "response.output_text.delta", response_id: "r2", delta: token }))).delta).toBe(EMAIL);
    const error = JSON.stringify({ type: "error", code: "canary_error", message: "synthetic provider failure" });
    expect(await receive(error)).toBe(error);
  });

  it("flushes a held WS literal only into the same verified response/text channel on a size-limit failure", async () => {
    const { call, route, prepare } = await arm(true);
    const token = await prepare();
    await call("session:experimental.ws.handshake", { ...route, url: "wss://gateway.example/v1/responses", headers: {} });
    await call("session:experimental.ws.send", { ...route, frame: JSON.stringify({ type: "response.create", input: token }) });
    await call("session:experimental.ws.receive", { ...route, frame: JSON.stringify({ type: "response.created", response: { id: "r" } }) });
    await call("session:experimental.ws.receive", { ...route, frame: JSON.stringify({ type: "response.output_text.delta", response_id: "r", item_id: "item", delta: token.slice(0, 12) }) });
    const largeDelta = "中".repeat(22_000);
    const event = { ...route, frame: JSON.stringify({ type: "response.output_text.delta", response_id: "r", item_id: "item", delta: largeDelta }) };
    await call("session:experimental.ws.receive", event);
    expect(JSON.parse(event.frame).delta).toBe(token.slice(0, 12) + largeDelta);
    expect(event.frame).not.toContain(EMAIL);
  });

  it.each([false, true])("does not reproduce the reported missing-attribution WS refusal (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = await prepare();
    // Existing socket / lost send registration: context ran, but the adapter
    // never saw this socket's handshake/send. This drives the reported hook.
    const frame = JSON.stringify({ type: "response.output_text.delta", delta: token });
    const event = { ...route, frame };
    await expect(call("session:experimental.ws.receive", event)).resolves.toBeUndefined();
    expect(event.frame).toBe(frame);
    expect(event.frame).not.toContain(EMAIL);
    await call("session:experimental.ws.receive", event);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(token);
    expect(warn.mock.calls.flat().join(" ")).not.toContain(EMAIL);
  });

  it.each([false, true])("does not use another session's HTTP attribution to restore a reply (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: token }) }) };
    await call("session:http.request", event);
    const response = new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } });
    const reply = { ...event, sessionID: "other", response };
    await expect(call("session:http.response", reply)).resolves.toBeUndefined();
    expect(reply.response).toBe(response);
    expect(await reply.response.text()).toContain(token);
  });

  it.each([false, true])("passes an unsupported JSON response through without pretending restoration succeeded (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request("https://gateway.example/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: token }] }) }) };
    await call("session:http.request", event);
    const raw = JSON.stringify({ choices: "provider extension", content: token });
    const response = new Response(raw, { headers: { "content-type": "application/json" } });
    const reply = { ...event, response };
    await call("session:http.response", reply);
    expect(reply.response).toBe(response);
    expect(await reply.response.text()).toBe(raw);
  });

  it.each([false, true])("recovers SSE after an incomplete token without losing, duplicating or cross-restoring content (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const token = await prepare();
    const event = { ...route, request: new Request("https://gateway.example/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: token }] }) }) };
    await call("session:http.request", event);
    const data = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\r\n\r\n`;
    const complete = data(`first ${token}`);
    const held = data(`second ${token.slice(0, 12)}`);
    const malformed = "data: {broken JSON}\r\n\r\n";
    const last = data(token.slice(12)) + "data: [DONE]\r\n\r\n";
    const reply = { ...event, response: new Response(source([complete, held, malformed, last]), { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    const output = await reply.response.text();
    expect(output.match(new RegExp(EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(output).toContain(held + malformed + last);
    expect(output.indexOf(EMAIL)).toBeLessThan(output.indexOf(held));
  });

  it("degrades a too-large SSE event without canceling its remaining original data", async () => {
    const { call, route } = await arm(true);
    const event = { ...route, request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: "safe" }) }) };
    await call("session:http.request", event);
    const raw = "data: " + "x".repeat(1_048_600) + "\n\n";
    const tail = "data: [DONE]\n\n";
    const reply = { ...event, response: new Response(source([raw, tail]), { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    expect(await reply.response.text()).toBe(raw + tail);
  });

  it("keeps upstream stream errors and cancellation as failures, not successful replies", async () => {
    const { call, route } = await arm(true);
    const event = { ...route, request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: "safe" }) }) };
    await call("session:http.request", event);
    const error = new Error("synthetic upstream failure");
    const reply = { ...event, response: new Response(new ReadableStream({ pull() { throw error; } }), { headers: { "content-type": "text/event-stream" } }) };
    await call("session:http.response", reply);
    await expect(reply.response.text()).rejects.toBe(error);
  });
});

describe("hook-only outbound passthrough and scoped ingress", () => {
  it.each([
    { hook: "context", kind: "primary" },
    { hook: "title", kind: "title" },
    { hook: "compaction", kind: "compaction" },
    { hook: "generate", kind: "generate" },
  ])("uses the named $hook hook, not an absent context event.kind, to establish $kind coverage", async ({ hook, kind }) => {
    const { call, route } = await arm(false);
    const { kind: _absentKind, ...identity } = route;
    const prepared = { ...identity, system: [EMAIL], messages: [{ role: "user", content: [{ type: "text", text: EMAIL }] }], options: {} };
    await call(`session:${hook}`, prepared);
    const event = { ...identity, kind, request: new Request("https://gateway.example/alpha/generate", { method: "POST", body: JSON.stringify(prepared.messages) }) };
    await expect(call("session:http.request", event)).resolves.toBeUndefined();
    expect(await event.request.clone().text()).not.toContain(EMAIL);
    const otherKind = kind === "primary" ? "title" : "primary";
    await expect(call("session:http.request", { ...event, kind: otherKind })).resolves.toBeUndefined();
  });

  it("leaves unknown HTTP routes untouched, regardless of context proof", async () => {
    const { call, route, prepare } = await arm(false);
    const request = () => new Request("https://gateway.example/alpha/generate", { method: "POST", body: "synthetic opaque envelope" });
    await expect(call("session:http.request", { ...route, request: request() })).resolves.toBeUndefined();
    await prepare();
    const event = { ...route, request: request() };
    await expect(call("session:http.request", event)).resolves.toBeUndefined();
    const response = new Response("opaque reply");
    const reply = { ...event, response };
    await call("session:http.response", reply);
    expect(reply.response).toBe(response);
    for (const extra of [{ sessionID: "other" }, { kind: "title" }, { model: { ...route.model, id: "model-b" } }]) {
      await expect(call("session:http.request", { ...route, ...extra, request: request() })).resolves.toBeUndefined();
    }
  });

  it("keeps unknown routes and sensitive transport metadata refused with wire protection", async () => {
    const { call, route, prepare } = await arm(true);
    await prepare();
    await expect(call("session:http.request", { ...route, request: new Request("https://gateway.example/alpha/generate", { method: "POST", body: "{}" }) })).rejects.toThrow("Sensitive Guard");
  });

  it("does not inspect transport metadata in hook-only mode", async () => {
    const { call, route, prepare } = await arm(false);
    await prepare();
    await expect(call("session:http.request", { ...route, request: new Request("https://gateway.example/alpha/generate", { method: "POST", headers: { "x-owner": EMAIL }, body: "{}" }) })).resolves.toBeUndefined();
  });

  it.each([false, true])("leaves opaque WS routes untouched only in hook-only mode (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const handshake = { ...route, url: "wss://gateway.example/alpha/generate", headers: {} };
    if (wireProtection) await expect(call("session:experimental.ws.handshake", handshake)).rejects.toThrow("Sensitive Guard");
    else await expect(call("session:experimental.ws.handshake", handshake)).resolves.toBeUndefined();
    await prepare();
    if (wireProtection) {
      await expect(call("session:experimental.ws.handshake", handshake)).rejects.toThrow("Sensitive Guard");
      return;
    }
    await call("session:experimental.ws.handshake", handshake);
    const sent = { ...route, frame: "opaque protocol envelope" };
    await call("session:experimental.ws.send", sent);
    expect(sent.frame).toBe("opaque protocol envelope");
    const received = { ...route, frame: "opaque protocol reply" };
    await call("session:experimental.ws.receive", received);
    expect(received.frame).toBe("opaque protocol reply");
    await expect(call("session:experimental.ws.handshake", { ...handshake, headers: { "x-owner": EMAIL } })).resolves.toBeUndefined();
  });

  it("invalidates ingress proof when preparation fails or switches models, without gating transport", async () => {
    const { call, route, prepare } = await arm(false);
    const request = () => ({ ...route, request: new Request("https://gateway.example/private", { method: "POST", body: "{}" }) });
    await prepare();
    await expect(call("session:context", { ...route, system: Object.freeze([EMAIL]), messages: [], options: {} })).rejects.toThrow("Sensitive Guard");
    await expect(call("session:http.request", request())).resolves.toBeUndefined();
    const token = "[SGP2:PII_EMAIL-abcd-efgh-ijkl]";
    const checkLiteral = async () => {
      const response = new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } });
      const event = { ...request(), response };
      await call("session:http.response", event);
      expect(event.response).toBe(response);
    };
    await checkLiteral();
    await prepare();
    await prepare({ model: { ...route.model, id: "model-b" } });
    await expect(call("session:http.request", request())).resolves.toBeUndefined();
    await checkLiteral();
  });

  it.each([false, true])("wraps SDK fetch only when wire protection is enabled (%s)", async (wireProtection) => {
    const { call, route, prepare } = await arm(wireProtection);
    const network = vi.fn(async () => new Response("synthetic provider"));
    const options = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const event = { ...route, request: new Request(input, init) };
      await call("session:http.request", event);
      return network();
    } };
    await call("aisdk:sdk", { package: "unknown-compatible-sdk", options });
    const send = () => options.fetch("https://gateway.example/alpha/generate", { method: "POST", body: "synthetic envelope" });
    expect((await send()).status).toBe(wireProtection ? 400 : 200);
    expect(network).toHaveBeenCalledTimes(wireProtection ? 0 : 1);
    await prepare();
    expect((await send()).status).toBe(wireProtection ? 400 : 200);
    expect(network).toHaveBeenCalledTimes(wireProtection ? 0 : 2);
  });

  it.each([false, true])("keeps write/shell unknown mappings refused after a reply was passed through (%s)", async (wireProtection) => {
    const { call, route } = await arm(wireProtection);
    const token = "[SGP2:PII_EMAIL-abcd-efgh-ijkl]";
    await call("session:experimental.ws.receive", { ...route, frame: JSON.stringify({ type: "response.output_text.delta", delta: token }) });
    await expect(call("tool:execute.before", { ...route, tool: "write", input: { path: "synthetic.txt", content: token } })).rejects.toThrow("no mapping");
    await expect(call("tool:execute.before", { ...route, tool: "shell", input: { command: `printf %s ${token}` } })).rejects.toThrow("no mapping");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransparentSessionGuard } from "../src/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const EMAIL = "alice@example.com";
const config: GuardConfig = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: true },
};
const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];
afterEach(async () => { for (const guard of guards.splice(0)) await guard.dispose(); });

async function arm(wireProtection = true) {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
    hooks.set(`${domain}:${name}`, callback);
    return { dispose: async () => {} };
  };
  const guard = createTransparentSessionGuard(config, "block", wireProtection);
  guards.push(guard);
  await guard.setup({ session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") }, aisdk: { hook: hookFor("aisdk") } } as never);
  const call = async (name: string, event: unknown) => {
    const callback = hooks.get(name);
    if (callback) return callback(event);
    if (!wireProtection && ["session:http.request", "aisdk:sdk", "aisdk:language"].includes(name)) return;
    throw new Error(`missing hook ${name}`);
  };
  return { guard, call };
}

describe("AI SDK injected HTTP transport", () => {
  it("reports unsupported fetch routes as a local HTTP 400 so SDKs do not retry a guard refusal as a network failure", async () => {
    const { call } = await arm();
    const fetch = vi.fn(async () => new Response());
    const options = { fetch };
    await call("aisdk:sdk", { options });
    const response = await options.fetch("https://gateway.example/alpha/generate");
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("sensitive_guard_transport_refusal");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])("admits an arbitrary SDK brand through injected fetch and preserves HTTP restoration (%s)", async (wireProtection) => {
    const { call } = await arm(wireProtection);
    const model = { providerID: "gateway", id: "model-a" };
    const context = { sessionID: "s", model, system: [{ type: "text", text: EMAIL }], messages: [], options: {} };
    await call("session:context", context);
    const token = context.system[0].text;
    const captures: string[] = [];
    // OpenCode's injected fetch invokes these public transport hooks; the real
    // host E2E checks the same contract without a hand-constructed pipeline.
    const hostFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const event = { sessionID: "s", kind: "primary", model, request: new Request(input, init) };
      await call("session:http.request", event);
      captures.push(await event.request.clone().text());
      const reply = { ...event, response: new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: token } }] }), { headers: { "content-type": "application/json" } }) };
      await call("session:http.response", reply);
      return reply.response;
    };
    const options = { fetch: hostFetch };
    await call("aisdk:sdk", { package: "new-compatible-sdk", options });
    await call("aisdk:language", { sdk: {}, options });
    const response = await options.fetch("https://gateway.example/provider/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "synthetic", messages: [{ role: "user", content: token }] }) });
    expect(captures).toHaveLength(1);
    expect(captures[0]).not.toContain(EMAIL);
    expect((await response.json()).choices[0].message.content).toBe(EMAIL);
  });

  it.each(["sdk", "language"])("refuses %s without a usable injected fetch and never logs supplied content", async (name) => {
    const { call } = await arm();
    for (const options of [{}, { fetch: EMAIL }, Object.freeze({ fetch: async () => new Response() })]) {
      await expect(call(`aisdk:${name}`, { package: EMAIL, options })).rejects.toThrow("injected HTTP fetch");
      await expect(call(`aisdk:${name}`, { package: EMAIL, options })).rejects.not.toThrow(EMAIL);
    }
    const getter = vi.fn(() => { throw new Error(EMAIL); });
    const options = Object.defineProperty({}, "fetch", { get: getter });
    await expect(call(`aisdk:${name}`, { options })).rejects.toThrow("injected HTTP fetch");
    expect(getter).not.toHaveBeenCalled();
  });

  it("masks Responses easy-input messages with an omitted message type without changing their wire form", async () => {
    const { call } = await arm();
    const input = [
      { role: "system", content: EMAIL },
      { role: "developer", content: EMAIL },
      { role: "user", content: [{ type: "input_text", text: EMAIL }] },
      { role: "assistant", content: [{ type: "output_text", text: EMAIL }] },
    ];
    const event = { sessionID: "s", kind: "primary", request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ model: "synthetic", input }) }) };
    await call("session:http.request", event);
    const masked = await event.request.json();
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
    expect(masked.input.map((item: Record<string, unknown>) => item.role)).toEqual(input.map((item) => item.role));
    expect(masked.input.every((item: Record<string, unknown>) => !("type" in item))).toBe(true);
    const reply = { ...event, response: new Response(JSON.stringify({ output_text: masked.input[0].content }), { headers: { "content-type": "application/json" } }) };
    await call("session:http.response", reply);
    expect((await reply.response.json()).output_text).toBe(EMAIL);
  });

  it.each([
    { role: "unknown", content: EMAIL },
    { role: "user" },
    { role: "user", content: null },
    { role: "user", content: [{ type: "new_extension", text: EMAIL }] },
    { role: "user", type: "unknown", content: EMAIL },
  ])("does not treat an unrecognized Responses record as an implicit message (%j)", async (item) => {
    const { call } = await arm();
    const request = new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: [item] }) });
    const event = { sessionID: "s", kind: "primary", request };
    await expect(call("session:http.request", event)).rejects.toThrow("Sensitive Guard");
    expect(event.request).toBe(request);
  });

  it.each([false, true])("delegates opaque HTTP admission to host hooks only in compatibility mode (%s)", async (wireProtection) => {
    const { call } = await arm(wireProtection);
    const hostFetch = vi.fn(async () => new Response());
    const options = { fetch: hostFetch };
    await call("aisdk:sdk", { package: "commandcode", options });
    for (const input of ["https://gateway.example/alpha/generate", "https://gateway.example/private"]) {
      const response = await options.fetch(input);
      expect(response.status).toBe(wireProtection ? 400 : 200);
    }
    for (const input of ["wss://gateway.example/v1/responses", "not a URL"]) {
      const response = await options.fetch(input);
      expect(response.status).toBe(wireProtection ? 400 : 200);
      if (wireProtection) expect((await response.json()).error.message).toContain("unsupported model transport");
    }
    expect(hostFetch).toHaveBeenCalledTimes(wireProtection ? 0 : 4);
  });

  it("preserves input objects, cancellation, receiver and repeated SDK/language initialization", async () => {
    const { call } = await arm();
    const hostFetch = vi.fn(async function (this: unknown) { return new Response("safe"); });
    const options = { fetch: hostFetch };
    await call("aisdk:sdk", { package: "gateway", options });
    const wrapper = options.fetch;
    await call("aisdk:language", { options });
    expect(options.fetch).toBe(wrapper);
    const request = new Request("https://gateway.example/provider/v1/messages", { method: "POST", body: "{}" });
    const controller = new AbortController();
    const init = { signal: controller.signal };
    await options.fetch(request, init);
    expect(hostFetch.mock.calls[0]).toEqual([request, init]);
    expect(hostFetch.mock.contexts[0]).toBe(options);
    // SDK caching can use an older wrapper while the next language hook is
    // passed a fresh host options object; both remain valid until disposal.
    const nextOptions = { fetch: hostFetch };
    await call("aisdk:language", { options: nextOptions });
    await nextOptions.fetch(new URL("https://gateway.example/v1/responses"));
    expect(hostFetch).toHaveBeenCalledTimes(2);
  });

  it("fails before the provider sends when final-wire encounters unsupported content", async () => {
    const { call } = await arm();
    const network = vi.fn();
    const options = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const event = { sessionID: "s", kind: "primary", request: new Request(input, init) };
      await call("session:http.request", event);
      network();
      return new Response();
    } };
    await call("aisdk:sdk", { package: "gateway", options });
    const response = await options.fetch("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ messages: [{ content: EMAIL }] }) });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).not.toContain(EMAIL);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([false, true])("checks SDK transport metadata only with wire protection (%s)", async (wireProtection) => {
    const { call } = await arm(wireProtection);
    const network = vi.fn();
    const options = { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const event = { sessionID: "s", kind: "primary", request: new Request(input, init) };
      await call("session:http.request", event);
      network();
      return new Response();
    } };
    await call("aisdk:language", { options });
    expect((await options.fetch("https://gateway.example/v1/messages", { method: "POST", headers: { "x-owner": EMAIL }, body: JSON.stringify({ messages: [] }) })).status).toBe(wireProtection ? 400 : 200);
    expect(network).toHaveBeenCalledTimes(wireProtection ? 0 : 1);
  });

  it("prevents a cached admitted fetch from sending after the guard is disposed", async () => {
    const { guard, call } = await arm();
    const fetch = vi.fn(async () => new Response());
    const options = { fetch };
    await call("aisdk:sdk", { options });
    await guard.dispose();
    const response = await options.fetch("https://gateway.example/v1/responses");
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("inactive AI SDK");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reclassify real network errors, aborts or provider error responses as guard refusals", async () => {
    const { call } = await arm();
    const networkError = new Error("synthetic network failure");
    const aborted = new DOMException("synthetic cancellation", "AbortError");
    const providerError = new Response(JSON.stringify({ error: { message: "synthetic quota error" } }), { status: 429 });
    const original = vi.fn().mockRejectedValueOnce(networkError).mockRejectedValueOnce(aborted).mockResolvedValueOnce(providerError);
    const options = { fetch: original };
    await call("aisdk:sdk", { options });
    await expect(options.fetch("https://gateway.example/v1/responses")).rejects.toBe(networkError);
    await expect(options.fetch("https://gateway.example/v1/responses")).rejects.toBe(aborted);
    expect(await options.fetch("https://gateway.example/v1/responses")).toBe(providerError);
  });
});

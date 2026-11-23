import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransparentSessionGuard } from "../src/adapters/opencode/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const EMAIL = "hook-owner@example.org";
const config: GuardConfig = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, severity_threshold: "medium", scan_commands: true, ignore_patterns: [] },
};
const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.dispose();
  vi.restoreAllMocks();
});

async function arm(wireProtection = false, rejectedHooks: string[] = [], guardConfig = config, noAISDK = false) {
  const hooks = new Map<string, (event: any) => unknown>();
  const disposed: string[] = [];
  const hook = (domain: string) => async (name: string, fn: (event: any) => unknown) => {
    const key = `${domain}:${name}`;
    if (rejectedHooks.includes(key)) throw new Error("synthetic unavailable hook");
    hooks.set(key, fn);
    return { dispose: async () => { disposed.push(key); } };
  };
  const guard = createTransparentSessionGuard(guardConfig, "block", wireProtection);
  guards.push(guard);
  await guard.setup({ session: { hook: hook("session") }, tool: { hook: hook("tool") },
    ...(noAISDK ? {} : { aisdk: { hook: hook("aisdk") } }) } as never);
  const route = { sessionID: "s", kind: "primary", model: { providerID: "custom", id: "model-a" } };
  const prepare = async (text = EMAIL, override = {}) => {
    const event = { ...route, system: [], messages: [{ role: "user", content: [{ type: "text", text }] }], options: {}, ...override };
    await hooks.get("session:context")!(event);
    return event.messages[0].content[0].text;
  };
  // Host emission: no registration means the original event is untouched.
  const emit = async (key: string, event: any) => { await hooks.get(key)?.(event); return event; };
  return { guard, hooks, disposed, route, prepare, emit };
}

describe("pure hook-only transparent mode", () => {
  it("has no HTTP/WS/SDK outbound admission registrations and needs no aisdk API", async () => {
    const { hooks } = await arm(false, [], config, true);
    expect([...hooks.keys()].sort()).toEqual([
      "session:compaction", "session:context", "session:experimental.ws.receive", "session:generate",
      "session:http.response", "session:title", "tool:execute.before",
    ]);
  });

  it.each(["session:http.response", "session:experimental.ws.receive"])("keeps content/tool hooks when optional %s is unavailable", async (missing) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { hooks, prepare } = await arm(false, [missing]);
    expect(hooks.has(missing)).toBe(false);
    expect(await prepare()).not.toContain(EMAIL);
    expect(hooks.has("tool:execute.before")).toBe(true);
  });

  it("leaves unknown routes, transport secrets and private SDK options untouched without context proof", async () => {
    const { emit } = await arm();
    const request = new Request(`https://example.org/alpha/generate?contact=${EMAIL}`, {
      method: "POST", headers: { "x-contact": EMAIL }, body: "opaque body",
    });
    const event = { request };
    await emit("session:http.request", event);
    expect(event.request).toBe(request);
    expect(await request.text()).toBe("opaque body");
    for (const key of ["session:experimental.ws.handshake", "session:experimental.ws.send", "aisdk:sdk", "aisdk:language"]) {
      const opaque = Object.freeze({ frame: "private transport", options: Object.freeze({}) });
      expect(await emit(key, opaque)).toBe(opaque);
    }
  });

  it("still masks every request kind and restores known tool arguments", async () => {
    const { hooks, route, emit, prepare } = await arm();
    for (const kind of ["context", "title", "generate", "compaction"]) {
      const event = { ...route, system: [{ type: "text", text: EMAIL }], messages: [], options: {} };
      await hooks.get(`session:${kind}`)!(event);
      expect(event.system[0].text).not.toContain(EMAIL);
    }
    const token = await prepare();
    const tool = { sessionID: "s", tool: "write", input: { content: token } };
    await emit("tool:execute.before", tool);
    expect(tool.input.content).toBe(EMAIL);
  });

  it("restores a same-scope HTTP reply without an outbound request registration", async () => {
    const { route, prepare, emit } = await arm();
    const token = await prepare();
    const event = { ...route, request: new Request("https://example.org/v1/responses"),
      response: new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } }) };
    await emit("session:http.response", event);
    expect((await event.response.json()).output_text).toBe(EMAIL);
  });

  it.each(["context", "title", "generate", "compaction"])("uses named %s preparation for ingress when event.kind is absent", async (name) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { route, hooks, emit } = await arm();
    const { kind: _absent, ...identity } = route;
    const prepared = { ...identity, system: [EMAIL], messages: [], options: {} };
    await hooks.get(`session:${name}`)!(prepared);
    const token = prepared.system[0];
    const kind = name === "context" ? "primary" : name;
    const reply = (requestKind: string) => ({ ...identity, kind: requestKind,
      request: new Request("https://example.org/v1/responses"),
      response: new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } }),
    });
    const mismatch = reply(kind === "primary" ? "title" : "primary");
    await emit("session:http.response", mismatch);
    expect((await mismatch.response.json()).output_text).toBe(token);
    const correct = reply(kind);
    await emit("session:http.response", correct);
    expect((await correct.response.json()).output_text).toBe(EMAIL);
  });

  it("restores split WS tokens from response.created without handshake/send hooks", async () => {
    const { route, prepare, emit } = await arm();
    const token = await prepare();
    const receive = async (body: any) => JSON.parse((await emit("session:experimental.ws.receive", { ...route, frame: JSON.stringify(body) })).frame);
    await receive({ type: "response.created", response: { id: "r" } });
    expect((await receive({ type: "response.output_text.delta", response_id: "r", delta: token.slice(0, 15) })).delta).toBe("");
    expect((await receive({ type: "response.output_text.delta", response_id: "r", delta: token.slice(15) })).delta).toBe(EMAIL);
    const args = { type: "response.function_call_arguments.delta", response_id: "r", delta: token };
    expect(await receive(args)).toEqual(args);
  });

  it("never restores another session's mapping or an unprepared model reply", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { route, prepare, emit } = await arm();
    const token = await prepare();
    for (const override of [{ sessionID: "other" }, { model: { providerID: "custom", id: "other" } }]) {
      const response = new Response(JSON.stringify({ output_text: token }), { headers: { "content-type": "application/json" } });
      const event = { ...route, ...override, request: new Request("https://example.org/v1/responses"), response };
      await emit("session:http.response", event);
      expect(event.response).toBe(response);
      expect((await event.response.json()).output_text).toBe(token);
    }
  });

  it("keeps malformed/unknown incoming frames literal and restarts on the next created response", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { route, prepare, emit } = await arm();
    const token = await prepare();
    const receive = async (frame: string) => (await emit("session:experimental.ws.receive", { ...route, frame })).frame;
    const created = (id: string) => JSON.stringify({ type: "response.created", response: { id } });
    await receive(created("r1"));
    expect(await receive("provider opaque extension")).toBe("provider opaque extension");
    const late = JSON.stringify({ type: "response.output_text.delta", response_id: "r1", delta: token });
    expect(await receive(late)).toBe(late);
    await prepare();
    await receive(created("r2"));
    expect(JSON.parse(await receive(JSON.stringify({ type: "response.output_text.delta", response_id: "r2", delta: token }))).delta).toBe(EMAIL);
  });

  it("does not restore old WS frames after new preparation or through a different session's mapping", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { route, prepare, emit } = await arm();
    const token = await prepare();
    const receive = async (identity: typeof route, body: any) => {
      const event = { ...identity, frame: JSON.stringify(body) };
      await emit("session:experimental.ws.receive", event);
      return JSON.parse(event.frame);
    };
    await receive(route, { type: "response.created", response: { id: "old" } });
    await prepare();
    const old = { type: "response.output_text.delta", response_id: "old", delta: token };
    expect(await receive(route, old)).toEqual(old);
    const other = { ...route, sessionID: "other" };
    const otherText = "another-owner@example.org";
    const otherToken = await prepare(otherText, { sessionID: "other" });
    await receive(other, { type: "response.created", response: { id: "other-response" } });
    const reply = await receive(other, { type: "response.output_text.delta", response_id: "other-response", delta: `${token} / ${otherToken}` });
    expect(reply.delta).toBe(`${token} / ${otherText}`);
    expect(reply.delta).not.toContain(EMAIL);
  });

  it("does not send raw content when masking fails, and surfaces only a static reason/stage", async () => {
    const small = { ...config, settings: { ...config.settings, max_chars: 8 } };
    const { prepare } = await arm(false, [], small);
    await expect(prepare(EMAIL)).rejects.toThrow("[stage=prepare.mask reason=truncated_content]");
    // Issue #47: the bound is named, and the message says how to get past it.
    await expect(prepare(EMAIL)).rejects.toThrow("settings.max_chars (8)");
    await expect(prepare(EMAIL)).rejects.toThrow("Raise settings.max_chars or split the content.");
    try { await prepare(EMAIL); } catch (error) { expect(String(error)).not.toContain(EMAIL); }
  });

  it("explains the bound when only the masked text exceeds max_chars", async () => {
    const atBound = { ...config, settings: { ...config.settings, max_chars: EMAIL.length } };
    const { prepare } = await arm(false, [], atBound);
    // The input fits; its token does not (issue #47).
    await expect(prepare(EMAIL)).rejects.toThrow(
      `[stage=prepare.mask reason=truncated_content] A string, before or after masking, exceeded settings.max_chars (${EMAIL.length}).`,
    );
  });

  it("reports aggregate operation exhaustion without partially publishing a large history", async () => {
    const { hooks, route } = await arm();
    const event = { ...route, system: [], options: {}, messages: Array.from({ length: 512 }, () => ({
      role: "user", content: [{ type: "text", text: "ordinary prose. ".repeat(640) }],
    })) };
    const before = JSON.stringify(event);
    const failure = await Promise.resolve()
      .then(() => hooks.get("session:context")!(event))
      .then(() => null, (error: unknown) => (error as Error).message);
    // Only truncated_content explains the scanner bound; every other reason
    // keeps the bare marker it had before (issue #47).
    expect(failure).toBe(
      "LeakShield blocked a model request because it could not be masked safely. [stage=prepare.mask reason=operation_limit]",
    );
    expect(JSON.stringify(event)).toBe(before);
  });

  it("still arms the full outbound protection in true mode", async () => {
    const { hooks } = await arm(true);
    for (const key of ["session:http.request", "session:experimental.ws.handshake", "session:experimental.ws.send", "aisdk:sdk", "aisdk:language"]) {
      expect(hooks.has(key)).toBe(true);
    }
  });

  it("keeps a failed core initialization hook-only while refusing content and tool dispatch", async () => {
    const invalid = { ...config, settings: { ...config.settings, max_chars: 0 } };
    const { hooks, prepare, emit } = await arm(false, [], invalid, true);
    expect([...hooks.keys()].sort()).toEqual(["session:compaction", "session:context", "session:generate", "session:title", "tool:execute.before"]);
    await expect(prepare()).rejects.toThrow("LeakShield initialization failed");
    await expect(emit("tool:execute.before", { sessionID: "s", tool: "write", input: {} })).rejects.toThrow("LeakShield initialization failed");
  });
});

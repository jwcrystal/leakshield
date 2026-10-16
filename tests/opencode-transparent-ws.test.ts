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
    const callback = hooks.get(`session:experimental.ws.${name}`);
    if (callback) return callback(event);
    if (!wireProtection && ["handshake", "send"].includes(name)) return;
    throw new Error(`missing hook ${name}`);
  };
  const route = { sessionID: "s", kind: "primary", model: { providerID: "compatible-gateway", id: "model-a" } };
  const handshake = async (extra = {}) => call("handshake", { ...route, url: "wss://gateway.example/v1/responses", headers: {}, ...extra });
  const send = async (body: unknown, extra = {}) => {
    const event = { ...route, frame: JSON.stringify(body), ...extra };
    await call("send", event);
    return JSON.parse(event.frame);
  };
  const receive = async (body: unknown, extra = {}) => {
    const event = { ...route, frame: JSON.stringify(body), ...extra };
    await call("receive", event);
    return JSON.parse(event.frame);
  };
  return { guard, hooks, call, route, handshake, send, receive };
}

describe("Responses-family WebSocket hooks", () => {
  it("masks a compatible gateway's response.create and restores a token split across frames", async () => {
    const { handshake, send, receive } = await arm();
    await handshake();
    const masked = await send({ type: "response.create", model: "model-a", instructions: EMAIL, input: EMAIL });
    expect(JSON.stringify(masked)).not.toContain(EMAIL);
    const token = masked.input;
    expect(token).toMatch(/^\[SGP2:PII_EMAIL-/);
    await receive({ type: "response.created", response: { id: "resp_1", output: [] } });
    const first = await receive({ type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: `Contact ${token.slice(0, 12)}` });
    const second = await receive({ type: "response.output_text.delta", item_id: "msg_1", content_index: 0, delta: `${token.slice(12)} OK` });
    expect(first.delta + second.delta).toBe(`Contact ${EMAIL} OK`);
    const terminal = await receive({ type: "response.completed", response: { id: "resp_1", output_text: token, output: [] } });
    expect(terminal.response.output_text).toBe(EMAIL);
  });

  it.each([false, true])("keeps hook-first restoration and makes final-frame masking optional (%s)", async (wireProtection) => {
    const { hooks, route, handshake, send, receive } = await arm(wireProtection);
    const context = { ...route, system: [{ type: "text", text: EMAIL }], messages: [], options: {} };
    await hooks.get("session:context")!(context);
    const token = context.system[0].text;
    await handshake();
    const body = await send({ type: "response.create", instructions: "safe", input: token, late_extension: EMAIL });
    expect(body.input).toBe(token);
    expect(body.late_extension === EMAIL).toBe(!wireProtection);
    await receive({ type: "response.created", response: { id: "resp_1" } });
    const reply = await receive({ type: "response.output_text.delta", item_id: "msg", delta: token });
    expect(reply.delta).toBe(EMAIL);
    const argumentsFrame = await receive({ type: "response.function_call_arguments.delta", delta: JSON.stringify({ content: token }) });
    expect(argumentsFrame.delta).toContain(token);
    const input = { content: token };
    await hooks.get("tool:execute.before")!({ ...route, tool: "write", input });
    expect(input.content).toBe(EMAIL);
  });

  it("isolates simultaneous sessions, request kinds, models and content parts", async () => {
    const { handshake, send, receive } = await arm();
    const other = { sessionID: "other" };
    await handshake();
    await handshake(other);
    const token = (await send({ type: "response.create", input: EMAIL })).input;
    await send({ type: "response.create", input: "bob@example.org" }, other);
    await receive({ type: "response.created", response: { id: "r_a" } });
    await receive({ type: "response.created", response: { id: "r_b" } }, other);
    const first = await receive({ type: "response.output_text.delta", item_id: "same", content_index: 0, delta: token.slice(0, 12) });
    expect(first.delta).toBe("");
    const separatePart = await receive({ type: "response.output_text.delta", item_id: "same", content_index: 1, delta: "another part" });
    expect(separatePart.delta).toBe("another part");
    const alien = await receive({ type: "response.output_text.delta", item_id: "same", delta: token }, other);
    expect(alien.delta).toBe(token);
    const second = await receive({ type: "response.output_text.delta", item_id: "same", content_index: 0, delta: token.slice(12) });
    expect(second.delta).toBe(EMAIL);
    for (const extra of [{ kind: "title" }, { model: { providerID: "different", id: "model-a" } }]) {
      expect((await receive({ type: "response.output_text.delta", delta: token }, extra)).delta).toBe(token);
    }
  });

  it("invalidates the older model's lane when the same request kind switches models", async () => {
    const { handshake, send, receive } = await arm();
    await handshake();
    await send({ type: "response.create", input: EMAIL });
    await receive({ type: "response.created", response: { id: "old" } });
    const otherModel = { model: { providerID: "compatible-gateway", id: "model-b" } };
    await handshake(otherModel);
    await send({ type: "response.create", input: "safe" }, otherModel);
    await receive({ type: "response.created", response: { id: "new" } }, otherModel);
    expect((await receive({ type: "response.output_text.delta", response_id: "old", delta: "late" })).delta).toBe("late");
    expect((await receive({ type: "response.output_text.delta", delta: "current" }, otherModel)).delta).toBe("current");
  });

  it.each(["primary", "title", "compaction", "generate"])("supports the %s request lane", async (kind) => {
    const { handshake, send, receive } = await arm();
    await handshake({ kind });
    const token = (await send({ type: "response.create", input: EMAIL }, { kind })).input;
    await receive({ type: "response.created", response: { id: "response" } }, { kind });
    expect((await receive({ type: "response.output_text.delta", delta: token }, { kind })).delta).toBe(EMAIL);
  });

  it("reuses a lane for continuation without changing IDs or carrying a previous tail", async () => {
    const { handshake, send, receive } = await arm();
    await handshake();
    const token = (await send({ type: "response.create", input: EMAIL })).input;
    await receive({ type: "response.created", response: { id: "r1" } });
    await receive({ type: "response.output_text.delta", delta: token.slice(0, 12) });
    await handshake();
    const continuation = await send({ type: "response.create", previous_response_id: "r1", event_id: "evt_2", input: token });
    expect(continuation.previous_response_id).toBe("r1");
    expect(continuation.event_id).toBe("evt_2");
    await receive({ type: "response.created", response: { id: "r2" } });
    expect((await receive({ type: "response.output_text.delta", response_id: "r1", delta: token })).delta).toBe(token);
  });

  it.each(["response.completed", "response.failed", "response.incomplete", "error"])("clears held tokens at %s without mixing the next request", async (terminalType) => {
    const { handshake, send, receive } = await arm();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await handshake();
      const token = (await send({ type: "response.create", input: EMAIL })).input;
      await receive({ type: "response.created", response: { id: "r1" } });
      await receive({ type: "response.output_text.delta", delta: token.slice(0, 12) });
      await receive({ type: terminalType, ...(terminalType === "error" ? { error: { message: "failed" } } : { response: { id: "r1", output_text: token } }) });
      expect((await receive({ type: "response.output_text.delta", delta: token.slice(12) })).delta).toBe(token.slice(12));
      await handshake();
      await send({ type: "response.create", input: "safe" });
      await receive({ type: "response.created", response: { id: "r2" } });
      expect((await receive({ type: "response.output_text.delta", delta: token.slice(12) })).delta).toBe(token.slice(12));
    } finally { spy.mockRestore(); }
  });

  it("invalidates WS attribution when a request falls back to HTTP", async () => {
    const { hooks, route, handshake, send, receive } = await arm();
    await handshake();
    await send({ type: "response.create", input: EMAIL });
    await receive({ type: "response.created", response: { id: "r1" } });
    const event = { ...route, request: new Request("https://gateway.example/v1/responses", { method: "POST", body: JSON.stringify({ input: EMAIL }) }) };
    await hooks.get("session:http.request")!(event);
    expect((await receive({ type: "response.output_text.delta", delta: "late" })).delta).toBe("late");
    const responseEvent = { ...event, response: new Response(JSON.stringify({ output_text: "safe" }), { headers: { "content-type": "application/json" } }) };
    await hooks.get("session:http.response")!(responseEvent);
    expect(await responseEvent.response.text()).toContain("safe");
  });

  it("restores complete display parts but never restores tool arguments or opaque state", async () => {
    const { handshake, send, receive } = await arm();
    await handshake();
    const token = (await send({ type: "response.create", input: EMAIL })).input;
    await receive({ type: "response.created", response: { id: "r1" } });
    for (const [type, field] of [["response.reasoning_summary_text.done", "text"], ["response.refusal.done", "refusal"]]) {
      expect((await receive({ type, [field]: token }))[field]).toBe(EMAIL);
    }
    const item = await receive({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: token }], encrypted_content: token } });
    expect(item.item.summary[0].text).toBe(EMAIL);
    expect(item.item.encrypted_content).toBe(token);
    const call = await receive({ type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: JSON.stringify({ content: token }) } });
    expect(call.item.arguments).toContain(token);
  });

  it("refuses unadmitted sends with wire protection but keeps unattributed replies literal", async () => {
    const { call, route, handshake, send, receive } = await arm(true);
    await expect(handshake({ url: "wss://gateway.example/chat" })).rejects.toThrow("unsupported model transport");
    await expect(send({ type: "response.create", input: EMAIL })).rejects.toThrow("attribution");
    await handshake();
    expect((await receive({ type: "response.created", response: { id: "r1" } })).response.id).toBe("r1");
    for (const body of [{ type: "unknown", input: EMAIL }, { type: "response.cancel" }, []]) {
      await handshake();
      await expect(send(body)).rejects.toThrow("WebSocket frame");
    }
    await handshake();
    const event = { ...route, frame: "invalid JSON" };
    await expect(call("send", event)).rejects.toThrow("WebSocket frame");
    expect(event.frame).toBe("invalid JSON");
  });

  it("refuses unsupported attachments and mixed dialects without modifying the input frame", async () => {
    const { call, route, handshake } = await arm();
    await handshake();
    for (const body of [
      { type: "response.create", messages: [{ content: EMAIL }] },
      { type: "response.create", input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.org/image.png" }] }] },
      { type: "response.create", previous_response_id: EMAIL, input: "safe" },
    ]) {
      await handshake();
      const frame = JSON.stringify(body);
      const event = { ...route, frame };
      await expect(call("send", event)).rejects.toThrow("LeakShield");
      expect(event.frame).toBe(frame);
    }
  });

  it("caps UTF-8 frame/channel buffers and reports failures without frame contents", async () => {
    const { call, route, handshake, send, receive } = await arm();
    await handshake();
    const huge = { ...route, frame: JSON.stringify({ type: "response.create", input: "中".repeat(1_400_000) }) };
    await expect(call("send", huge)).rejects.toThrow("oversized WebSocket buffer");
    await handshake();
    await send({ type: "response.create", input: EMAIL });
    await receive({ type: "response.created", response: { id: "r1" } });
    expect((await receive({ type: "response.output_text.delta", delta: "中".repeat(22_000) })).delta).toBe("中".repeat(22_000));
    const malformedHeader = { ...route, url: "wss://gateway.example/v1/responses", headers: { "bad\nheader": EMAIL } };
    await expect(call("handshake", malformedHeader)).rejects.not.toThrow(EMAIL);
  });

  it("bounds concurrently tracked display channels before allocating another", async () => {
    const { handshake, send, receive } = await arm();
    await handshake();
    await send({ type: "response.create", input: "safe" });
    await receive({ type: "response.created", response: { id: "r1" } });
    for (let index = 0; index < 256; index++) {
      await receive({ type: "response.output_text.delta", item_id: `item_${index}`, delta: "safe" });
    }
    expect((await receive({ type: "response.output_text.delta", item_id: "overflow", delta: "safe" })).delta).toBe("safe");
    await handshake();
    await send({ type: "response.create", input: "safe" });
    await receive({ type: "response.created", response: { id: "r2" } });
    expect((await receive({ type: "response.output_text.delta", delta: "safe" })).delta).toBe("safe");
  });

  it("preserves incomplete done-frame semantics and literal unknown tokens without refusing a reply", async () => {
    const { handshake, send, receive } = await arm();
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message) => warnings.push(String(message)));
    try {
      await handshake();
      const token = (await send({ type: "response.create", input: EMAIL })).input;
      await receive({ type: "response.created", response: { id: "r1" } });
      const first = await receive({ type: "response.output_text.delta", item_id: "msg", delta: `Contact ${token.slice(0, 12)}` });
      expect(first.delta).toBe("Contact ");
      const done = await receive({ type: "response.output_text.done", item_id: "msg", text: `Contact ${token}` });
      expect(done.type).toBe("response.output_text.done");
      expect(done.text).toBe(`Contact ${EMAIL}`);
      const foreign = "[SGP2:PII_EMAIL-abcd-efgh-ijkl]";
      expect((await receive({ type: "response.output_text.delta", item_id: "unknown", delta: foreign })).delta).toBe(foreign);
      expect(warnings.join("\n")).not.toContain(EMAIL);
      expect(warnings.join("\n")).toContain("incomplete delta tail");
    } finally { spy.mockRestore(); }
  });

  it("rejects immutable frame inputs before issuing mappings and releases state on dispose", async () => {
    const { guard, call, route, handshake, send, receive } = await arm();
    await handshake();
    const event = Object.freeze({ ...route, frame: JSON.stringify({ type: "response.create", input: EMAIL }) });
    await expect(call("send", event)).rejects.toThrow("LeakShield");
    await handshake();
    await send({ type: "response.create", input: EMAIL });
    await guard.dispose();
    expect((await receive({ type: "response.created", response: { id: "r1" } })).response.id).toBe("r1");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createTransparentSessionGuard } from "../src/adapters/opencode/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const EMAIL = "capacity-canary@example.org";
const config: GuardConfig = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, severity_threshold: "medium", scan_commands: true, ignore_patterns: [] },
};
const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.dispose();
  vi.restoreAllMocks();
});

function eventStream() {
  const queue: Array<{ type: string; data: { sessionID: string } }> = [];
  let wake: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let stopped = false;
  return {
    async *subscribe(options: { signal: AbortSignal }) {
      signal = options.signal;
      const onAbort = () => wake?.();
      signal.addEventListener("abort", onAbort);
      try {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
          if (signal.aborted) break;
          while (queue.length > 0) yield queue.shift()!;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        stopped = true;
      }
    },
    async publish(type: string, sessionID: string) {
      queue.push({ type, data: { sessionID } });
      wake?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    get aborted() { return signal?.aborted ?? false; },
    get stopped() { return stopped; },
  };
}

async function arm(wireProtection = false, events?: Pick<ReturnType<typeof eventStream>, "subscribe">) {
  const hooks = new Map<string, (event: any) => unknown>();
  const hook = (domain: string) => async (name: string, fn: (event: any) => unknown) => {
    hooks.set(`${domain}:${name}`, fn);
    return { dispose: async () => {} };
  };
  const guard = createTransparentSessionGuard(config, "block", wireProtection);
  guards.push(guard);
  await guard.setup({
    session: { hook: hook("session") }, tool: { hook: hook("tool") }, aisdk: { hook: hook("aisdk") },
    ...(events ? { event: events } : {}),
  } as never);
  const route = { kind: "primary", model: { providerID: "synthetic", id: "model" } };
  const prepare = async (sessionID: string, text = EMAIL) => {
    const event = { ...route, sessionID, system: [], options: {}, messages: [{ role: "user", content: [{ type: "text", text }] }] };
    await hooks.get("session:context")!(event);
    return event.messages[0].content[0].text;
  };
  const restore = async (sessionID: string, token: string) => {
    const event = { sessionID, tool: "write", input: { content: token } };
    await hooks.get("tool:execute.before")!(event);
    return event.input.content;
  };
  return { guard, hooks, route, prepare, restore };
}

describe("transparent request budgets and mapping lifecycle", () => {
  it.each([false, true])("protects a long history atomically, including a sensitive final message (wire=%s)", async (wire) => {
    const { hooks, route, restore } = await arm(wire);
    const text = "This is ordinary context text. ".repeat(334);
    const event = { ...route, sessionID: "long-history", system: [], options: {}, messages: [
      ...Array.from({ length: 100 }, () => ({ role: "user", content: [{ type: "text", text }] })),
      { role: "user", content: [{ type: "text", text: EMAIL }] },
    ] };
    await hooks.get("session:context")!(event);
    expect(event.messages).toHaveLength(101);
    expect(event.messages[0].content[0].text).toBe(text);
    const token = event.messages.at(-1)!.content[0].text;
    expect(token).not.toContain(EMAIL);
    expect(await restore("long-history", token)).toBe(EMAIL);
    if (wire) {
      const request = { ...route, sessionID: event.sessionID, request: new Request("https://example.org/v1/responses", {
        method: "POST", body: JSON.stringify({ input: event.messages.map((message, i) => ({
          role: message.role, content: [{ type: "input_text", text: i === 100 ? EMAIL : message.content[0].text }],
        })) }),
      }) };
      await hooks.get("session:http.request")!(request);
      const body = await request.request.json();
      expect(body.input).toHaveLength(101);
      expect(body.input[0].content[0].text).toBe(text);
      expect(JSON.stringify(body)).not.toContain(EMAIL);
      expect(await restore("long-history", body.input.at(-1).content[0].text)).toBe(EMAIL);
    }
  });

  it("keeps a finite aggregate request budget and never publishes partial masking", async () => {
    const { hooks, route, prepare, restore } = await arm();
    const token = await prepare("oversized");
    const event = { ...route, sessionID: "oversized", system: [EMAIL], options: {}, messages: Array.from({ length: 500 }, () => ({
      role: "user", content: [{ type: "text", text: "This is ordinary context text. ".repeat(334) }],
    })) };
    const before = JSON.stringify(event);
    await expect(Promise.resolve().then(() => hooks.get("session:context")!(event)))
      .rejects.toThrow("[stage=prepare.mask reason=operation_limit]");
    expect(JSON.stringify(event)).toBe(before);
    expect(await restore("oversized", token)).toBe(EMAIL);
  });

  it("handles a node-heavy request without dropping its sensitive content", async () => {
    const { hooks, route, restore } = await arm();
    const event = { ...route, sessionID: "node-heavy", system: [EMAIL], messages: [], options: { flags: Array(12000).fill(true) } };
    await hooks.get("session:context")!(event);
    expect(event.options.flags).toHaveLength(12000);
    expect(event.options.flags.every((value) => value === true)).toBe(true);
    expect(event.system[0]).not.toContain(EMAIL);
    expect(await restore("node-heavy", event.system[0])).toBe(EMAIL);
  });

  it.each(["nodes", "depth"])("retains the finite %s limit and refuses without partial mutation", async (limit) => {
    const { hooks, route } = await arm();
    let value: unknown = Array(100001).fill(true);
    if (limit === "depth") {
      value = true;
      for (let i = 0; i < 33; i++) value = { nested: value };
    }
    const event = { ...route, sessionID: "bounded-structure", system: [EMAIL], messages: [], options: { value } };
    const before = JSON.stringify(event);
    await expect(Promise.resolve().then(() => hooks.get("session:context")!(event)))
      .rejects.toThrow("[stage=prepare.mask reason=operation_limit]");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("admits more than 128 mapping sessions without losing old mappings or treating idle as deletion", async () => {
    const events = eventStream();
    const { prepare, restore } = await arm(false, events);
    const first = await prepare("session-0");
    await events.publish("session.idle", "session-0");
    await events.publish("session.execution.succeeded", "session-0");
    for (let i = 1; i < 140; i++) expect(await prepare(`session-${i}`)).not.toContain(EMAIL);
    expect(await restore("session-0", first)).toBe(EMAIL);
  });

  it("clears only the deleted session's memory and HTTP preparation proof", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = eventStream();
    const { hooks, route, prepare, restore } = await arm(false, events);
    const removed = await prepare("removed");
    const kept = await prepare("kept");
    await events.publish("session.deleted", "unrelated");
    expect(await restore("removed", removed)).toBe(EMAIL);
    await events.publish("session.deleted", "removed");
    await expect(restore("removed", removed)).rejects.toThrow("mapping");
    expect(await restore("kept", kept)).toBe(EMAIL);
    const event = { ...route, sessionID: "removed", request: new Request("https://example.org/v1/responses"),
      response: new Response(JSON.stringify({ output_text: removed }), { headers: { "content-type": "application/json" } }) };
    await hooks.get("session:http.response")!(event);
    expect((await event.response.json()).output_text).toBe(removed);
  });

  it("reclaims capacity on real deletion while retaining live mappings at the bounded session ceiling", async () => {
    const events = eventStream();
    const { hooks, route, prepare, restore } = await arm(false, events);
    const first = await prepare("session-0");
    const retained = await prepare("session-1");
    for (let i = 2; i < 4096; i++) await prepare(`session-${i}`);
    const refused = { ...route, sessionID: "over-capacity", system: [EMAIL], messages: [], options: {} };
    const before = JSON.stringify(refused);
    await expect(Promise.resolve().then(() => hooks.get("session:context")!(refused)))
      .rejects.toThrow("[stage=session.track reason=session_limit]");
    expect(JSON.stringify(refused)).toBe(before);
    expect(await restore("session-0", first)).toBe(EMAIL);
    await events.publish("session.deleted", "session-0");
    expect(await prepare("replacement")).not.toContain(EMAIL);
    expect(await restore("session-1", retained)).toBe(EMAIL);
    await expect(restore("session-0", first)).rejects.toThrow("mapping");
  }, 20000);

  it("clears deleted WS lanes and held prefixes without disturbing another session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = eventStream();
    const { hooks, route, prepare } = await arm(false, events);
    const removed = await prepare("scope");
    const kept = await prepare("scope-child");
    const receive = async (sessionID: string, body: Record<string, unknown>) => {
      const event = { ...route, sessionID, frame: JSON.stringify(body) };
      await hooks.get("session:experimental.ws.receive")!(event);
      return JSON.parse(event.frame);
    };
    for (const [sessionID, token] of [["scope", removed], ["scope-child", kept]]) {
      await receive(sessionID, { type: "response.created", response: { id: sessionID } });
      expect((await receive(sessionID, { type: "response.output_text.delta", response_id: sessionID, delta: token.slice(0, 15) })).delta).toBe("");
    }
    await events.publish("session.deleted", "scope");
    expect((await receive("scope", { type: "response.output_text.delta", response_id: "scope", delta: removed.slice(15) })).delta).toBe(removed.slice(15));
    expect((await receive("scope-child", { type: "response.output_text.delta", response_id: "scope-child", delta: kept.slice(15) })).delta).toBe(EMAIL);
  });

  it("retains live mappings when lifecycle subscription fails and never logs the raw error", async () => {
    const warnings: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((message) => { warnings.push(String(message)); });
    const events = { async *subscribe() { throw new Error(EMAIL); } };
    const { prepare, restore } = await arm(false, events);
    const token = await prepare("s");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await restore("s", token)).toBe(EMAIL);
    expect(warnings.join("\n")).toContain("session lifecycle stream unavailable");
    expect(warnings.join("\n")).not.toContain(EMAIL);
  });

  it("aborts its lifecycle subscription on disposal", async () => {
    const events = eventStream();
    const { guard, prepare } = await arm(false, events);
    await prepare("s");
    await guard.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events.aborted).toBe(true);
    expect(events.stopped).toBe(true);
  });
});

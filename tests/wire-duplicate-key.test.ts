/**
 * Wire remaskers must forward exactly the value they scanned.
 *
 * Offline mocks only: drives the transparent guard's http.request and
 * http.response hooks (component under test: src/core/wire.ts via
 * session-guard). A duplicate-key body parses to its LAST occurrence, so a
 * secret in an earlier occurrence is invisible to the scanner; forwarding the
 * original bytes would leak it. The identity, attribution and tool-argument
 * cases lock behaviour that already held before the fix. Secrets are synthetic.
 */

import { describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/adapters/opencode/transparent.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import type { GuardConfig } from "../src/types.js";

const baseConfig: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true,
  },
};

// Letters-only credential (digit runs can nest phone findings the core rejects).
const KEY = "sk-QwertyuiopAsdfghjklZx";
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOKEN_RE = new RegExp(`${escapeRe(PSEUDONYM_TOKEN_PREFIX_V2)}[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`);

interface RecordedHook {
  domain: string;
  name: string;
  callback: (event: unknown) => unknown;
}

async function arm() {
  const registered: RecordedHook[] = [];
  const hookFor = (domain: string) => async (name: string, callback: unknown) => {
    registered.push({ domain, name, callback: callback as (event: unknown) => unknown });
    return { dispose: () => undefined };
  };
  const ctx = {
    session: { hook: hookFor("session") },
    aisdk: { hook: hookFor("aisdk") },
    tool: { hook: hookFor("tool") },
  };
  const guard = createTransparentSessionGuard(baseConfig, "block");
  await guard.setup(ctx as never);
  return (name: string) => {
    const record = registered.find((r) => `${r.domain}:${r.name}` === name);
    if (!record) throw new Error(`hook ${name} not registered`);
    return async (event: unknown) => record.callback(event);
  };
}

type Hook = Awaited<ReturnType<typeof arm>>;

interface Route {
  name: string;
  url: string;
  /** Raw JSON text whose value field is `field`, written twice. */
  duplicate: (first: string, last: string) => string;
  single: (value: string) => string;
  response: (token: string) => unknown;
  restored: (body: Record<string, any>) => unknown;
}

const routes: Route[] = [
  {
    name: "chat completions",
    url: "https://api.openai.com/v1/chat/completions",
    duplicate: (first, last) =>
      `{"model":"gpt-test","messages":[{"role":"user","content":${JSON.stringify(first)}}],` +
      `"messages":[{"role":"user","content":${JSON.stringify(last)}}]}`,
    single: (value) => JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: value }] }),
    response: (token) => ({ choices: [{ index: 0, message: { role: "assistant", content: token } }] }),
    restored: (body) => body.choices[0].message.content,
  },
  {
    name: "anthropic messages",
    url: "https://api.anthropic.com/v1/messages",
    duplicate: (first, last) =>
      `{"model":"claude-test","max_tokens":8,"messages":[{"role":"user","content":${JSON.stringify(first)}}],` +
      `"messages":[{"role":"user","content":${JSON.stringify(last)}}]}`,
    single: (value) =>
      JSON.stringify({ model: "claude-test", max_tokens: 8, messages: [{ role: "user", content: value }] }),
    response: (token) => ({ id: "msg_1", content: [{ type: "text", text: token }], stop_reason: "end_turn" }),
    restored: (body) => body.content[0].text,
  },
  {
    name: "openai responses",
    url: "https://api.openai.com/v1/responses",
    duplicate: (first, last) =>
      `{"model":"gpt-test","input":${JSON.stringify(first)},"input":${JSON.stringify(last)}}`,
    single: (value) => JSON.stringify({ model: "gpt-test", input: value }),
    response: (token) => ({
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: token }] }],
    }),
    restored: (body) => body.output[0].content[0].text,
  },
];

function request(url: string, raw: string | Uint8Array<ArrayBuffer>): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
}

async function send(hook: Hook, url: string, raw: string | Uint8Array<ArrayBuffer>) {
  const original = request(url, raw);
  const event = { sessionID: "session-1", kind: "primary", request: original };
  await hook("session:http.request")(event);
  return { event, original, forwarded: await (event.request as Request).clone().text() };
}

async function mintToken(hook: Hook, secret: string): Promise<string> {
  const event = { sessionID: "session-1", system: [{ type: "text", text: `x ${secret} y` }], messages: [], options: {} };
  await hook("session:context")(event);
  const match = (event.system as Array<{ text: string }>)[0].text.match(TOKEN_RE);
  if (match === null) throw new Error("no token minted");
  return match[0];
}

describe.each(routes)("$name remasker forwards the scanned value", (route) => {
  it("does not forward a secret hidden in an earlier duplicate key", async () => {
    const hook = await arm();
    const { forwarded } = await send(hook, route.url, route.duplicate(`key ${KEY}`, "hello"));
    expect(forwarded).not.toContain(KEY);
    expect(forwarded).toBe(route.single("hello"));
  });

  it("still masks the same secret in the last duplicate key", async () => {
    const hook = await arm();
    const { forwarded } = await send(hook, route.url, route.duplicate("hello", `key ${KEY}`));
    expect(forwarded).not.toContain(KEY);
    expect(forwarded).toMatch(TOKEN_RE);
  });

  it("rebuilds a non-canonical unchanged body from its serialization", async () => {
    const hook = await arm();
    const pretty = JSON.stringify(JSON.parse(route.single("hello")), null, 2);
    const { event, original, forwarded } = await send(hook, route.url, pretty);
    expect(event.request).not.toBe(original);
    expect(forwarded).toBe(route.single("hello"));
    expect((event.request as Request).headers.get("content-length")).toBe(String(new TextEncoder().encode(forwarded).length));
  });

  it("rebuilds an unchanged body whose bytes are not valid UTF-8", async () => {
    const hook = await arm();
    const [before, after] = route.single("hel|lo").split("|");
    const encoder = new TextEncoder();
    const raw = new Uint8Array([...encoder.encode(before), 0xff, ...encoder.encode(after)]);
    const { event, original } = await send(hook, route.url, raw);
    expect(event.request).not.toBe(original);
    const forwarded = new Uint8Array(await (event.request as Request).clone().arrayBuffer());
    expect(forwarded.includes(0xff)).toBe(false);
    expect(new TextDecoder().decode(forwarded)).toBe(route.single("hel\uFFFDlo"));
  });

  it("keeps request identity for a canonical unchanged body", async () => {
    const hook = await arm();
    const { event, original } = await send(hook, route.url, route.single("hello"));
    expect(event.request).toBe(original);
  });

  it("keeps response attribution and restore after a rebuilt duplicate-key request", async () => {
    const hook = await arm();
    const token = await mintToken(hook, KEY);
    const { event } = await send(hook, route.url, route.duplicate(`key ${KEY}`, "hello"));
    const resEvent = {
      ...event,
      response: new Response(JSON.stringify(route.response(token)), { headers: { "content-type": "application/json" } }),
    };
    await hook("session:http.response")(resEvent);
    expect(route.restored(await (resEvent.response as Response).json())).toBe(KEY);
  });
});

describe("tool-call arguments are forwarded as their scanned serialization", () => {
  const args = `{"cmd":${JSON.stringify(`key ${KEY}`)},"cmd":"hello"}`;

  it("chat completions tool_calls arguments", async () => {
    const hook = await arm();
    const raw = JSON.stringify({
      model: "gpt-test",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: args } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
      ],
    });
    const { forwarded } = await send(hook, routes[0].url, raw);
    expect(forwarded).not.toContain(KEY);
  });

  it("openai responses function_call arguments", async () => {
    const hook = await arm();
    const raw = JSON.stringify({
      model: "gpt-test",
      input: [
        { role: "user", content: "hi" },
        { type: "function_call", call_id: "call_1", name: "run", arguments: args },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    });
    const { forwarded } = await send(hook, routes[2].url, raw);
    expect(forwarded).not.toContain(KEY);
  });
});

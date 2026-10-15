/**
 * Transparent pseudonymization integration tests (issue #22, stage 1).
 *
 * The OpenCode v2 plugin context is mocked (hook registration + captured
 * callbacks), all secrets are synthetic, and no network or OpenCode runtime
 * is involved. POSIX quoting tests additionally run controlled printf commands
 * through /bin/sh to verify exact argument bytes, without filesystem effects.
 * These tests exercise the guard's observable hook behavior through the
 * request boundary (four kinds + native http), the typed tool gate, cleanup,
 * and fail-closed refusals. They are NOT a native-hook/provider/client
 * ordering proof (see the stage-1 handoff).
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/opencode-transparent.js";
import { PSEUDONYM_TOKEN_PREFIX } from "../src/decision/pseudonymization.js";
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

// Letters-only credential: digit runs can nest a phone finding inside the
// credential span, which the accepted core rejects as an overlap.
const KEY = "sk-QwertyuiopAsdfghjklZx";
const EMAIL = "alice@example.com";
const TOKEN_RE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;
const FOREIGN_TOKEN = `[SGP1:${"deadbeef".repeat(4)}-00000001]`;

// Phone rules are opt-in since P2 (2026-10-07); tests that need a
// space-containing phone original enable them explicitly.
const phoneConfig: GuardConfig = {
  ...baseConfig,
  settings: { ...baseConfig.settings, rule_overrides: { "phone-tw": true } },
};

const PROTECT_FAILED = "Sensitive Guard transparent mode failed to protect a model request.";
const INIT_FAILED = "Sensitive Guard initialization failed";
const ATTRIBUTION_FAILED = "Sensitive Guard transparent mode blocked a response without verified request attribution.";
const UNSUPPORTED_ROUTE = "Sensitive Guard transparent mode blocked an unsupported model transport route";
const TOOL_REFUSED = "Sensitive Guard transparent mode blocked this tool call";

interface RecordedHook {
  domain: string;
  name: string;
  callback: (event: unknown) => unknown;
}

interface Harness {
  guard: ReturnType<typeof createTransparentSessionGuard>;
  registered: RecordedHook[];
  disposed: string[];
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown;
}

async function arm(config: GuardConfig = baseConfig, attachmentsPolicy: "block" | "allow" = "block", wireProtection = true): Promise<Harness> {
  const registered: RecordedHook[] = [];
  const disposed: string[] = [];
  const hookFor = (domain: string) => {
    return async (name: string, callback: unknown) => {
      registered.push({ domain, name, callback: callback as RecordedHook["callback"] });
      return { dispose: async () => void disposed.push(`${domain}:${name}`) };
    };
  };
  const ctx = {
    session: { hook: hookFor("session") },
    tool: { hook: hookFor("tool") },
    aisdk: { hook: hookFor("aisdk") },
  };
  const guard = createTransparentSessionGuard(config, attachmentsPolicy, wireProtection);
  await guard.setup(ctx as never);
  const hook = (name: string) => {
    const hit = registered.find((r) => `${r.domain}:${r.name}` === name);
    // Host emission with no outbound registration is a no-op, not a guard callback.
    if (!hit && !wireProtection && ["session:http.request", "session:experimental.ws.handshake", "session:experimental.ws.send", "aisdk:sdk", "aisdk:language"].includes(name)) return async () => undefined;
    if (hit === undefined) throw new Error(`missing hook ${name}`);
    // Host-side invocation: the callback may throw synchronously or return a
    // promise; the wrapper normalizes both to a rejected/fulfilled promise.
    return async (event: unknown) => hit.callback(event);
  };
  return { guard, registered, disposed, hook };
}

/** A v2-shaped model request event carrying secrets in every snapshot field. */
function requestEvent(sessionID = "session-1"): Record<string, unknown> {
  return {
    sessionID,
    agent: "agent-1",
    kind: "primary",
    model: { providerID: "openai", id: "gpt-test" },
    system: [{ type: "text", text: `system prompt for ${EMAIL}` }],
    messages: [
      {
        id: "msg_1",
        role: "user",
        content: [{ type: "text", text: `reach ${EMAIL} with ${KEY}` }],
      },
      {
        id: "msg_2",
        role: "assistant",
        content: [
          { type: "tool-call", input: { filePath: `/home/${KEY}/notes.txt` } },
        ],
      },
      {
        id: "msg_3",
        role: "tool",
        content: [
          {
            type: "tool-result",
            result: { type: "content", value: [{ type: "text", text: `tool saw ${KEY}` }] },
          },
        ],
      },
    ],
    options: { temperature: 0.7, [`owner-${EMAIL}`]: EMAIL },
    tools: {
      read: {
        description: `reads a file for ${EMAIL}`,
        input: {
          type: "object",
          properties: { filePath: { type: "string", description: "path" } },
          required: ["filePath"],
        },
      },
    },
  };
}

/** Mints an owned token for `secret` in `sessionID` via the context hook. */
async function mintToken(
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
  secret: string,
  sessionID = "session-1",
  kind = "primary",
): Promise<string> {
  const event = {
    sessionID,
    model: { providerID: "openai", id: "gpt-test" },
    system: [{ type: "text", text: `x ${secret} y` }],
    messages: [],
    options: {},
  };
  await hook(`session:${kind === "primary" ? "context" : kind}`)(event);
  const match = (event.system as Array<{ text: string }>)[0].text.match(TOKEN_RE);
  if (match === null) throw new Error("no token minted");
  return match[0];
}

function chatRequest(body: unknown, init: RequestInit = {}): Request {
  const { headers, ...rest } = init;
  return new Request("https://provider.example.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
      ...((headers as Record<string, string>) ?? {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...rest,
  });
}

function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const pump = async (): Promise<string> => {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
    return pump();
  };
  return pump();
}

function sseBody(chunks: string[], options: { errorAfter?: number } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.errorAfter !== undefined && index >= options.errorAfter) {
        throw new Error("upstream blew up");
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

function sseChunk(content: string, choiceIndex = 0): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1234,
    choices: [{ index: choiceIndex, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

// ─── Registration ────────────────────────────────────────────────────────────

describe("transparent session guard registration", () => {
  it("registers exactly the transparent hook set on the v2 context", async () => {
    const { registered } = await arm();
    expect(registered.map((r) => `${r.domain}:${r.name}`)).toEqual([
      "session:context",
      "session:compaction",
      "session:generate",
      "session:title",
      "session:http.request",
      "session:http.response",
      "session:experimental.ws.handshake",
      "session:experimental.ws.send",
      "session:experimental.ws.receive",
      "aisdk:sdk",
      "aisdk:language",
      "tool:execute.before",
    ]);
  });

  it("registers fail-closed hooks on every name when the core cannot initialize", async () => {
    const invalid: GuardConfig = { ...baseConfig, settings: { ...baseConfig.settings, max_chars: 0 } };
    const { hook, registered } = await arm(invalid);
    expect(registered).toHaveLength(12);
    for (const record of registered) {
      await expect((async () => record.callback({ sessionID: "s" }))()).rejects.toThrow(INIT_FAILED);
    }
    expect(hook("session:context")).toBeInstanceOf(Function);
  });

  it("dispose preserves unowned markers in chat but refuses them for tool restoration", async () => {
    const { guard, hook, disposed } = await arm();
    const token = await mintToken(hook, KEY);
    expect(token).toMatch(TOKEN_RE);

    await guard.dispose();
    expect(disposed).toHaveLength(12);
    // Reverse registration order: the last registration is disposed first.
    expect(disposed[0]).toBe("tool:execute.before");
    expect(disposed[disposed.length - 1]).toBe("session:context");

    // Unowned markers in ordinary conversation remain literal.
    const event = {
      sessionID: "session-1",
      kind: "primary",
      request: chatRequest({ model: "gpt-test", messages: [{ role: "user", content: `again ${token}` }] }),
    };
    await hook("session:http.request")(event);
    expect(await (event.request as Request).clone().text()).toContain(token);

    // The same unmapped token degrades for a proven read-only tool — the
    // argument keeps the literal placeholder, whose no-match output is the
    // in-band signal — while a side-effecting tool still refuses (P1).
    const readOnly = { tool: "read", sessionID: "session-1", input: { filePath: `/x/${FOREIGN_TOKEN}` } };
    await hook("tool:execute.before")(readOnly);
    expect(readOnly.input.filePath).toBe(`/x/${FOREIGN_TOKEN}`);
    await expect(
      hook("tool:execute.before")({
        tool: "write",
        sessionID: "session-1",
        input: { filePath: `/x/${FOREIGN_TOKEN}`, content: "data" },
      }),
    ).rejects.toThrow("placeholder has no mapping in this session");

    // Idempotent second dispose.
    await guard.dispose();
    expect(disposed).toHaveLength(12);
  });
});

// ─── Four request kinds: atomic snapshot protection ──────────────────────────

describe("transparent outbound request snapshots", () => {
  it("protects system, messages, options keys/values, and tool schemas atomically", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    await hook("session:context")(event);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized.match(TOKEN_RE)?.length ?? 0).toBeGreaterThanOrEqual(6);
    // Protocol metadata, numerics, ids, and structure are unchanged.
    expect(event.model).toEqual({ providerID: "openai", id: "gpt-test" });
    expect((event.options as Record<string, unknown>).temperature).toBe(0.7);
    expect((event.messages as Array<{ id: string }>)[0].id).toBe("msg_1");
    const tools = event.tools as Record<string, { input: Record<string, unknown> }>;
    expect(tools.read.input.properties).toBeDefined();
    // Tool-call inputs and tool-result text are tokenized for dispatch.
    const assistant = (event.messages as Array<{ content: Array<{ type: string; input?: unknown }> }>)[1];
    expect(JSON.stringify(assistant.content[0].input)).toMatch(TOKEN_RE);
  });

  it("applies the same protection to compaction, generate, and title kinds", async () => {
    const { hook } = await arm();
    for (const kind of ["compaction", "generate", "title"] as const) {
      const event = requestEvent();
      await hook(`session:${kind}`)(event);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain(KEY);
      expect(serialized).not.toContain(EMAIL);
    }
  });

  it("rolls back atomically: a refused snapshot leaves the event untouched", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    // A sensitive structural identifier is a genuine leak-risk refusal; a
    // placeholder-shaped id alone no longer refuses (P1, 2026-10-06b).
    (event.messages as Array<{ id: string }>)[0].id = EMAIL;
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow("scans as sensitive");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("preserves a placeholder-shaped structural identifier instead of refusing (P1)", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    // 02:07 shape: an orphan marker in a structural position is judged, not
    // refused — payload scans clean, so the id stays literal with a WARN.
    (event.messages as Array<{ id: string }>)[0].id = FOREIGN_TOKEN;
    await expect(hook("session:context")(event)).resolves.toBeUndefined();
    expect((event.messages as Array<{ id: string }>)[0].id).toBe(FOREIGN_TOKEN);
    expect(JSON.stringify(event)).not.toContain(KEY);
  });

  it("refuses events without a usable sessionID and leaves them untouched", async () => {
    const { hook } = await arm();
    for (const bad of [undefined, "", 7]) {
      const event = requestEvent();
      event.sessionID = bad;
      const before = JSON.stringify(event);
      await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
      expect(JSON.stringify(event)).toBe(before);
    }
  });

  it("replaces media/file attachments with an explanatory text part (conversation survives)", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
    await hook("session:context")(event);
    const content = (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    const last = content[content.length - 1];
    expect(last.type).toBe("text");
    expect(String(last.text)).toContain("attachment omitted");
    // The binary payload must be gone from the event entirely.
    expect(JSON.stringify(event)).not.toContain("aGVsbG8=");
    // The surrounding text still gets masked normally.
    expect(JSON.stringify(event)).toMatch(TOKEN_RE);
  });

  it("remasks restored local history on replay with the same stable token", async () => {
    const { hook } = await arm();
    const first = requestEvent();
    await hook("session:context")(first);
    const tokens = JSON.stringify(first).match(TOKEN_RE) ?? [];

    // Locally restored assistant content (originals) is replayed outbound.
    const replay = requestEvent();
    await hook("session:context")(replay);
    const replayTokens = JSON.stringify(replay).match(TOKEN_RE) ?? [];
    expect(replayTokens.length).toBeGreaterThanOrEqual(tokens.length);
    expect(new Set(replayTokens)).toEqual(new Set(tokens));
    expect(JSON.stringify(replay)).not.toContain(KEY);
  });

  it("preserves unknown marker examples in model history while masking nearby secrets", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    const literal = `foreign ${FOREIGN_TOKEN} malformed [SGP1:…] email ${EMAIL}`;
    ((event.messages as Array<{ content: Array<{ text: string }> }>)[0].content[0]).text = literal;

    await expect(hook("session:context")(event)).resolves.toBeUndefined();
    const text = ((event.messages as Array<{ content: Array<{ text: string }> }>)[0].content[0]).text;
    expect(text).toContain(FOREIGN_TOKEN);
    expect(text).toContain("[SGP1:…]");
    expect(text).not.toContain(EMAIL);
    expect(JSON.stringify(event)).not.toContain(KEY);
  });

  it("keeps tool restoration isolated to the issuing session", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY, "session-1");

    // P1 (2026-10-06b): session isolation still holds — a foreign session
    // never restores. A read-only tool degrades to the literal placeholder
    // (no cross-session restore), a side-effecting tool refuses.
    const readOnly = { tool: "read", sessionID: "session-2", input: { path: token } };
    await hook("tool:execute.before")(readOnly);
    expect(readOnly.input.path).toBe(token);
    await expect(
      hook("tool:execute.before")({ tool: "write", sessionID: "session-2", input: { filePath: "/x", content: token } }),
    ).rejects.toThrow(TOOL_REFUSED);
  });

  it("refuses numeric values when sensitivity scanning truncates them", async () => {
    const truncatedConfig: GuardConfig = {
      ...baseConfig,
      settings: { ...baseConfig.settings, max_chars: 10 },
    };
    const { hook } = await arm(truncatedConfig);
    const event = {
      sessionID: "truncated-number",
      system: [{ type: "text", text: "safe" }],
      messages: [],
      options: { pin: 10912345678 },
    };
    const before = JSON.stringify(event);

    await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    expect(JSON.stringify(event)).toBe(before);
  });

  it("refuses sensitive-looking structural identifiers instead of renaming them", async () => {
    const { hook } = await arm();
    const mutations: Array<(event: Record<string, unknown>) => void> = [
      (event) => {
        (event.messages as Array<{ id: string }>)[0].id = EMAIL;
      },
      (event) => {
        const tools = event.tools as Record<string, unknown>;
        tools[EMAIL] = tools.read;
        delete tools.read;
      },
      (event) => {
        const tool = (event.tools as Record<string, { input: { properties: Record<string, unknown> } }>).read;
        tool.input.properties[EMAIL] = { type: "string" };
      },
      (event) => {
        const tool = (event.tools as Record<string, { input: { properties: Record<string, { enum?: string[] }> } }>).read;
        tool.input.properties.filePath.enum = [EMAIL];
      },
    ];
    for (const mutate of mutations) {
      const event = requestEvent();
      mutate(event);
      const before = JSON.stringify(event);
      // P1 (2026-10-06b): genuine leak-risk refusals stay, with an actionable
      // content-free message naming the position kind.
      await expect(hook("session:context")(event)).rejects.toThrow(
        "structural identifier (message or tool id, name, role, or part type) scans as sensitive",
      );
      expect(JSON.stringify(event)).toBe(before);
    }
  });

  it("refuses a non-writable snapshot before consuming mapping capacity", async () => {
    const { hook } = await arm();
    // Publishing must fail BEFORE the mapping commit: otherwise rejected
    // requests would still exhaust the core session budget.
    for (let index = 0; index < 200; index++) {
      const event = requestEvent(`frozen-${index}`);
      for (const part of event.system as object[]) Object.freeze(part);
      await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    }
    const ok = requestEvent("fresh");
    await hook("session:context")(ok);
    expect(JSON.stringify(ok)).not.toContain(KEY);
  });

  it("refuses accessor-backed snapshot leaves before committing mappings", async () => {
    const { hook } = await arm();
    for (let index = 0; index < 128; index++) {
      const event = requestEvent(`accessor-${index}`);
      const part = (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content[0];
      Object.defineProperty(part, "text", {
        enumerable: true,
        configurable: true,
        get: () => `contact ${EMAIL}`,
        set: () => {
          throw new TypeError("read-only host field");
        },
      });
      await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    }

    const fresh = requestEvent("fresh-after-accessor-failures");
    await expect(hook("session:context")(fresh)).resolves.toBeUndefined();
    expect(JSON.stringify(fresh)).not.toContain(EMAIL);
  });

  it("refuses custom JSON projections before committing mappings", async () => {
    const { hook } = await arm();
    for (let index = 0; index < 128; index++) {
      const event = requestEvent(`tojson-${index}`);
      Object.defineProperty(event.options, "toJSON", {
        value: () => ({ temperature: 0.7, [`secret-${EMAIL}`]: EMAIL }),
      });
      await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    }

    const fresh = requestEvent("fresh-after-tojson-failures");
    await expect(hook("session:context")(fresh)).resolves.toBeUndefined();
    expect(JSON.stringify(fresh)).not.toContain(EMAIL);
  });

  it("does not retain failed-session state that would block later work", async () => {
    const { hook } = await arm();
    const bad = requestEvent("session-x");
    // Genuine leak-risk refusal (sensitive structural id) — placeholder ids
    // no longer fail (P1, 2026-10-06b).
    (bad.messages as Array<{ id: string }>)[0].id = EMAIL;
    await expect(hook("session:context")(bad)).rejects.toThrow("scans as sensitive");

    // The same session remains usable after a failed operation.
    const good = requestEvent("session-x");
    await hook("session:context")(good);
    expect(JSON.stringify(good)).not.toContain(KEY);
  });
});

// ─── Typed tool gate ─────────────────────────────────────────────────────────

describe("transparent hook-first HTTP boundary", () => {
  it.each([true, false])("keeps request-hook masking with wireProtection=%s", async (wireProtection) => {
    const { hook } = await arm(baseConfig, "block", wireProtection);
    const event = requestEvent();
    await hook("session:context")(event);
    expect(JSON.stringify(event)).not.toContain(KEY);
    expect(JSON.stringify(event)).not.toContain(EMAIL);
  });

  it("keeps final request identity and does not inspect or mask its body in hook-first mode", async () => {
    const { hook } = await arm(baseConfig, "block", false);
    // Simulates content added after context hooks. This is deliberately outside
    // hook-first coverage; the stronger mode still masks it in existing tests.
    const request = chatRequest({ model: "gpt-test", messages: [{ role: "user", content: KEY }] });
    const original = await request.clone().text();
    const event = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(event);
    expect(event.request).toBe(request);
    expect(await event.request.clone().text()).toBe(original);
  });

  it("does not reject a supported route merely because its final body dialect is unknown", async () => {
    const { hook } = await arm(baseConfig, "block", false);
    const request = chatRequest({ provider_extension: "opaque" });
    const event = { sessionID: "session-1", kind: "primary", request };
    await expect(hook("session:http.request")(event)).resolves.toBeUndefined();
    expect(event.request).toBe(request);
  });

  it("retains response restoration and isolation for sessions and request kinds", async () => {
    const { hook } = await arm(baseConfig, "block", false);
    const cases = [
      { sessionID: "session-1", kind: "primary", secret: KEY },
      { sessionID: "session-2", kind: "title", secret: EMAIL },
    ];
    for (const { sessionID, kind, secret } of cases) {
      const token = await mintToken(hook, secret, sessionID, kind);
      const model = { providerID: "openai", id: "gpt-test" };
      const requestEvent = { sessionID, kind, model, request: chatRequest({ messages: [{ role: "user", content: token }] }) };
      await hook("session:http.request")(requestEvent);
      const makeResponse = () => new Response(JSON.stringify({ choices: [{
        index: 0, message: { role: "assistant", content: token },
      }] }), { headers: { "content-type": "application/json" } });
      for (const mismatch of [{ sessionID: "other", kind }, { sessionID, kind: "generate" }]) {
        const event = { ...mismatch, model, request: requestEvent.request, response: makeResponse() };
        await hook("session:http.response")(event);
        expect((await event.response.json()).choices[0].message.content).toBe(token);
      }
      const cloned = { sessionID, kind, model, request: requestEvent.request.clone(), response: makeResponse() };
      await hook("session:http.response")(cloned);
      expect((await cloned.response.json()).choices[0].message.content).toBe(secret);
      const responseEvent = { sessionID, kind, model, request: requestEvent.request, response: makeResponse() };
      await hook("session:http.response")(responseEvent);
      const body = await responseEvent.response.json();
      expect(body.choices[0].message.content).toBe(secret);
      const toolEvent = { sessionID, tool: "read", input: { filePath: token } };
      await hook("tool:execute.before")(toolEvent);
      expect(toolEvent.input.filePath).toBe(secret);
    }
  });

  it("restores split-token SSE on an attributed hook-first retry", async () => {
    const { hook } = await arm(baseConfig, "block", false);
    const token = await mintToken(hook, KEY);
    const request = chatRequest({ messages: [{ role: "user", content: token }] });
    const requestEvent = { sessionID: "session-1", kind: "primary", model: { providerID: "openai", id: "gpt-test" }, request };
    await hook("session:http.request")(requestEvent);
    await hook("session:http.request")(requestEvent);
    const event = {
      ...requestEvent,
      response: new Response(sseBody([sseChunk(token.slice(0, 17)), sseChunk(token.slice(17)), "data: [DONE]\n\n"]),
        { headers: { "content-type": "text/event-stream" } }),
    };
    await hook("session:http.response")(event);
    const text = await event.response.text();
    expect(text).toContain(KEY);
    expect(text).not.toContain("[SGP1:");
  });

  it("does not gate unknown routes or inspect transport metadata in hook-only mode", async () => {
    const { hook } = await arm(baseConfig, "block", false);
    for (const request of [
      new Request("https://provider.example.com/custom", { method: "POST", body: "{}" }),
      new Request("ws://provider.example.com/v1/responses", { method: "POST", body: "{}" }),
      chatRequest({ messages: [] }, { headers: { "x-owner": EMAIL } }),
    ]) {
      const event = { sessionID: "session-1", kind: "primary", request };
      await expect(hook("session:http.request")(event)).resolves.toBeUndefined();
      expect(event.request).toBe(request);
      const reply = { ...event, response: new Response("{}") };
      await hook("session:http.response")(reply);
      expect(await reply.response.text()).toBe("{}");
    }
  });

  it.each(["session:experimental.ws.handshake", "session:experimental.ws.send", "aisdk:sdk", "aisdk:language"])(
    "does not register transport admission at %s in hook-only mode", async (name) => {
      const { hook, registered } = await arm(baseConfig, "block", false);
      expect(registered.some((r) => `${r.domain}:${r.name}` === name)).toBe(false);
      await expect(hook(name)({ sessionID: "s", frame: "{}" })).resolves.toBeUndefined();
    },
  );

  it.each(["block", "allow"] as const)("keeps attachment policy at content hooks with %s", async (policy) => {
    const { hook } = await arm(baseConfig, policy, false);
    const media = { type: "media", mime: "image/png", data: Buffer.from(KEY).toString("base64") };
    const event = {
      sessionID: "session-1", system: [], options: {},
      messages: [{ role: "user", content: [{ type: "text", text: KEY }, media] }],
    };
    await hook("session:context")(event);
    expect(JSON.stringify(event)).not.toContain(KEY);
    if (policy === "allow") {
      expect(event.messages[0].content[1]).toEqual(media);
    } else {
      expect(JSON.stringify(event)).not.toContain(media.data);
    }
  });

  it("does not pretend persisted tool-argument tokens can be reconstructed after mapping loss", async () => {
    const { hook, guard } = await arm(baseConfig, "block", false);
    const token = await mintToken(hook, KEY);
    const requestEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ messages: [] }) };
    await hook("session:http.request")(requestEvent);
    const persistedArguments = JSON.stringify({ filePath: token });
    const event = {
      ...requestEvent,
      response: new Response(JSON.stringify({ choices: [{ message: {
        role: "assistant", content: null,
        tool_calls: [{ id: "call_read", type: "function", function: { name: "write", arguments: persistedArguments } }],
      } }] }), { headers: { "content-type": "application/json" } }),
    };
    await hook("session:http.response")(event);
    const response = await event.response.json();
    expect(response.choices[0].message.tool_calls[0].function.arguments).toBe(persistedArguments);
    const liveInput = JSON.parse(persistedArguments);
    await hook("tool:execute.before")({ sessionID: "session-1", tool: "write", input: liveInput });
    expect(liveInput.filePath).toBe(KEY);
    await guard.dispose();
    const restarted = await arm(baseConfig, "block", false);
    const newToken = await mintToken(restarted.hook, KEY);
    expect(newToken).not.toBe(token);
    await expect(restarted.hook("tool:execute.before")({ sessionID: "session-1", tool: "write", input: JSON.parse(persistedArguments) }))
      .rejects.toThrow(TOOL_REFUSED);
  });
});

describe("transparent tool execution gate", () => {
  it("restores registered tokens in tool inputs before execution", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    for (const tool of ["read", "grep", "write", "edit"]) {
      const input = { filePath: `/data/${token}`, content: `x ${token} y` };
      await expect(
        hook("tool:execute.before")({ tool, sessionID: "session-1", input }),
      ).resolves.toBeUndefined();
      expect(input).toEqual({ filePath: `/data/${KEY}`, content: `x ${KEY} y` });
    }
  });

  it("restores an owned token when the tool input itself is a string", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const event: Record<string, unknown> = { tool: "read", sessionID: "session-1", input: token };

    await expect(hook("tool:execute.before")(event)).resolves.toBeUndefined();
    expect(event.input).toBe(KEY);
  });

  it("restores a shell-safe token inside a shell command", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const input = { command: `echo ${token}` };
    await expect(
      hook("tool:execute.before")({ tool: "bash", sessionID: "session-1", input }),
    ).resolves.toBeUndefined();
    expect(input).toEqual({ command: `echo ${KEY}` });
  });

  it.skipIf(process.platform === "win32").each(["'", '"'])("restores a complete %s-quoted shell argument without changing its quoting", async (quote) => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const input = { command: `printf %s ${quote}${token}${quote}` };

    await hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input });

    expect(input.command).toBe(`printf %s ${quote}${KEY}${quote}`);
    expect(execFileSync("/bin/sh", ["-c", input.command], { encoding: "utf8" })).toBe(KEY);
  });

  it.skipIf(process.platform === "win32").each(["'", '"'])("keeps a space-containing original as one %s-quoted argument", async (quote) => {
    const { hook } = await arm(phoneConfig);
    const phone = "0912 345 678";
    const token = await mintToken(hook, phone);
    const input = { command: `printf '%s' ${quote}${token}${quote}` };

    await hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input });

    expect(execFileSync("/bin/sh", ["-c", input.command], { encoding: "utf8" })).toBe(phone);
  });

  it.skipIf(process.platform === "win32").each([">", ">>"])("restores a quoted argument with static %s output redirection", async (operator) => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const input = { command: `printf '%s' '${token}' ${operator} 'result file.txt'` };

    await hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input });

    expect(input.command).toBe(`printf '%s' '${KEY}' ${operator} 'result file.txt'`);
  });

  it.skipIf(process.platform === "win32")("keeps shell metacharacters literal inside a complete single-quoted argument", async () => {
    const original = "$(printf INJECTED); * & $HOME";
    const config: GuardConfig = { ...baseConfig, nda_keywords: [original] };
    const { hook } = await arm(config);
    const token = await mintToken(hook, original);
    const input = { command: `printf %s '${token}'` };

    await hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input });

    expect(execFileSync("/bin/sh", ["-c", input.command], { encoding: "utf8" })).toBe(original);
  });

  it("refuses an original that could break its single-quote context without changing any input", async () => {
    const original = "unsafe'quote";
    const { hook } = await arm({ ...baseConfig, nda_keywords: [original] });
    const token = await mintToken(hook, original);
    const input = { command: `printf %s '${token}'` };
    await expect(hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input }))
      .rejects.toThrow(TOOL_REFUSED);
    expect(input.command).toBe(`printf %s '${token}'`);
  });

  it.each(['unsafe"quote', "$HOME", "$(printf INJECTED)", "`printf INJECTED`", "back\\slash"])(
    "refuses an original unsafe inside double quotes: %s", async (original) => {
      const { hook } = await arm({ ...baseConfig, nda_keywords: [original] });
      const token = await mintToken(hook, original);
      const input = { command: `printf %s "${token}"` };
      await expect(hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input }))
        .rejects.toThrow(TOOL_REFUSED);
      expect(input.command).toBe(`printf %s "${token}"`);
    },
  );

  it("does not admit expansion, concatenation, scripts, or tokenized redirect targets with quoted tokens", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const commands = [
      `'${token}' --argument`,
      `SECRET='${token}' printf safe`,
      `printf %s prefix'${token}'`,
      `printf %s '${token}'suffix`,
      `printf %s "${token}$HOME"`,
      `printf %s '${token}' $(printf INJECTED)`,
      `printf %s '${token}' | cat`,
      `printf %s '${token}'; printf INJECTED`,
      `"sh" '-c' '${token}'`,
      `'python' '-c' '${token}'`,
      `node '--eval' '${token}'`,
      `printf %s '${token}' > '${token}'`,
      `printf %s '${token}' >`,
      `printf %s '${token}' > result.txt trailing`,
      `printf %s '${token}' > $HOME/result.txt`,
      `printf %s '${token}' 2> result.txt`,
      `printf %s '${token}' < input.txt`,
      `printf %s '${token}'\necho INJECTED`,
      `printf %s '${token}`,
      `printf %s "${token}`,
    ];
    for (const command of commands) {
      const input = { command };
      await expect(hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input }))
        .rejects.toThrow(TOOL_REFUSED);
      expect(input.command).toBe(command);
    }
  });

  it("still refuses option-injecting originals even inside quotes", async () => {
    const original = "-danger";
    const { hook } = await arm({ ...baseConfig, nda_keywords: [original] });
    const token = await mintToken(hook, original);
    for (const quote of ["'", '"']) {
      const input = { command: `printf %s ${quote}${token}${quote}` };
      await expect(hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input }))
        .rejects.toThrow(TOOL_REFUSED);
      expect(input.command).toBe(`printf %s ${quote}${token}${quote}`);
    }
  });

  it("refuses a shell command whose original is not shell-safe, leaving it unchanged", async () => {
    const { hook } = await arm(phoneConfig);
    // A phone value with spaces is detected and tokenized, but substituting it
    // verbatim into a shell command would change word splitting.
    const phone = "0912 345 678";
    const token = await mintToken(hook, phone);
    const input = { command: `echo ${token}` };
    await expect(
      hook("tool:execute.before")({ tool: "bash", sessionID: "session-1", input }),
    ).rejects.toThrow("shell command does not use a supported literal-argument form");
    expect(input.command).toBe(`echo ${token}`);
  });

  it("allows a non-ASCII original in a shell command (ordinary word bytes)", async () => {
    const cjkConfig: GuardConfig = {
      ...baseConfig,
      custom_rules: [{ description: "cjk", pattern: "機密資料", severity: "HIGH" }],
    };
    const { hook } = await arm(cjkConfig);
    const token = await mintToken(hook, "機密資料");
    const input = { command: `echo ${token}` };
    await expect(
      hook("tool:execute.before")({ tool: "bash", sessionID: "session-1", input }),
    ).resolves.toBeUndefined();
    expect(input.command).toBe("echo 機密資料");
  });

  it("treats an unrecognized tool as shell-like (fail-closed)", async () => {
    const { hook } = await arm(phoneConfig);
    const phone = "0912 345 678";
    const token = await mintToken(hook, phone);

    // Unknown tool name, no `command` field: still checked, so the unsafe
    // original is refused.
    await expect(
      hook("tool:execute.before")({ tool: "mystery_tool", sessionID: "session-1", input: { value: token } }),
    ).rejects.toThrow(TOOL_REFUSED);

    // The same value restores normally for a known non-executing tool.
    const input = { value: token };
    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-1", input }),
    ).resolves.toBeUndefined();
    expect(input.value).toBe(phone);
  });

  it("refuses a shell command where the token is not a standalone word", async () => {
    const { hook } = await arm();
    // A character-safe value is still unsafe in `$TOKEN` (it would become a
    // variable reference) — the position, not just the characters, must be safe.
    const token = await mintToken(hook, KEY);
    for (const command of [`printf %s $${token}`, `echo x${token}`, `echo \`${token}\``]) {
      const input = { command };
      await expect(
        hook("tool:execute.before")({ tool: "shell", sessionID: "session-1", input }),
      ).rejects.toThrow(TOOL_REFUSED);
      expect(input.command).toBe(command);
    }
  });

  it("refuses shell syntax outside the supported literal-argument subset", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const commands = [
      [`cat << ${token}`, KEY, "touch marker", token].join("\n"),
      `${token} --argument`,
      `echo safe; echo ${token}`,
      `sh -c ${token}`,
      `python -c ${token}`,
      `node -p ${token}`,
      `VAR=1 ${token}`,
      `env ${token}`,
      `eval ${token}`,
    ];

    for (const command of commands) {
      const input = { command };
      await expect(
        hook("tool:execute.before")({ tool: "bash", sessionID: "session-1", input }),
      ).rejects.toThrow(TOOL_REFUSED);
      expect(input.command).toBe(command);
    }
  });

  it("leaves a tool input untouched when a later assignment would fail", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const input: Record<string, unknown> = { a: token };
    Object.defineProperty(input, "b", { value: token, writable: false, enumerable: true });
    await expect(
      hook("tool:execute.before")({ tool: "write", sessionID: "session-1", input }),
    ).rejects.toThrow(TOOL_REFUSED);
    expect(input.a).toBe(token);
  });

  it("refuses an unwritable array slot before changing earlier tool arguments", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const values = [token];
    Object.defineProperty(values, "0", { value: token, writable: false, enumerable: true });
    const input = { first: token, values };

    await expect(
      hook("tool:execute.before")({ tool: "write", sessionID: "session-1", input }),
    ).rejects.toThrow(TOOL_REFUSED);
    expect(input.first).toBe(token);
    expect(input.values[0]).toBe(token);
  });

  it("passes token-free calls through unchanged, including shell tools", async () => {
    const { hook } = await arm();
    const input = { filePath: "/data/notes.txt" };
    await expect(
      hook("tool:execute.before")({ tool: "bash", sessionID: "session-1", input: { command: "ls -la" } }),
    ).resolves.toBeUndefined();
    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-1", input }),
    ).resolves.toBeUndefined();
    expect(input).toEqual({ filePath: "/data/notes.txt" });
  });

  it("degrades foreign tokens for read-only tools but refuses side-effecting ones", async () => {
    const { hook } = await arm();
    // P1 (2026-10-06b): a read-only tool keeps the literal placeholder —
    // its no-match output is the in-band signal — instead of refusing.
    const readOnly = { filePath: `/x/${FOREIGN_TOKEN}` };
    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-1", input: readOnly }),
    ).resolves.toBeUndefined();
    expect(readOnly.filePath).toBe(`/x/${FOREIGN_TOKEN}`);
    // A side-effecting tool still refuses the affected invocation.
    await expect(
      hook("tool:execute.before")({
        tool: "write",
        sessionID: "session-1",
        input: { filePath: `/x/${FOREIGN_TOKEN}`, content: "data" },
      }),
    ).rejects.toThrow("placeholder has no mapping in this session");
  });

  it("refuses tokens hidden in object keys as well as values", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-1", input: { [token]: "x" } }),
    ).rejects.toThrow("argument structure cannot be safely restored");
    await expect(
      hook("tool:execute.before")({
        tool: "read",
        sessionID: "session-1",
        input: { nested: { [FOREIGN_TOKEN]: 1 } },
      }),
    ).rejects.toThrow(TOOL_REFUSED);
  });
});

// ─── http.request: final wire mask ───────────────────────────────────────────

describe("transparent http.request wire mask", () => {
  it("remasks content and tool arguments while preserving transport controls", async () => {
    const { hook } = await arm();
    const request = chatRequest(
      {
        model: "gpt-test",
        temperature: 0.5,
        stream: false,
        messages: [
          { role: "user", content: `hello ${KEY} and ${EMAIL}` },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: `/tmp/${EMAIL}` }) },
              },
            ],
          },
        ],
      },
      {
        headers: { "content-encoding": "gzip", "x-trace": "trace-1" },
        credentials: "include",
        mode: "cors",
        redirect: "follow",
        referrer: "about:client",
      },
    );
    const event = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(event);

    const rebuilt = event.request as Request;
    expect(rebuilt).not.toBe(request);
    const wire = JSON.parse(await rebuilt.clone().text());
    expect(wire.model).toBe("gpt-test");
    expect(wire.temperature).toBe(0.5);
    expect(wire.messages[0].content).not.toContain(KEY);
    expect(wire.messages[0].content).toMatch(TOKEN_RE);
    const args = JSON.parse(wire.messages[1].tool_calls[0].function.arguments);
    expect(args.path).not.toContain(EMAIL);
    expect(args.path).toMatch(TOKEN_RE);

    expect(rebuilt.method).toBe("POST");
    expect(rebuilt.url).toBe(request.url);
    expect(rebuilt.credentials).toBe("include");
    expect(rebuilt.mode).toBe("cors");
    expect(rebuilt.redirect).toBe("follow");
    expect(rebuilt.referrer).toBe("about:client");
    expect(rebuilt.headers.get("authorization")).toBe("Bearer test-key");
    expect(rebuilt.headers.get("x-trace")).toBe("trace-1");
    expect(rebuilt.headers.get("content-type")).toBe("application/json");
    expect(rebuilt.headers.get("content-encoding")).toBe(null);
    expect(rebuilt.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(JSON.stringify(wire)).length),
    );
  });

  it("retains the original request object when nothing changes", async () => {
    const { hook } = await arm();
    const request = chatRequest({ model: "gpt-test", messages: [{ role: "user", content: "safe text" }] });
    const event = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(event);
    expect(event.request).toBe(request);
    // Original body still readable (clone-read semantics).
    expect(JSON.parse(await request.clone().text()).messages[0].content).toBe("safe text");
  });

  it("refuses bodied requests it cannot identify", async () => {
    const { hook } = await arm();
    const notJson = chatRequest("not json at all");
    await expect(
      hook("session:http.request")({ sessionID: "session-1", kind: "primary", request: notJson }),
    ).rejects.toThrow();

    const withImage = chatRequest({
      model: "g",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }] },
      ],
    });
    await expect(
      hook("session:http.request")({ sessionID: "session-1", kind: "primary", request: withImage }),
    ).rejects.toThrow();

    const badArgs = chatRequest({
      model: "g",
      messages: [{ role: "assistant", content: null, tool_calls: [{ function: { name: "w", arguments: "{oops" } }] }],
    });
    await expect(
      hook("session:http.request")({ sessionID: "session-1", kind: "primary", request: badArgs }),
    ).rejects.toThrow();
  });

  it("refuses requests on an unsupported route, including bodyless ones", async () => {
    const { hook } = await arm();
    // A bodiless request carries content we cannot verify in query/headers;
    // the routing gate refuses anything that is not chat completions.
    const request = new Request("https://provider.example.com/v1/models");
    const event = { sessionID: "session-1", kind: "primary", request };
    await expect(hook("session:http.request")(event)).rejects.toThrow();
    expect(event.request).toBe(request);
  });

  it("preserves unowned markers as literal model-bound text", async () => {
    const { hook } = await arm();
    const request = chatRequest({
      model: "g",
      messages: [{ role: "user", content: `odd ${FOREIGN_TOKEN} token` }],
    });
    const event = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(event);
    expect(await (event.request as Request).clone().text()).toContain(FOREIGN_TOKEN);
  });

  it("supports Anthropic Messages routes; refuses unsupported routes and mixed dialects", async () => {
    const { hook } = await arm();
    // Phase 3: the Anthropic Messages wire route is now masked, not refused.
    const anthropicRoute = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "m",
        system: "system prompt",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        max_tokens: 10,
      }),
    });
    // Resolving (not rejecting) is the success signal: the hook rewrites
    // event.request in place and returns void.
    await hook("session:http.request")({ sessionID: "s", kind: "primary", request: anthropicRoute });

    // A `/responses` URL is not chat completions, even with a messages body.
    const responsesRoute = new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: responsesRoute }),
    ).rejects.toThrow();

    // Chat path but Anthropic-shaped: a top-level `system` this masker cannot place.
    const chatAnthropic = chatRequest({
      model: "m",
      system: "system prompt",
      messages: [{ role: "user", content: "hi" }],
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: chatAnthropic }),
    ).rejects.toThrow();

    // OpenAI `tools` entries must be function-shaped.
    const badTools = chatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read", input_schema: { type: "object" } }],
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: badTools }),
    ).rejects.toThrow();
  });

  it("preserves judged-clean placeholders in headers and urls but preserves authentication headers", async () => {
    const { hook } = await arm();
    // P1 (2026-10-06b): a placeholder in a header/query/url is judged, not
    // refused — clean markers stay literal with a content-free WARN;
    // sensitive content would still refuse (unmaskable position).
    const tokenHeader = chatRequest(
      { model: "g", messages: [{ role: "user", content: "safe" }] },
      { headers: { "x-custom": `value ${FOREIGN_TOKEN}` } },
    );
    const headerEvent = { sessionID: "s", kind: "primary", request: tokenHeader };
    await hook("session:http.request")(headerEvent);
    expect((headerEvent.request as Request).headers.get("x-custom")).toContain(FOREIGN_TOKEN);

    // A token in the query string is equally preserved literally.
    const tokenQuery = new Request(
      `https://provider.example.com/v1/chat/completions?q=${encodeURIComponent(FOREIGN_TOKEN)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: JSON.stringify({ model: "g", messages: [{ role: "user", content: "safe" }] }),
      },
    );
    const queryEvent = { sessionID: "s", kind: "primary", request: tokenQuery };
    await hook("session:http.request")(queryEvent);
    expect((queryEvent.request as Request).url).toContain(encodeURIComponent(FOREIGN_TOKEN));

    const clean = chatRequest({ model: "g", messages: [{ role: "user", content: "safe" }] });
    const event = { sessionID: "s", kind: "primary", request: clean };
    await hook("session:http.request")(event);
    expect((event.request as Request).headers.get("authorization")).toBe("Bearer test-key");
  });

  it("field-aware exemption: opt-in URL rule never refuses transport positions, body URLs still mask", async () => {
    const urlConfig: GuardConfig = {
      ...baseConfig,
      settings: { ...baseConfig.settings, rule_overrides: { url: true } },
    };
    const { hook } = await arm(urlConfig);

    // Historical regression shape: endpoint URL + URL-valued query + token in query.
    const request = new Request(
      `https://provider.example.com/v1/chat/completions?cb=https://app.example.com/hook&q=${encodeURIComponent(FOREIGN_TOKEN)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-source": "https://internal.example.com/ref",
        },
        body: JSON.stringify({
          model: "g",
          messages: [{ role: "user", content: "see https://secret.example.com/panel now" }],
        }),
      },
    );
    const event = { sessionID: "s", kind: "primary", request };
    await hook("session:http.request")(event);

    const out = event.request as Request;
    expect(out.url).toContain("provider.example.com/v1/chat/completions");
    expect(out.url).toContain(encodeURIComponent(FOREIGN_TOKEN));
    expect(out.headers.get("x-source")).toBe("https://internal.example.com/ref");
    expect(out.headers.get("authorization")).toBe("Bearer test-key");

    const body = JSON.parse(await out.text()) as { messages: Array<{ content: string }> };
    expect(body.messages[0].content).toContain("[SGP2:");
    expect(body.messages[0].content).not.toContain("secret.example.com");

    // Exemption is field-aware, not rule-wide: a real secret in a transport
    // position still refuses.
    const badHeader = chatRequest(
      { model: "g", messages: [{ role: "user", content: "safe" }] },
      { headers: { "x-key": "sk-abcdefghij1234567890" } },
    );
    const badEvent = { sessionID: "s", kind: "primary", request: badHeader };
    await expect(hook("session:http.request")(badEvent)).rejects.toThrow();
  });

  it("preserves unknown marker examples on the wire while masking other content", async () => {
    const { hook } = await arm();
    const request = chatRequest({
      model: "g",
      messages: [{ role: "user", content: `document ${FOREIGN_TOKEN} and [SGP1:…]; contact ${EMAIL}` }],
    });
    const event = { sessionID: "session-1", kind: "primary", request };

    await hook("session:http.request")(event);
    const wire = await (event.request as Request).clone().text();
    expect(wire).toContain(FOREIGN_TOKEN);
    expect(wire).toContain("[SGP1:…]");
    expect(wire).not.toContain(EMAIL);
  });

  it("masks tool descriptions and arbitrary body fields on the wire", async () => {
    const { hook } = await arm();
    const request = chatRequest({
      model: "g",
      messages: [{ role: "user", content: "safe" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            description: `reads files for ${EMAIL}`,
            parameters: { type: "object", properties: { filePath: { type: "string" } } },
          },
        },
      ],
      metadata: { note: `uses ${EMAIL}` },
    });
    const event = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(event);
    const wire = JSON.parse(await (event.request as Request).clone().text());
    expect(JSON.stringify(wire)).not.toContain(EMAIL);
    expect(wire.tools[0].function.name).toBe("read");
    expect(wire.tools[0].function.parameters.properties.filePath).toBeDefined();
  });

  it("refuses a request body larger than the read cap", async () => {
    const { hook } = await arm();
    const oversized = "a".repeat(4 * 1024 * 1024 + 1);
    const request = chatRequest({ model: "g", messages: [{ role: "user", content: oversized }] });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request }),
    ).rejects.toThrow();
  });

  it("inspects non-auth headers and query parameters on the wire", async () => {
    const { hook } = await arm();
    const headerLeak = chatRequest(
      { model: "g", messages: [{ role: "user", content: "safe" }] },
      { headers: { "x-context": `owner ${EMAIL}` } },
    );
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: headerLeak }),
    ).rejects.toThrow();

    const queryLeak = new Request(
      `https://provider.example.com/v1/chat/completions?q=${encodeURIComponent(EMAIL)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: JSON.stringify({ model: "g", messages: [{ role: "user", content: "safe" }] }),
      },
    );
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: queryLeak }),
    ).rejects.toThrow();

    // Authentication header content is legitimate and must remain intact.
    const clean = chatRequest({ model: "g", messages: [{ role: "user", content: "safe" }] });
    const event = { sessionID: "s", kind: "primary", request: clean };
    await hook("session:http.request")(event);
    expect((event.request as Request).headers.get("authorization")).toBe("Bearer test-key");
  });

  it("refuses sensitive numeric metadata and token-bearing schema keys", async () => {
    const numericConfig: GuardConfig = {
      ...baseConfig,
      custom_rules: [{ description: "pin code", pattern: "12345678", severity: "HIGH" }],
    };
    const { hook } = await arm(numericConfig);

    const numericPin = chatRequest({
      model: "g",
      messages: [{ role: "user", content: "safe" }],
      metadata: { pin: 12345678 },
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: numericPin }),
    ).rejects.toThrow();

    const tokenKey = chatRequest({
      model: "g",
      messages: [{ role: "user", content: "safe" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: { type: "object", properties: { [FOREIGN_TOKEN]: { type: "string" } } },
          },
        },
      ],
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: tokenKey }),
    ).rejects.toThrow();
  });

  it("commits no mapping for a request rejected after content validation", async () => {
    const { hook } = await arm();
    // Each request carries an email (would-be mapping) followed by an
    // unsupported image; validation must reject before any token is issued.
    for (let index = 0; index < 200; index++) {
      const request = chatRequest({
        model: "g",
        messages: [
          { role: "user", content: `mail ${EMAIL}` },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }],
          },
        ],
      });
      await expect(
        hook("session:http.request")({ sessionID: `s-${index}`, kind: "primary", request }),
      ).rejects.toThrow();
    }
    // The core session capacity must be untouched: a fresh session still works.
    const ok = chatRequest({ model: "g", messages: [{ role: "user", content: `mail ${EMAIL}` }] });
    const event = { sessionID: "fresh", kind: "primary", request: ok };
    await hook("session:http.request")(event);
    const wire = await (event.request as Request).clone().text();
    expect(wire).not.toContain(EMAIL);
    expect(wire).toMatch(TOKEN_RE);
  });

  it("does not commit mappings when the HTTP hook cannot publish its masked request", async () => {
    const { hook } = await arm();
    for (let index = 0; index < 128; index++) {
      const event: Record<string, unknown> = { sessionID: `readonly-${index}`, kind: "primary" };
      Object.defineProperty(event, "request", {
        value: chatRequest({ model: "g", messages: [{ role: "user", content: `mail ${EMAIL}` }] }),
        enumerable: true,
      });
      await expect(hook("session:http.request")(event)).rejects.toThrow();
    }

    const event = {
      sessionID: "fresh-after-readonly-publication-failures",
      kind: "primary",
      request: chatRequest({ model: "g", messages: [{ role: "user", content: `mail ${EMAIL}` }] }),
    };
    await hook("session:http.request")(event);
    expect(await (event.request as Request).clone().text()).not.toContain(EMAIL);
  });

  it("refuses sensitive numeric tool arguments before committing capacity", async () => {
    const { hook } = await arm(phoneConfig);
    // A JSON-encoded numeric pin that the phone detector matches. Protecting it
    // as a raw string would corrupt the JSON after the commit; it must refuse
    // BEFORE any mapping is issued.
    for (let index = 0; index < 200; index++) {
      const request = chatRequest({
        model: "g",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ pin: 10912345678 }) },
              },
            ],
          },
        ],
      });
      await expect(
        hook("session:http.request")({ sessionID: `s-${index}`, kind: "primary", request }),
      ).rejects.toThrow();
    }
    // Core capacity is untouched: a fresh session still protects content.
    const ok = chatRequest({ model: "g", messages: [{ role: "user", content: `mail ${EMAIL}` }] });
    const event = { sessionID: "fresh", kind: "primary", request: ok };
    await hook("session:http.request")(event);
    const wire = await (event.request as Request).clone().text();
    expect(wire).not.toContain(EMAIL);
    expect(wire).toMatch(TOKEN_RE);
  });

  it("masks legacy function-call arguments as parsed JSON before re-encoding", async () => {
    const { hook } = await arm();
    const request = chatRequest({
      model: "g",
      messages: [
        { role: "assistant", content: null, function_call: { name: "write", arguments: JSON.stringify({ note: EMAIL }) } },
      ],
    });
    const event = { sessionID: "session-1", kind: "primary", request };

    await hook("session:http.request")(event);
    const wire = JSON.parse(await (event.request as Request).clone().text());
    const args = wire.messages[0].function_call.arguments;
    expect(JSON.parse(args).note).toMatch(TOKEN_RE);
    expect(args).not.toContain(EMAIL);
  });

  it("rejects unsafe numeric values inside legacy arguments before committing capacity", async () => {
    const { hook } = await arm(phoneConfig);
    for (let index = 0; index < 200; index++) {
      const request = chatRequest({
        model: "g",
        messages: [
          {
            role: "assistant",
            content: null,
            function_call: { name: "write", arguments: JSON.stringify({ pin: 10912345678 }) },
          },
        ],
      });
      await expect(
        hook("session:http.request")({ sessionID: `legacy-${index}`, kind: "primary", request }),
      ).rejects.toThrow();
    }

    const request = chatRequest({ model: "g", messages: [{ role: "user", content: `mail ${EMAIL}` }] });
    const event = { sessionID: "fresh-after-legacy-rejections", kind: "primary", request };
    await hook("session:http.request")(event);
    expect(await (event.request as Request).clone().text()).not.toContain(EMAIL);
  });

  it("keeps string-valued JSON tool arguments valid JSON after masking", async () => {
    const { hook } = await arm();
    // arguments is a JSON *string* value (not an object): re-encoding must not
    // be skipped, or the wire field stops being valid JSON.
    const request = chatRequest({
      model: "g",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "write", arguments: JSON.stringify(EMAIL) } },
          ],
        },
      ],
    });
    const maskEvent = { sessionID: "session-1", kind: "primary", request };
    await hook("session:http.request")(maskEvent);
    const wire = JSON.parse(await (maskEvent.request as Request).clone().text());
    const args = wire.messages[0].tool_calls[0].function.arguments;
    expect(typeof args).toBe("string");
    const parsed = JSON.parse(args);
    expect(typeof parsed).toBe("string");
    expect(parsed).toMatch(TOKEN_RE);
  });
});

// ─── http.response: JSON restore ─────────────────────────────────────────────

async function dispatch(
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
  response: Response,
  options: { sessionID?: string; requestKind?: string; responseKind?: string } = {},
): Promise<unknown> {
  const sessionID = options.sessionID ?? "session-1";
  const requestKind = options.requestKind ?? "primary";
  const responseKind = options.responseKind ?? requestKind;
  const reqEvent = {
    sessionID,
    kind: requestKind,
    request: chatRequest({ model: "g", messages: [{ role: "user", content: "hi" }] }),
  };
  await hook("session:http.request")(reqEvent);
  const resEvent = { sessionID, kind: responseKind, request: reqEvent.request, response };
  return hook("session:http.response")(resEvent);
}

describe("transparent http.response restore (JSON)", () => {
  it("restores assistant display text only; tool arguments stay tokenized", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const response = new Response(
      JSON.stringify({
        id: "chatcmpl-9",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `the key is ${token} thanks`,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: token }) } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { total_tokens: 42 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "r9" } },
    );
    const resEvent = {
      sessionID: "session-1",
      kind: "primary",
      request: chatRequest({ model: "g", messages: [{ role: "user", content: "hi" }] }),
    };
    await hook("session:http.request")(resEvent);
    const event = { sessionID: "session-1", kind: "primary", request: resEvent.request, response };
    await hook("session:http.response")(event);

    const restored = event.response as Response;
    expect(restored).not.toBe(response);
    const body = JSON.parse(await restored.clone().text());
    expect(body.choices[0].message.content).toBe(`the key is ${KEY} thanks`);
    expect(body.choices[0].message.tool_calls[0].function.arguments).toContain(token);
    expect(body.usage.total_tokens).toBe(42);
    expect(body.id).toBe("chatcmpl-9");
    expect(restored.status).toBe(200);
    expect(restored.headers.get("x-request-id")).toBe("r9");
    expect(restored.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(JSON.stringify(body)).length),
    );
  });

  it("keeps unknown markers literal in assistant display while restoring owned tokens", async () => {
    const { hook } = await arm();
    const owned = await mintToken(hook, KEY);
    const content = `unknown ${FOREIGN_TOKEN} malformed [SGP1:…] owned ${owned}`;
    const response = new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const requestEvent = {
      sessionID: "session-1",
      kind: "primary",
      request: chatRequest({ model: "g", messages: [{ role: "user", content: "safe" }] }),
    };
    await hook("session:http.request")(requestEvent);
    const event: Record<string, unknown> = {
      sessionID: "session-1",
      kind: "primary",
      request: requestEvent.request,
      response,
    };
    await hook("session:http.response")(event);
    const body = JSON.parse(await (event.response as Response).clone().text());

    expect(body.choices[0].message.content).toContain(FOREIGN_TOKEN);
    expect(body.choices[0].message.content).toContain("[SGP1:…]");
    expect(body.choices[0].message.content).toContain(KEY);
    expect(body.choices[0].message.content).not.toContain(owned);
  });

  it("retains the original response when there is nothing to restore", async () => {
    const { hook } = await arm();
    const response = new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "plain" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const original = response;
    await dispatch(hook, response);
    // dispatch creates its own event; use identity via a fresh event instead.
    const reqEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }) };
    await hook("session:http.request")(reqEvent);
    const event = { sessionID: "session-1", kind: "primary", request: reqEvent.request, response: original };
    await hook("session:http.response")(event);
    expect(event.response).toBe(original);
    expect(JSON.parse(await original.clone().text()).choices[0].message.content).toBe("plain");
  });

  it("preserves literal responses without verified request attribution", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const response = new Response(JSON.stringify({ choices: [{ message: { content: token } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    // No prior http.request for this Request object.
    const orphan = chatRequest({ model: "g", messages: [] });
    await hook("session:http.response")({ sessionID: "session-1", kind: "primary", request: orphan, response });
    expect(await response.clone().text()).toContain(token);
    expect(await response.clone().text()).not.toContain(KEY);

    // Kind mismatch against the recorded attribution.
    await expect(dispatch(hook, response, { requestKind: "primary", responseKind: "title" })).resolves.toBeUndefined();
  });

  it("passes non-2xx and non-chat JSON through untouched", async () => {
    const { hook } = await arm();
    const error = new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "content-type": "application/json" },
    });
    await expect(dispatch(hook, error)).resolves.toBeUndefined();
    expect(error.status).toBe(429);

    const models = new Response(JSON.stringify({ object: "list", data: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(dispatch(hook, models)).resolves.toBeUndefined();
  });

  it("keeps token-bearing payloads it cannot place literal (P1 degradation)", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const noChoices = new Response(JSON.stringify({ result: token }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const event = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: noChoices };
    await hook("session:http.request")(event);
    await hook("session:http.response")(event);
    const body = await (event.response as Response).clone().text();
    expect(body).toContain(token);
    expect(body).not.toContain(KEY);
  });

  it("degrades token-bearing unrestorable responses and passes token-free ones", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    // Unsupported content type carrying an owned token degrades to a literal
    // placeholder emit with a WARN (P1, 2026-10-06b) — never a refusal.
    const textPlain = new Response(`value ${token}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const textEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: textPlain };
    await hook("session:http.request")(textEvent);
    await hook("session:http.response")(textEvent);
    expect(await (textEvent.response as Response).text()).toBe(`value ${token}`);

    const cleanText = new Response("plain ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const cleanEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: cleanText };
    await hook("session:http.request")(cleanEvent);
    await hook("session:http.response")(cleanEvent);
    expect(await (cleanEvent.response as Response).text()).toBe("plain ok");

    // Error bodies carrying a token degrade the same way.
    const errorWithToken = new Response(JSON.stringify({ error: token }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const errorEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: errorWithToken };
    await hook("session:http.request")(errorEvent);
    await hook("session:http.response")(errorEvent);
    const errorBody = await (errorEvent.response as Response).text();
    expect(errorBody).toContain(token);
    expect(errorBody).not.toContain(KEY);
  });

  it("keeps reserved tokens outside display text and tool arguments literal", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    // A placeholder in an unplaceable field (refusal text) is degradation —
    // literal emit with a WARN — not a refusal (P1, 2026-10-06b).
    const inRefusal = new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi", refusal: token } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const refusalEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: inRefusal };
    await hook("session:http.request")(refusalEvent);
    await hook("session:http.response")(refusalEvent);
    const refusalBody = await (refusalEvent.response as Response).text();
    expect(refusalBody).toContain(token);
    expect(refusalBody).not.toContain(KEY);

    const inMetadata = new Response(JSON.stringify({ choices: [], metadata: { note: token } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const metadataEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: inMetadata };
    await hook("session:http.request")(metadataEvent);
    await hook("session:http.response")(metadataEvent);
    const metadataBody = await (metadataEvent.response as Response).text();
    expect(metadataBody).toContain(token);
    expect(metadataBody).not.toContain(KEY);

    // Intentional tool-argument tokens stay allowed (typed tool gate decides).
    const inToolArguments = new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: `x ${token} y`,
              tool_calls: [
                { id: "c", type: "function", function: { name: "read", arguments: JSON.stringify({ p: token }) } },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const toolEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response: inToolArguments };
    await hook("session:http.request")(toolEvent);
    await hook("session:http.response")(toolEvent);
    const toolBody = await (toolEvent.response as Response).text();
    // Display text restores; tool-argument tokens stay tokenized for the gate.
    expect(toolBody).toContain(`x ${KEY} y`);
    expect(toolBody).toMatch(TOKEN_RE);
  });

  it("keeps metadata that imitates tool-call paths literal (never restores into it)", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const forgedPaths = [
      { choices: [], metadata: { role: "assistant", function_call: { name: "x", arguments: token } } },
      {
        choices: [{ index: 0, delta: { metadata: { role: "assistant", function_call: { name: "x", arguments: token } } } }],
      },
    ];

    for (const payload of forgedPaths) {
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const event = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response };
      await hook("session:http.request")(event);
      await hook("session:http.response")(event);
      // P1 (2026-10-06b): imitated paths never restore — the placeholder
      // stays literal with a WARN; the original is never emitted.
      const body = await (event.response as Response).text();
      expect(body).toContain(token);
      expect(body).not.toContain(KEY);
    }
  });

  it("keeps reserved tokens in response keys and non-tool fields literal; legacy tool calls still restore", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    // P1 (2026-10-06b): each of these is a placeholder in an unplaceable
    // position — kept literal with a WARN, never restored, never refused.
    const literalCases = [
      // A token in an object key is never an intentional argument string.
      { choices: [{ message: { role: "assistant", content: "hi", [token]: "x" } }] },
      // An `arguments` field that is not a tool-call function is not exempt.
      { choices: [], metadata: { arguments: token } },
      // A {name, arguments} metadata object is NOT a tool-call function.
      { choices: [], metadata: { name: "not-a-tool-call", arguments: token } },
    ];
    for (const payload of literalCases) {
      const response = new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      const event = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }), response };
      await hook("session:http.request")(event);
      await hook("session:http.response")(event);
      const body = await (event.response as Response).text();
      expect(body).toContain(token);
      expect(body).not.toContain(KEY);
    }

    // Message-level legacy function_call.arguments IS a real tool-call path
    // and stays tokenized for the typed tool gate.
    const legacyToolCall = new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: null, function_call: { name: "read", arguments: JSON.stringify({ p: token }) } } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(dispatch(hook, legacyToolCall)).resolves.toBeUndefined();
  });
});

// ─── http.response: SSE restore ──────────────────────────────────────────────

/** Runs an SSE response through the correlated request/response hooks without reading it. */
async function armSse(
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
  stream: ReadableStream<Uint8Array>,
): Promise<Response> {
  const response = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-req": "sse-1" },
  });
  const reqEvent = { sessionID: "session-1", kind: "primary", request: chatRequest({ model: "g", messages: [] }) };
  await hook("session:http.request")(reqEvent);
  const event = { sessionID: "session-1", kind: "primary", request: reqEvent.request, response };
  await hook("session:http.response")(event);
  return event.response as Response;
}

function readAll(response: Response): Promise<string> {
  if (response.body === null) throw new Error("no restored body");
  return readStream(response.body);
}

function deltaEvent(delta: Record<string, unknown>, index = 0): string {
  return `data: ${JSON.stringify({ id: "c1", choices: [{ index, delta }] })}\n\n`;
}

describe("transparent http.response restore (SSE)", () => {
  it("restores display text with tokens split across chunks and events", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const output = await readAll(
      await armSse(
        hook,
        sseBody([
          sseChunk("the key is "),
          sseChunk(token.slice(0, 9)),
          sseChunk(token.slice(9)),
          sseChunk(" ok"),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    // Restored display text arrives incrementally across delta events.
    const contents = output
      .split("\n\n")
      .filter((block) => block.startsWith("data: {"))
      .map((block) => JSON.parse(block.slice(5)).choices[0].delta.content as string)
      .join("");
    expect(contents).toBe(`the key is ${KEY} ok`);
    expect(output).not.toContain(token);
    expect(output).toContain("data: [DONE]");
  });

  it("preserves unknown markers in streamed display text and restores owned tokens", async () => {
    const { hook } = await arm();
    const owned = await mintToken(hook, KEY);
    const content = `unknown ${FOREIGN_TOKEN} malformed [SGP1:…] owned ${owned}`;
    const output = await readAll(
      await armSse(hook, sseBody([sseChunk(content), "data: [DONE]\n\n"])),
    );
    const chunks = output.split("\n\n").filter((block) => block.startsWith("data: {"));
    const restored = chunks.map((block) => JSON.parse(block.slice(5)).choices[0].delta.content).join("");

    expect(restored).toContain(FOREIGN_TOKEN);
    expect(restored).toContain("[SGP1:…]");
    expect(restored).toContain(KEY);
    expect(restored).not.toContain(owned);
  });

  it("buffers per choice channel independently for multi-choice streams", async () => {
    const { hook } = await arm();
    const tokenA = await mintToken(hook, KEY);
    const tokenB = await mintToken(hook, EMAIL);
    const output = await readAll(
      await armSse(
        hook,
        sseBody([
          deltaEvent({ content: `A=${tokenA.slice(0, 12)}` }, 0),
          deltaEvent({ content: `B=${tokenB.slice(0, 20)}` }, 1),
          deltaEvent({ content: tokenA.slice(12) }, 0),
          deltaEvent({ content: tokenB.slice(20) }, 1),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const events = output.split("\n\n").filter((block) => block.startsWith("data: {"));
    const contentsByChannel = new Map<number, string>();
    for (const block of events) {
      const parsed = JSON.parse(block.slice(5)) as {
        choices: Array<{ index: number; delta: { content?: string } }>;
      };
      for (const choice of parsed.choices) {
        contentsByChannel.set(choice.index, (contentsByChannel.get(choice.index) ?? "") + (choice.delta.content ?? ""));
      }
    }
    expect(contentsByChannel.get(0)).toBe(`A=${KEY}`);
    expect(contentsByChannel.get(1)).toBe(`B=${EMAIL}`);
  });

  it("keeps tool-call argument tokens and non-data framing intact", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const output = await readAll(
      await armSse(
        hook,
        sseBody([
          ": stream start\n",
          "event: message\n",
          `id: 7\n${deltaEvent({ content: "x", tool_calls: [{ index: 0, function: { name: "read", arguments: token } }] })}`,
          "data: [DONE]\n\n",
        ]),
      ),
    );
    expect(output).toContain(": stream start");
    expect(output).toContain("event: message");
    expect(output).toContain("id: 7");
    expect(output).toContain(`"arguments":"${token}"`);
  });

  it("handles UTF-8 code points split across chunk byte boundaries", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const encoder = new TextEncoder();
    const whole = encoder.encode(sseChunk(`café ${token} ☕`) + "data: [DONE]\n\n");
    const output = await readAll(
      await armSse(
        hook,
        sseBody([
          new TextDecoder().decode(whole.slice(0, 7)),
          new TextDecoder().decode(whole.slice(7, 21)),
          new TextDecoder().decode(whole.slice(21)),
        ]),
      ),
    );
    expect(output).toContain(`café ${KEY} ☕`);
  });

  it("preserves malformed JSON data lines and only cancels when the consumer does", async () => {
    const { hook } = await arm();
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {not json\n\n"));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const restored = await armSse(hook, upstream);
    const reader = restored.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: {not json\n\n");
    expect(upstreamCancelled).toBe(false);
    await reader.cancel();
    expect(upstreamCancelled).toBe(true);
  });

  it("keeps an unknown marker outside display text literal with a WARN", async () => {
    const { hook } = await arm();
    const payload = { choices: [{ index: 0, delta: { content: "plain", refusal: FOREIGN_TOKEN } }] };
    const restored = await armSse(hook, sseBody([`data: ${JSON.stringify(payload)}\n\n`, "data: [DONE]\n\n"]));
    // P1 (2026-10-06b): degradation, not stream failure.
    const output = await readAll(restored);
    expect(output).toContain(FOREIGN_TOKEN);
    expect(output).toContain("data: [DONE]");
  });

  it("degrades a token that stays incomplete at [DONE] or stream end", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    // P1 (2026-10-06b): the held partial tail is dropped with a WARN at the
    // boundary; the stream completes instead of failing (the 02:23 deadlock).
    const atDone = await armSse(hook, sseBody([sseChunk(`cut ${token.slice(0, 12)}`), "data: [DONE]\n\n"]));
    const doneOutput = await readAll(atDone);
    expect(doneOutput).toContain("data: [DONE]");
    expect(doneOutput).not.toContain(token);

    const atEnd = await armSse(hook, sseBody([sseChunk(`cut ${token.slice(0, 12)}`)]));
    const endOutput = await readAll(atEnd);
    expect(endOutput).toContain("cut");
    expect(endOutput).not.toContain(token);
  });

  it("propagates upstream stream errors", async () => {
    const { hook } = await arm();
    const restored = await armSse(hook, sseBody([sseChunk("fine"), sseChunk("more")], { errorAfter: 1 }));
    await expect(readAll(restored)).rejects.toThrow("upstream blew up");
  });

  it("propagates downstream cancellation to the upstream reader", async () => {
    const { hook } = await arm();
    let cancelled: unknown;
    const upstream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseChunk("hello ") + "data: [DONE]\n\n"));
        },
        cancel(reason) {
          cancelled = reason;
        },
      },
      { highWaterMark: 1 },
    );
    const restored = await armSse(hook, upstream);
    const reader = restored.body!.getReader();
    await reader.read();
    await reader.cancel("consumer stopped");
    expect(cancelled).toBe("consumer stopped");
  });

  it("restores tokens split at every partial reserved-prefix boundary", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    // Cut points 1..6 cover every proper prefix of the reserved namespace
    // prefix ("[", "[S", "[SG", "[SGP", "[SGP1", "[SGP1:").
    for (let cut = 1; cut <= PSEUDONYM_TOKEN_PREFIX.length; cut++) {
      const output = await readAll(
        await armSse(
          hook,
          sseBody([
            sseChunk(`a${token.slice(0, cut)}`),
            sseChunk(`${token.slice(cut)}b`),
            "data: [DONE]\n\n",
          ]),
        ),
      );
      const contents = output
        .split("\n\n")
        .filter((block) => block.startsWith("data: {"))
        .map((block) => JSON.parse(block.slice(5)).choices[0].delta.content as string)
        .join("");
      expect(contents).toBe(`a${KEY}b`);
      expect(output).not.toContain(token);
    }
  });

  it("restores multiline SSE data events by joining their data lines", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const pretty = JSON.stringify(
      { id: "c1", choices: [{ index: 0, delta: { content: `x ${token} y` } }] },
      null,
      2,
    );
    const multilineEvent = `${pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n")}\n\n`;
    const output = await readAll(
      await armSse(hook, sseBody([multilineEvent, "data: [DONE]\n\n"])),
    );
    const contents = output
      .split("\n\n")
      .filter((block) => block.startsWith("data: {"))
      .map((block) => JSON.parse(block.slice(5)).choices[0].delta.content as string)
      .join("");
    expect(contents).toBe(`x ${KEY} y`);
  });

  it("abandons restoration when a stream opens more choice channels than the limit", async () => {
    const { hook } = await arm();
    const events: string[] = [];
    // Each event holds an incomplete token on its own channel, so channels
    // accumulate past the cap instead of being deleted.
    for (let index = 0; index < 300; index++) {
      events.push(deltaEvent({ content: `${PSEUDONYM_TOKEN_PREFIX}abc` }, index));
    }
    const restored = await armSse(hook, sseBody([...events, "data: [DONE]\n\n"]));
    expect(await readAll(restored)).toBe([...events, "data: [DONE]\n\n"].join(""));
  });

  it("bounds terminal choice state even when content channels stay empty", async () => {
    const { hook } = await arm();
    const terminalEvents = Array.from({ length: 300 }, (_, index) =>
      `data: ${JSON.stringify({ choices: [{ index, delta: {}, finish_reason: "stop" }] })}`,
    ).join("\n\n");
    const restored = await armSse(hook, sseBody([`${terminalEvents}\n\ndata: [DONE]\n\n`]));

    expect(await readAll(restored)).toContain('"index":299');
  });

  it("pulls from the upstream only as the consumer reads (backpressure)", async () => {
    const { hook } = await arm();
    let upstreamReads = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        upstreamReads++;
        controller.enqueue(new TextEncoder().encode(sseChunk("hello ")));
      },
    });
    const restored = await armSse(hook, upstream);

    // Without downstream reads the source is filled only to the downstream
    // queue's high-water mark; it must not be drained to the end of the stream.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterConstruction = upstreamReads;
    expect(afterConstruction).toBeLessThanOrEqual(4);

    // Still no unbounded eager drain while the consumer is idle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamReads).toBe(afterConstruction);

    const reader = restored.body!.getReader();
    await reader.read();
    await reader.cancel();
  });

  it("preserves an unterminated event rather than accumulating beyond the cap", async () => {
    const { hook } = await arm();
    // Each 64-KiB comment line arrives as its own chunk, so the pending line
    // buffer stays small while the accumulated event must still be bounded.
    const bigLine = `: ${"a".repeat(64 * 1024)}`;
    const chunks = Array.from({ length: 24 }, () => `${bigLine}\n`);
    chunks.push("\n", "data: [DONE]\n\n");
    const restored = await armSse(hook, sseBody(chunks));
    expect(await readAll(restored)).toBe(chunks.join(""));
  });

  it("bounds the aggregate held channel state", async () => {
    const { hook } = await arm();
    const hold = `${PSEUDONYM_TOKEN_PREFIX}${"0".repeat(60 * 1024)}`;
    const events: string[] = [];
    for (let index = 0; index < 18; index++) {
      events.push(deltaEvent({ content: hold }, index));
    }
    const restored = await armSse(hook, sseBody([...events, "data: [DONE]\n\n"]));
    expect(await readAll(restored)).toBe([...events, "data: [DONE]\n\n"].join(""));
  });

  it("bounds the accumulated event by UTF-8 bytes, not code units", async () => {
    const { hook } = await arm();
    // 8 chunks × 64 Ki CJK characters: ~524 Ki code units (below a 1 Mi unit
    // cap) but ~1.5 MiB UTF-8 (above the 1 MiB byte cap).
    const bigLine = `: ${"漢".repeat(64 * 1024)}`;
    const chunks = Array.from({ length: 8 }, () => `${bigLine}\n`);
    chunks.push("\n", "data: [DONE]\n\n");
    const restored = await armSse(hook, sseBody(chunks));
    expect(await readAll(restored)).toBe(chunks.join(""));
  });

  it("bounds a choice channel by UTF-8 bytes, not code units", async () => {
    const { hook } = await arm();
    // 30 Ki CJK characters: below a 64 Ki unit cap, but ~90 KiB UTF-8.
    const hold = `${PSEUDONYM_TOKEN_PREFIX}${"漢".repeat(30 * 1024)}`;
    const restored = await armSse(
      hook,
      sseBody([deltaEvent({ content: hold }), "data: [DONE]\n\n"]),
    );
    expect(await readAll(restored)).toBe(deltaEvent({ content: hold }) + "data: [DONE]\n\n");
  });

  it("keeps a reserved token in a non-choice SSE payload literal", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    for (const payload of [
      { id: "c1", usage: { note: token } }, // no `choices` key at all
      { id: "c1", choices: [], usage: { note: token } },
    ]) {
      const restored = await armSse(
        hook,
        sseBody([`data: ${JSON.stringify(payload)}\n\n`, "data: [DONE]\n\n"]),
      );
      // P1 (2026-10-06b): degradation — literal emit with a WARN.
      const output = await readAll(restored);
      expect(output).toContain(token);
      expect(output).toContain("data: [DONE]");
    }
  });

  it("keeps output after a terminal choice literal without cross-restoring a pending token", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await armSse(
      hook,
      sseBody([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: token.slice(0, 12) }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        sseChunk(token.slice(12)),
        "data: [DONE]\n\n",
      ]),
    );
    const output = await readAll(restored);
    expect(output).toContain(token.slice(12));
    expect(output).not.toContain(KEY);
  });

  it("keeps interleaved choice terminals independent", async () => {
    const { hook } = await arm();
    const tokenA = await mintToken(hook, KEY);
    const output = await readAll(
      await armSse(
        hook,
        sseBody([
          deltaEvent({ content: `A=${tokenA}` }, 0),
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          deltaEvent({ content: "B=still" }, 1),
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const contents = output
      .split("\n\n")
      .filter((block) => block.startsWith("data: {"))
      .map((block) => JSON.parse(block.slice(5)).choices[0] as { index: number; delta: { content?: string } })
      .filter((choice) => choice.index === 1)
      .map((choice) => choice.delta.content ?? "")
      .join("");
    expect(contents).toBe("B=still");
  });
});

// ─── Unsupported routes ──────────────────────────────────────────────────────

describe("transparent unsupported routes", () => {
  it("refuses unidentifiable WebSocket and missing AI SDK fetch admission with a content-free hook identifier", async () => {
    const { hook } = await arm();
    for (const name of [
      "session:experimental.ws.handshake",
      "session:experimental.ws.send",
      "aisdk:sdk",
      "aisdk:language",
    ]) {
      await expect(
        hook(name)({ sessionID: "session-1", kind: "primary", url: "wss://x", frame: "{}" }),
      ).rejects.toThrow(UNSUPPORTED_ROUTE);
      const identifier = name.startsWith("session:") ? name.slice("session:".length) : name.replace(":", ".");
      await expect(
        hook(name)({ sessionID: KEY, kind: EMAIL, url: `wss://x/${KEY}`, frame: EMAIL }),
      ).rejects.toThrow(`[hook=${identifier}]`);
    }
  });
});

describe("transparent NDA keyword boundaries", () => {
  it.each(["import Foundation", "Apple Foundation Models", "the agenda for tomorrow"])(
    "preserves ordinary text through request protection: %s",
    async (text) => {
      const { hook } = await arm({ ...baseConfig, nda_keywords: ["NDA"] });
      const event = { sessionID: "session-1", system: [{ type: "text", text }], messages: [], options: {} };
      await hook("session:context")(event);
      expect(event.system[0].text).toBe(text);
    },
  );

  it("still masks a standalone NDA in request content", async () => {
    const { hook } = await arm({ ...baseConfig, nda_keywords: ["NDA"] });
    const event = { sessionID: "session-1", system: [{ type: "text", text: "sign the NDA" }], messages: [], options: {} };
    await hook("session:context")(event);
    expect(event.system[0].text).toMatch(/sign the \[SGP2:/);
  });
});

describe("transparent standalone joiners in replayed tool history", () => {
  it.each(["context", "compaction", "generate", "title"])(
    "preserves whitespace-separated ZWJ text and masks secrets in %s requests",
    async (kind) => {
      const { hook } = await arm();
      const text = `\u200D\n\nweb page for ${EMAIL}\n\n\u200D\n\nkey ${KEY}\n\n\u200D`;
      const event = {
        sessionID: "session-1",
        system: [],
        messages: [{
          id: "msg_tool_history",
          role: "tool",
          content: [{
            type: "tool-result",
            result: { type: "content", value: [{ type: "text", text }] },
          }],
        }],
        options: {},
      };
      await expect(hook(`session:${kind}`)(event)).resolves.toBeUndefined();
      const masked = event.messages[0].content[0].result.value[0].text;
      expect(masked).not.toContain(KEY);
      expect(masked).not.toContain(EMAIL);
      expect(masked.match(/\u200D/g)).toHaveLength(3);
      expect(masked.match(TOKEN_RE)).toHaveLength(2);
      const restored = { sessionID: "session-1", tool: "read", input: { filePath: masked } };
      await hook("tool:execute.before")(restored);
      expect(restored.input.filePath).toBe(text);
    },
  );

  it.each([
    `\u200D${KEY}`,
    `${KEY}\u200D`,
    `\n\u200D\u200B\u200D\n`,
    `\n\u200B\n`,
    `\n\u200C\n`,
    `\n\uFEFF\n`,
    `Hi \u{1F468}\u200D\u{1F4BB} about ${KEY}`,
    `\uFEFFname,email\nbob,${EMAIL}`,
  ])("keeps zero-width characters that hide nothing and masks the rest %#", async (text) => {
    const { hook } = await arm();
    const event = { sessionID: "session-1", system: [{ type: "text", text }], messages: [], options: {} };
    await expect(hook("session:context")(event)).resolves.toBeUndefined();
    const masked = event.system[0].text;
    expect(masked).not.toContain(KEY);
    expect(masked).not.toContain(EMAIL);
    const zeroWidth = /[\u200B-\u200D\uFEFF]/g;
    expect(masked.match(zeroWidth)?.length).toBe(text.match(zeroWidth)?.length);
  });

  it.each([
    `sk-Qwerty\u200DuiopAsdfghjklZx`,
    `pass\u200Dword=Tr0ub4dor&3xYz`,
    `alice@exam\u200Bple.com`,
  ])("still refuses zero-width characters that hide a finding %#", async (text) => {
    const { hook } = await arm();
    const event = { sessionID: "session-1", system: [{ type: "text", text }], messages: [], options: {} };
    await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    expect(event.system[0].text).toBe(text);
  });
});

describe("attachment policy: allow", () => {
  it("schema rejects attachments allow outside transparent mode", async () => {
    const { validatePluginOptions } = await import("../src/plugin-options.js");
    const bad = validatePluginOptions({ mode: "redact", attachments: "allow" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('attachments "allow"');
    const good = validatePluginOptions({ mode: "transparent", attachments: "allow" });
    expect(good.ok).toBe(true);
  });

  it("session layer keeps attachments and appends a visible notice", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = requestEvent();
    (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
    await hook("session:context")(event);
    const serialized = JSON.stringify(event);
    expect(serialized).toContain("aGVsbG8="); // attachment intact
    expect(serialized).toContain("allowed through unscanned"); // visible notice
    expect(serialized).toMatch(TOKEN_RE); // surrounding text still masked
  });

  it("allow notice never lands in a tool message (host serialization safety)", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = requestEvent();
    // Attachment in the FIRST user message; the LAST content-bearing message
    // is a tool message — exactly the replay shape that broke the host's
    // OpenAI Chat conversion ("tool messages only support tool-result").
    (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
    await hook("session:context")(event);

    const messages = event.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    // The tool message gained NO bare text part.
    expect(
      toolMessage!.content.some((part) => part.type === "text" && typeof part.text === "string"),
    ).toBe(false);
    // The notice went to the user message that carries the attachment.
    const userMessage = messages.find(
      (m) => m.role === "user" && m.content.some((p) => p.type === "media"),
    );
    expect(userMessage).toBeDefined();
    expect(
      userMessage!.content.some(
        (part) => part.type === "text" && String(part.text).includes("allowed through unscanned"),
      ),
    ).toBe(true);
  });

  it("skips the allow notice when no user message can carry it", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = requestEvent();
    // Attachment nested in the system prompt field only: no user message with
    // a content array exists in this event's messages after we strip roles.
    (event.system as Array<Record<string, unknown>>)[0] = {
      type: "media",
      mimeType: "image/png",
      data: "aGVsbG8=",
    };
    event.messages = [];
    const before = JSON.stringify(event);
    // Must not throw and must not mutate messages.
    await hook("session:context")(event);
    expect(JSON.stringify(event.messages)).toBe("[]");
    expect(before).toContain("aGVsbG8=");
  });

  it("allow keeps an attachment payload VERBATIM even when it contains a credential-like run", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = requestEvent();
    const payload = `data:image/png;base64,${KEY}AAAAAAAAAAAA`;
    (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: payload,
    });
    await hook("session:context")(event);
    const messages = event.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const media = messages[0].content.find((part) => part.type === "media") as { data: string };
    // Payload survives byte-for-byte: no token substitution inside base64.
    expect(media.data).toBe(payload);
    // The surrounding text is still masked normally.
    expect(JSON.stringify(messages)).toMatch(TOKEN_RE);
  });

  it("allow keeps an attachment payload VERBATIM even when it decodes to sensitive text", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = requestEvent();
    const payload = Buffer.from(`reach ${EMAIL} now`, "utf8").toString("base64");
    (event.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: payload,
    });
    await hook("session:context")(event);
    const messages = event.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const media = messages[0].content.find((part) => part.type === "media") as { data: string };
    expect(media.data).toBe(payload);
    expect(media.data).not.toContain(EMAIL);
  });

  it("wire layer sends the media part verbatim and masks surrounding text", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = {
      sessionID: "s",
      kind: "primary",
      request: chatRequest({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `secret ${KEY} inline` },
              { type: "media", mimeType: "image/png", data: "aGVsbG8=" },
            ],
          },
        ],
      }),
    };
    await hook("session:http.request")(event);
    const body = JSON.parse(await (event.request as Request).clone().text());
    const content = body.messages[0].content;
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe("text");
    expect(content[0].text).not.toContain(KEY);
    expect(content[0].text).toMatch(TOKEN_RE);
    expect(content[1].type).toBe("media");
    expect(content[1].data).toBe("aGVsbG8="); // binary untouched
    expect(JSON.stringify(body)).not.toContain("__sg_opaque_attachment");
  });
});

// ─── Tool schema: annotation prose vs identifiers ───────────────────────────

describe("tool schema annotation prose masks instead of refusing", () => {
  const keywordConfig: GuardConfig = { ...baseConfig, nda_keywords: ["secrets"] };

  /** Minimal context event whose tools subtree is supplied by the caller. */
  function schemaEvent(tools: Record<string, unknown>): Record<string, unknown> {
    return {
      sessionID: "session-1",
      system: [{ type: "text", text: "system" }],
      messages: [
        { id: "msg_1", role: "user", content: [{ type: "text", text: "scan the directory" }] },
      ],
      options: {},
      tools,
    };
  }

  it("masks a schema description VALUE containing a keyword (request passes)", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      vault_scanner: {
        input: {
          type: "object",
          properties: { path: { type: "string", description: "Detects hardcoded secrets" } },
          required: ["path"],
        },
      },
    });
    await hook("session:context")(event);

    const tools = event.tools as Record<
      string,
      { input: { properties: Record<string, { description?: string; type?: string }> } }
    >;
    const description = tools.vault_scanner.input.properties.path.description ?? "";
    expect(description).toMatch(TOKEN_RE);
    expect(description).not.toContain("secrets");
    // Identifiers survive verbatim.
    expect(Object.keys(tools)).toEqual(["vault_scanner"]);
    expect(Object.keys(tools.vault_scanner.input.properties)).toEqual(["path"]);
    expect(tools.vault_scanner.input.properties.path.type).toBe("string");
  });

  it("masks a schema title VALUE the same way", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      vault_scanner: {
        input: {
          type: "object",
          title: "Vault scan options",
          properties: { mode: { type: "string", title: "Detection secrets level" } },
        },
      },
    });
    await hook("session:context")(event);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("secrets");
    expect(serialized).toMatch(TOKEN_RE);
  });

  it("still refuses when a property KEY is the sensitive word itself (identifier)", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      vault_scanner: {
        input: { type: "object", properties: { secrets: { type: "string" } } },
      },
    });
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow("scans as sensitive");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("passes a compound identifier that merely contains a keyword (P2 word-boundary narrowing)", async () => {
    const { hook } = await arm(keywordConfig);
    // 「secrets_path」/「Foundation」are not the standalone word「secrets」/「NDA」:
    // keyword rules match the word, not substrings inside longer identifiers
    // (2026-10-06 live dogfood: Apple Foundation Models was masked).
    const event = schemaEvent({
      vault_scanner: {
        input: { type: "object", properties: { secrets_path: { type: "string" } } },
      },
    });
    await expect(hook("session:context")(event)).resolves.toBeUndefined();
    const tools = event.tools as Record<string, unknown>;
    expect(Object.keys(tools)).toEqual(["vault_scanner"]);
  });

  it("still refuses when an enum VALUE is sensitive (identifier)", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      vault_scanner: {
        input: {
          type: "object",
          properties: { mode: { type: "string", enum: ["secrets", "public"] } },
        },
      },
    });
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow("scans as sensitive");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("still refuses when the tool NAME is the sensitive word itself (identifier)", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      secrets: { input: { type: "object", properties: {} } },
    });
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow("scans as sensitive");
    expect(JSON.stringify(event)).toBe(before);
  });

  it("passes a compound tool name that merely contains a keyword (P2 word-boundary narrowing)", async () => {
    const { hook } = await arm(keywordConfig);
    const event = schemaEvent({
      secrets_scanner: { input: { type: "object", properties: {} } },
    });
    await expect(hook("session:context")(event)).resolves.toBeUndefined();
    expect(Object.keys(event.tools as Record<string, unknown>)).toEqual(["secrets_scanner"]);
  });
});

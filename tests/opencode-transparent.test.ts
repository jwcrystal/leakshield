/**
 * Transparent pseudonymization integration tests (issue #22, stage 1).
 *
 * Offline mocks only: the OpenCode v2 plugin context is mocked (hook
 * registration + captured callbacks), all secrets are synthetic, and no
 * network, filesystem tool effects, or OpenCode runtime are involved.
 * These tests exercise the guard's observable hook behavior through the
 * request boundary (four kinds + native http), the typed tool gate, cleanup,
 * and fail-closed refusals. They are NOT a native-hook/provider/client
 * ordering proof (see the stage-1 handoff).
 */

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
const TOKEN_RE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]/g;
const FOREIGN_TOKEN = `[SGP1:${"deadbeef".repeat(4)}-00000001]`;

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

async function arm(config: GuardConfig = baseConfig): Promise<Harness> {
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
  const guard = createTransparentSessionGuard(config);
  await guard.setup(ctx as never);
  const hook = (name: string) => {
    const hit = registered.find((r) => `${r.domain}:${r.name}` === name);
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
): Promise<string> {
  const event = {
    sessionID,
    system: [{ type: "text", text: `x ${secret} y` }],
    messages: [],
    options: {},
  };
  await hook("session:context")(event);
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

    // The same unmapped token is still refused when a tool must restore it.
    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-1", input: { filePath: `/x/${FOREIGN_TOKEN}` } }),
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
    (event.messages as Array<{ id: string }>)[0].id = FOREIGN_TOKEN;
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    expect(JSON.stringify(event)).toBe(before);
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

  it("refuses media/file attachments with a static error, never a notice", async () => {
    const { hook } = await arm();
    const event = requestEvent();
    (event.messages as Array<{ content: unknown[] }>)[0].content.push({
      type: "media",
      mimeType: "image/png",
      data: "aGVsbG8=",
    });
    const before = JSON.stringify(event);
    await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
    expect(JSON.stringify(event)).toBe(before);
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

    await expect(
      hook("tool:execute.before")({ tool: "read", sessionID: "session-2", input: { path: token } }),
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
      await expect(hook("session:context")(event)).rejects.toThrow(PROTECT_FAILED);
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
    (bad.messages as Array<{ id: string }>)[0].id = FOREIGN_TOKEN;
    await expect(hook("session:context")(bad)).rejects.toThrow(PROTECT_FAILED);

    // The same session remains usable after a failed operation.
    const good = requestEvent("session-x");
    await hook("session:context")(good);
    expect(JSON.stringify(good)).not.toContain(KEY);
  });
});

// ─── Typed tool gate ─────────────────────────────────────────────────────────

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

  it("refuses a shell command whose original is not shell-safe, leaving it unchanged", async () => {
    const { hook } = await arm();
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
    const { hook } = await arm();
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

  it("refuses foreign tokens in tool inputs too", async () => {
    const { hook } = await arm();
    await expect(
      hook("tool:execute.before")({
        tool: "read",
        sessionID: "session-1",
        input: { filePath: `/x/${FOREIGN_TOKEN}` },
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

  it("refuses non-chat routes and unsupported dialects (Anthropic shape)", async () => {
    const { hook } = await arm();
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
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: anthropicRoute }),
    ).rejects.toThrow();

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

  it("refuses reserved tokens in headers but preserves authentication headers", async () => {
    const { hook } = await arm();
    const tokenHeader = chatRequest(
      { model: "g", messages: [{ role: "user", content: "safe" }] },
      { headers: { "x-custom": `value ${FOREIGN_TOKEN}` } },
    );
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: tokenHeader }),
    ).rejects.toThrow();

    // A token in the query string is equally unrestorable.
    const tokenQuery = new Request(
      `https://provider.example.com/v1/chat/completions?q=${encodeURIComponent(FOREIGN_TOKEN)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-key" },
        body: JSON.stringify({ model: "g", messages: [{ role: "user", content: "safe" }] }),
      },
    );
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: tokenQuery }),
    ).rejects.toThrow();

    const clean = chatRequest({ model: "g", messages: [{ role: "user", content: "safe" }] });
    const event = { sessionID: "s", kind: "primary", request: clean };
    await hook("session:http.request")(event);
    expect((event.request as Request).headers.get("authorization")).toBe("Bearer test-key");
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
    const { hook } = await arm();
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
    const { hook } = await arm();
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

  it("refuses responses without verified request attribution", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const response = new Response(JSON.stringify({ choices: [{ message: { content: token } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    // No prior http.request for this Request object.
    const orphan = chatRequest({ model: "g", messages: [] });
    await expect(
      hook("session:http.response")({ sessionID: "session-1", kind: "primary", request: orphan, response }),
    ).rejects.toThrow(ATTRIBUTION_FAILED);

    // Kind mismatch against the recorded attribution.
    await expect(dispatch(hook, response, { requestKind: "primary", responseKind: "title" })).rejects.toThrow(
      ATTRIBUTION_FAILED,
    );
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

  it("refuses token-bearing payloads it cannot place for restore", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const noChoices = new Response(JSON.stringify({ result: token }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(dispatch(hook, noChoices)).rejects.toThrow();
  });

  it("refuses token-bearing unrestorable responses but passes token-free ones", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    // Unsupported content type carrying an owned token must not leak literally.
    const textPlain = new Response(`value ${token}`, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    await expect(dispatch(hook, textPlain)).rejects.toThrow();

    const cleanText = new Response("plain ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    await expect(dispatch(hook, cleanText)).resolves.toBeUndefined();

    // Error bodies are usually passed through, but not when they carry a token.
    const errorWithToken = new Response(JSON.stringify({ error: token }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(dispatch(hook, errorWithToken)).rejects.toThrow();
  });

  it("refuses reserved tokens outside display text and tool arguments", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    const inRefusal = new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi", refusal: token } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(dispatch(hook, inRefusal)).rejects.toThrow();

    const inMetadata = new Response(JSON.stringify({ choices: [], metadata: { note: token } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await expect(dispatch(hook, inMetadata)).rejects.toThrow();

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
    await expect(dispatch(hook, inToolArguments)).resolves.toBeUndefined();
  });

  it("rejects metadata that imitates message or delta tool-call paths", async () => {
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
      await expect(dispatch(hook, response)).rejects.toThrow();
    }
  });

  it("rejects reserved tokens in response keys or non-tool argument fields", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);

    // A token in an object key is never an intentional argument string.
    const keyToken = new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi", [token]: "x" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(dispatch(hook, keyToken)).rejects.toThrow();

    // An `arguments` field that is not a tool-call function is not exempt.
    const foreignArguments = new Response(
      JSON.stringify({ choices: [], metadata: { arguments: token } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(dispatch(hook, foreignArguments)).rejects.toThrow();

    // A {name, arguments} metadata object is NOT a tool-call function.
    const functionShapedMetadata = new Response(
      JSON.stringify({ choices: [], metadata: { name: "not-a-tool-call", arguments: token } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await expect(dispatch(hook, functionShapedMetadata)).rejects.toThrow();

    // Message-level legacy function_call.arguments IS a real tool-call path.
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

  it("fails the stream on malformed JSON data lines and cancels the upstream", async () => {
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
    await expect(readAll(restored)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamCancelled).toBe(true);
  });

  it("fails the stream when an unknown marker appears outside display text", async () => {
    const { hook } = await arm();
    const payload = { choices: [{ index: 0, delta: { content: "plain", refusal: FOREIGN_TOKEN } }] };
    const restored = await armSse(hook, sseBody([`data: ${JSON.stringify(payload)}\n\n`, "data: [DONE]\n\n"]));
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("fails the stream when a token stays incomplete at [DONE] or stream end", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const atDone = await armSse(hook, sseBody([sseChunk(`cut ${token.slice(0, 12)}`), "data: [DONE]\n\n"]));
    await expect(readAll(atDone)).rejects.toThrow();

    const atEnd = await armSse(hook, sseBody([sseChunk(`cut ${token.slice(0, 12)}`)]));
    await expect(readAll(atEnd)).rejects.toThrow();
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

  it("fails closed when a stream opens more choice channels than the limit", async () => {
    const { hook } = await arm();
    const events: string[] = [];
    // Each event holds an incomplete token on its own channel, so channels
    // accumulate past the cap instead of being deleted.
    for (let index = 0; index < 300; index++) {
      events.push(deltaEvent({ content: `${PSEUDONYM_TOKEN_PREFIX}abc` }, index));
    }
    const restored = await armSse(hook, sseBody([...events, "data: [DONE]\n\n"]));
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("bounds terminal choice state even when content channels stay empty", async () => {
    const { hook } = await arm();
    const terminalEvents = Array.from({ length: 300 }, (_, index) =>
      `data: ${JSON.stringify({ choices: [{ index, delta: {}, finish_reason: "stop" }] })}`,
    ).join("\n\n");
    const restored = await armSse(hook, sseBody([`${terminalEvents}\n\ndata: [DONE]\n\n`]));

    await expect(readAll(restored)).rejects.toThrow();
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

  it("fails closed on an unterminated event whose accumulated lines exceed the cap", async () => {
    const { hook } = await arm();
    // Each 64-KiB comment line arrives as its own chunk, so the pending line
    // buffer stays small while the accumulated event must still be bounded.
    const bigLine = `: ${"a".repeat(64 * 1024)}`;
    const chunks = Array.from({ length: 24 }, () => `${bigLine}\n`);
    chunks.push("\n", "data: [DONE]\n\n");
    const restored = await armSse(hook, sseBody(chunks));
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("bounds the aggregate held channel state", async () => {
    const { hook } = await arm();
    const hold = `${PSEUDONYM_TOKEN_PREFIX}${"0".repeat(60 * 1024)}`;
    const events: string[] = [];
    for (let index = 0; index < 18; index++) {
      events.push(deltaEvent({ content: hold }, index));
    }
    const restored = await armSse(hook, sseBody([...events, "data: [DONE]\n\n"]));
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("bounds the accumulated event by UTF-8 bytes, not code units", async () => {
    const { hook } = await arm();
    // 8 chunks × 64 Ki CJK characters: ~524 Ki code units (below a 1 Mi unit
    // cap) but ~1.5 MiB UTF-8 (above the 1 MiB byte cap).
    const bigLine = `: ${"漢".repeat(64 * 1024)}`;
    const chunks = Array.from({ length: 8 }, () => `${bigLine}\n`);
    chunks.push("\n", "data: [DONE]\n\n");
    const restored = await armSse(hook, sseBody(chunks));
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("bounds a choice channel by UTF-8 bytes, not code units", async () => {
    const { hook } = await arm();
    // 30 Ki CJK characters: below a 64 Ki unit cap, but ~90 KiB UTF-8.
    const hold = `${PSEUDONYM_TOKEN_PREFIX}${"漢".repeat(30 * 1024)}`;
    const restored = await armSse(
      hook,
      sseBody([deltaEvent({ content: hold }), "data: [DONE]\n\n"]),
    );
    await expect(readAll(restored)).rejects.toThrow();
  });

  it("rejects a reserved token in a non-choice SSE payload", async () => {
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
      await expect(readAll(restored)).rejects.toThrow();
    }
  });

  it("refuses a terminal choice with an unresolved token before its remainder", async () => {
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
    await expect(readAll(restored)).rejects.toThrow();
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
  it("refuses WebSocket and AI SDK routes with a static error", async () => {
    const { hook } = await arm();
    for (const name of [
      "session:experimental.ws.handshake",
      "session:experimental.ws.send",
      "session:experimental.ws.receive",
      "aisdk:sdk",
      "aisdk:language",
    ]) {
      await expect(
        hook(name)({ sessionID: "session-1", kind: "primary", url: "wss://x", frame: "{}" }),
      ).rejects.toThrow(UNSUPPORTED_ROUTE);
    }
  });
});

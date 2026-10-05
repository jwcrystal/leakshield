/**
 * Anthropic Messages wire-dialect tests for transparent mode (Phase 3).
 *
 * Offline mocks only: drives the guard's http.request/http.response hooks with
 * Anthropic-shaped bodies and streams; secrets are synthetic; no network or
 * OpenCode runtime is involved. Mirrors the chat-completions wire tests.
 */

import { describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/opencode-transparent.js";
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
const EMAIL = "alice@example.com";
const TOKEN_RE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]/;

interface RecordedHook {
  domain: string;
  name: string;
  callback: (event: unknown) => unknown;
}

async function arm(config: GuardConfig = baseConfig) {
  const registered: RecordedHook[] = [];
  const hookFor = (domain: string) => {
    return async (name: string, callback: unknown) => {
      registered.push({ domain, name, callback: callback as (event: unknown) => unknown });
      return { dispose: () => undefined };
    };
  };
  const ctx = {
    session: { hook: hookFor("session") },
    aisdk: { hook: hookFor("aisdk") },
    tool: { hook: hookFor("tool") },
  };
  const guard = createTransparentSessionGuard(config);
  await guard.setup(ctx as never);
  const hook = (name: string) => {
    const record = registered.find((r) => `${r.domain}:${r.name}` === name);
    if (!record) throw new Error(`hook ${name} not registered`);
    return async (event: unknown) => record.callback(event);
  };
  return { guard, registered, hook };
}

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

function anthropicRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function wire(
  hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
  body: unknown,
  sessionID = "session-1",
): Promise<{ request: Request; wireBody: Record<string, unknown> }> {
  const event = { sessionID, kind: "primary", request: anthropicRequest(body) };
  await hook("session:http.request")(event);
  const request = event.request as Request;
  return { request, wireBody: JSON.parse(await request.clone().text()) };
}

describe("anthropic messages http.request wire mask", () => {
  it("masks system, text blocks, and tool_result content; structure survives", async () => {
    const { hook } = await arm();
    const event = {
      sessionID: "s",
      kind: "primary",
      request: anthropicRequest({
        model: "claude-3",
        max_tokens: 64,
        system: [{ type: "text", text: `escalate ${EMAIL}` }],
        messages: [
          { role: "user", content: [{ type: "text", text: `key ${KEY}` }] },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/tmp/x" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: `found ${EMAIL}` },
            ],
          },
        ],
        tools: [{ name: "read", description: "read", input_schema: { type: "object" } }],
      }),
    };
    await hook("session:http.request")(event);
    const body = JSON.parse(await (event.request as Request).clone().text());
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).toMatch(TOKEN_RE);
    // Structural identifiers untouched
    expect(body.messages[1].content[0].id).toBe("toolu_1");
    expect(body.messages[1].content[0].name).toBe("read");
    expect(body.messages[2].content[0].tool_use_id).toBe("toolu_1");
    expect(body.tools[0].name).toBe("read");
  });

  it("masks tool_use.input in place (object stays an object)", async () => {
    const { hook } = await arm();
    const { wireBody } = await wire(hook, {
      model: "claude-3",
      max_tokens: 8,
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "write", input: { token: KEY } }],
        },
      ],
    });
    const input = wireBody.messages[0].content[0].input;
    expect(typeof input).toBe("object");
    expect(input.token).toMatch(TOKEN_RE);
  });

  it("refuses image blocks and unknown block types", async () => {
    const { hook } = await arm();
    for (const block of [
      { type: "image", source: { type: "base64" } },
      { type: "document", source: {} },
      { type: "thinking", thinking: "x" },
    ]) {
      const event = {
        sessionID: "s",
        kind: "primary",
        request: anthropicRequest({
          model: "c",
          max_tokens: 8,
          messages: [{ role: "user", content: [block] }],
        }),
      };
      await expect(hook("session:http.request")(event)).rejects.toThrow();
    }
  });

  it("allows auth headers but refuses sensitive custom headers", async () => {
    const { hook } = await arm();
    const body = { model: "c", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
    await wire(hook, body, "s1"); // warm nothing; separate sessions below
    const okEvent = {
      sessionID: "s2",
      kind: "primary",
      request: anthropicRequest(body, {
        "x-api-key": "sk-ant-real-key",
        "anthropic-version": "2023-06-01",
      }),
    };
    await hook("session:http.request")(okEvent); // success = resolves without throwing
    const badEvent = {
      sessionID: "s3",
      kind: "primary",
      request: anthropicRequest(body, { "x-context": `use ${KEY}` }),
    };
    await expect(hook("session:http.request")(badEvent)).rejects.toThrow();
  });

  it("still refuses unknown routes (embeddings) and mixed dialects", async () => {
    const { hook } = await arm();
    const embeddings = new Request("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "e", input: "hi" }),
    });
    await expect(
      hook("session:http.request")({ sessionID: "s", kind: "primary", request: embeddings }),
    ).rejects.toThrow();
  });
});

describe("anthropic messages http.response restore", () => {
  async function dispatch(
    hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
    response: Response,
  ): Promise<Response> {
    const reqEvent = {
      sessionID: "session-1",
      kind: "primary",
      request: anthropicRequest({
        model: "claude-3",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
      }),
    };
    await hook("session:http.request")(reqEvent);
    const resEvent = { sessionID: "session-1", kind: "primary", request: reqEvent.request, response };
    await hook("session:http.response")(resEvent);
    return resEvent.response as Response;
  }

  it("restores JSON content text; tool_use input stays tokenized", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(
      hook,
      new Response(
        JSON.stringify({
          id: "msg_1",
          content: [
            { type: "text", text: `the key is ${token} ok` },
            { type: "tool_use", id: "t", name: "write", input: { token } },
          ],
          stop_reason: "end_turn",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const body = JSON.parse(await restored.text());
    expect(body.content[0].text).toBe(`the key is ${KEY} ok`);
    expect(body.content[1].input.token).toBe(token); // untouched for the tool gate
  });

  it("restores a token split across text_delta events and drains on message_stop", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const events = [
      { type: "message_start", message: { id: "m", content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the key is " + token.slice(0, 12) } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: token.slice(12) + " ok" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"token":"${token}"}` } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const event of events) {
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    });
    const restored = await dispatch(hook, new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const text = await restored.text();
    // Display channel (text_delta) must show originals, never raw tokens.
    const textDeltas = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.type === "content_block_delta" && event.delta?.type === "text_delta")
      .map((event) => event.delta.text)
      .join("");
    expect(textDeltas).not.toMatch(TOKEN_RE);
    expect(textDeltas).toBe(`the key is ${KEY} ok`);
    // input_json_delta payload survives verbatim for the typed tool gate
    expect(text).toContain(`"partial_json":"{\\"token\\":\\"${token}\\"}"`);
  });
});

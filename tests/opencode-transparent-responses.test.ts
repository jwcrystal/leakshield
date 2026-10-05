/**
 * OpenAI Responses wire-dialect tests for transparent mode (Phase 3, 2/2).
 * Mirrors the Anthropic wire tests: offline, synthetic secrets, drives the
 * guard's http hooks with /responses-shaped bodies and SSE events.
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

function responsesRequest(body: unknown): Request {
  return new Request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("openai responses http.request wire mask", () => {
  it("masks instructions, message parts, and function_call_output; structure survives", async () => {
    const { hook } = await arm();
    const event = {
      sessionID: "s",
      kind: "primary",
      request: responsesRequest({
        model: "gpt-response",
        instructions: `escalate ${EMAIL}`,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: `key ${KEY}` }] },
          { type: "function_call", call_id: "call_1", name: "write", arguments: "{\"v\":\"x\"}" },
          { type: "function_call_output", call_id: "call_1", output: `found ${EMAIL}` },
        ],
        tools: [{ type: "function", name: "write", parameters: { type: "object" } }],
      }),
    };
    await hook("session:http.request")(event);
    const body = JSON.parse(await (event.request as Request).clone().text());
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(EMAIL);
    expect(serialized).toMatch(TOKEN_RE);
    expect(body.input[1].call_id).toBe("call_1");
    expect(body.input[1].name).toBe("write");
    expect(body.input[2].call_id).toBe("call_1");
    expect(body.tools[0].name).toBe("write");
    // function_call.arguments stays a JSON-encoded STRING
    expect(typeof body.input[1].arguments).toBe("string");
    JSON.parse(body.input[1].arguments);
  });

  it("refuses reasoning items and mixed dialects", async () => {
    const { hook } = await arm();
    const reasoning = {
      sessionID: "s",
      kind: "primary",
      request: responsesRequest({
        model: "gpt-response",
        input: [{ type: "reasoning", id: "r_1", summary: [] }],
      }),
    };
    await expect(hook("session:http.request")(reasoning)).rejects.toThrow();
    const mixed = {
      sessionID: "s",
      kind: "primary",
      request: responsesRequest({
        model: "gpt-response",
        messages: [{ role: "user", content: "hi" }],
      }),
    };
    await expect(hook("session:http.request")(mixed)).rejects.toThrow();
  });
});

describe("openai responses http.response restore", () => {
  async function dispatch(
    hook: (name: string) => (event: unknown) => Promise<unknown> | unknown,
    response: Response,
  ): Promise<Response> {
    const reqEvent = {
      sessionID: "session-1",
      kind: "primary",
      request: responsesRequest({
        model: "gpt-response",
        input: "hi",
      }),
    };
    await hook("session:http.request")(reqEvent);
    const resEvent = { sessionID: "session-1", kind: "primary", request: reqEvent.request, response };
    await hook("session:http.response")(resEvent);
    return resEvent.response as Response;
  }

  it("restores JSON output_text; function_call stays tokenized", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(
      hook,
      new Response(
        JSON.stringify({
          id: "resp_1",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `the key is ${token} ok` }],
            },
            { type: "function_call", call_id: "c", name: "write", arguments: JSON.stringify({ token }) },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const body = JSON.parse(await restored.text());
    expect(body.output[0].content[0].text).toBe(`the key is ${KEY} ok`);
    expect(JSON.parse(body.output[1].arguments).token).toBe(token);
  });

  it("restores a token split across output_text.delta events; completed drains", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const events = [
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "the key is " + token.slice(0, 12) },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: token.slice(12) + " ok" },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: JSON.stringify({ token }) },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", content: [] } },
      { type: "response.completed", response: { id: "resp_1", output: [] } },
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
    const deltas = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.type === "response.output_text.delta")
      .map((event) => event.delta)
      .join("");
    expect(deltas).not.toMatch(TOKEN_RE);
    expect(deltas).toBe(`the key is ${KEY} ok`);
    // function_call_arguments payload survives verbatim for the tool gate
    expect(text).toContain(`"delta":"{\\"token\\":\\"${token}\\"}"`);
  });
});

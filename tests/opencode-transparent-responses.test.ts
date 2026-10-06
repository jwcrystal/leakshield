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

async function arm(config: GuardConfig = baseConfig, attachmentsPolicy: "block" | "allow" = "block") {
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
  const guard = createTransparentSessionGuard(config, attachmentsPolicy);
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

  function streamResponse(events: Array<Record<string, unknown> | string>): Response {
    const body = events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }

  it.each(["plain", "sensitive", "literal"])("reads a complete %s conversation lifecycle without interrupting the stream", async (kind) => {
    const { hook } = await arm();
    const text = kind === "sensitive"
      ? `contact ${await mintToken(hook, EMAIL)}`
      : kind === "literal" ? "Document the literal [SGP1:example] marker" : "Hello, how can I help?";
    const item = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] };
    const restored = await dispatch(hook, streamResponse([
      { type: "response.created", response: { id: "resp_1", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text },
      { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: item.content[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", output: [item] } },
    ]));
    const output = await restored.text();
    const events = output.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    const expected = kind === "sensitive" ? `contact ${EMAIL}` : text;
    expect(events.find((event) => event.type === "response.output_text.done").text).toBe(expected);
    expect(events.find((event) => event.type === "response.content_part.done").part.text).toBe(expected);
    expect(events.find((event) => event.type === "response.completed").response.output[0].content[0].text).toBe(expected);
    if (kind === "sensitive") expect(output).not.toMatch(TOKEN_RE);
  });

  it("reads a normal conversation with a DONE sentinel after completion", async () => {
    const { hook } = await arm();
    const restored = await dispatch(hook, streamResponse([
      { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
      { type: "response.output_text.done", item_id: "msg_1", text: "Hello" },
      { type: "response.completed", response: { id: "resp_1", output: [] } },
      "[DONE]",
    ]));
    const output = await restored.text();
    expect(output).toContain('"delta":"Hello"');
    expect(output).toContain("data: [DONE]");
  });

  it("restores reasoning summary deltas, completed text, and summary parts", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const text = `Checking ${token}`;
    const item = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text }] };
    const restored = await dispatch(hook, streamResponse([
      { type: "response.output_item.added", output_index: 0, item: { ...item, summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: text.slice(0, 15) },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: text.slice(15) },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0, part: item.summary[0] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_1", output: [item] } },
    ]));
    const output = await restored.text();
    const events = output.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    expect(events.filter((event) => event.type === "response.reasoning_summary_text.delta").map((event) => event.delta).join("")).toBe(`Checking ${KEY}`);
    expect(events.find((event) => event.type === "response.reasoning_summary_text.done").text).toBe(`Checking ${KEY}`);
    expect(events.find((event) => event.type === "response.completed").response.output[0].summary[0].text).toBe(`Checking ${KEY}`);
    expect(output).not.toMatch(TOKEN_RE);
  });

  it("keeps metadata that imitates a display part literal instead of restoring it", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(hook, streamResponse([
      { type: "response.created", response: { id: "resp_1", metadata: { type: "output_text", text: token } } },
    ]));
    // P1 (2026-10-06b): never restored into an imitated path — kept literal
    // with a WARN; the original stays absent.
    const output = await restored.text();
    expect(output).toContain(token);
    expect(output).not.toContain(KEY);
  });

  it.each([
    { doneText: true, sensitive: false },
    { doneText: false, sensitive: false },
    { doneText: true, sensitive: true },
    { doneText: false, sensitive: true },
  ])("preserves reasoning tails in the native consumer with done text $doneText and sensitive $sensitive", async ({ doneText, sensitive }) => {
    const { createRequire } = await import("node:module");
    const nativeRequire = createRequire(new URL("../node_modules/@opencode/ai/package.json", import.meta.url));
    const Effect = await import(nativeRequire.resolve("effect/Effect"));
    const OpenResponses = await import("@opencode/ai/protocols/open-responses");
    const { hook } = await arm();
    const first = sensitive ? `你好🙂 Checking ${await mintToken(hook, KEY)}` : "你好🙂 Checking [SGP1:example";
    const expectedFirst = sensitive ? `你好🙂 Checking ${KEY}` : first;
    const second = "Continue normally.";
    const summary = [{ type: "summary_text", text: first }, { type: "summary_text", text: second }];
    const events: Array<Record<string, unknown>> = [
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: sensitive ? first.slice(0, 24) : first },
    ];
    if (doneText) events.push({ type: "response.reasoning_summary_text.done", item_id: "rs_1", summary_index: 0, text: first });
    events.push(
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 0, part: summary[0] },
      { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 1, delta: second },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", summary_index: 1, part: summary[1] },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary } },
      { type: "response.completed", response: { id: "resp_1", output: [] } },
    );
    const restored = await dispatch(hook, streamResponse(events));
    const nativeEvents = (await restored.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    let state = OpenResponses.initial({ model: { provider: "fixture", route: { providerMetadataKey: "openai" } } } as never);
    const parts: Array<{ type?: string; id?: string; text?: string }> = [];
    for (const event of nativeEvents) {
      const [next, emitted] = await Effect.runPromise(OpenResponses.step(state, event));
      state = next;
      parts.push(...emitted);
    }
    expect(parts.filter((part) => part.id === "rs_1:0" && part.type === "reasoning-delta").map((part) => part.text).join("")).toBe(expectedFirst);
    expect(parts.filter((part) => part.id === "rs_1:1" && part.type === "reasoning-delta").map((part) => part.text).join("")).toBe(second);
  });

  it("keeps completed function arguments tokenized for local tool restoration", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const argumentsText = JSON.stringify({ content: token });
    const restored = await dispatch(hook, streamResponse([
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: argumentsText },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: argumentsText },
      { type: "response.completed", response: { id: "resp_1", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "write", arguments: argumentsText }] } },
    ]));
    const output = await restored.text();
    expect(output).toContain(token);
    expect(output).not.toContain(KEY);
  });

  it("keeps token-bearing response metadata literal (id fields never restore)", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(hook, streamResponse([
      { type: "response.created", response: { id: token } },
    ]));
    const output = await restored.text();
    expect(output).toContain(token);
    expect(output).not.toContain(KEY);
  });

  it.each(["delta", "arguments", "output", "output_text"])("keeps token-bearing %s outside a supported event field literal", async (field) => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(hook, streamResponse([
      { type: "response.created", [field]: token, response: { id: "resp_1" } },
    ]));
    const output = await restored.text();
    expect(output).toContain(token);
    expect(output).not.toContain(KEY);
  });

  it.each(["response.output_text.delta", "response.reasoning_summary_text.delta"])("isolates interleaved indexes for %s", async (type) => {
    const { hook } = await arm();
    const first = await mintToken(hook, KEY);
    const second = await mintToken(hook, EMAIL);
    const index = type === "response.output_text.delta" ? "content_index" : "summary_index";
    const restored = await dispatch(hook, streamResponse([
      { type, item_id: "item_1", [index]: 0, delta: first.slice(0, 20) },
      { type, item_id: "item_1", [index]: 1, delta: second.slice(0, 20) },
      { type, item_id: "item_1", [index]: 0, delta: first.slice(20) },
      { type, item_id: "item_1", [index]: 1, delta: second.slice(20) },
      { type: "response.completed", response: { output: [] } },
    ]));
    const events = (await restored.text()).split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
    expect(events.filter((event) => event.type === type && event[index] === 0).map((event) => event.delta).join("")).toBe(KEY);
    expect(events.filter((event) => event.type === type && event[index] === 1).map((event) => event.delta).join("")).toBe(EMAIL);
  });

  it("uses authoritative done text to finish a buffered token", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(hook, streamResponse([
      { type: "response.output_text.delta", item_id: "msg_1", delta: token.slice(0, 12) },
      { type: "response.output_text.done", item_id: "msg_1", text: token },
      { type: "response.completed", response: { output: [] } },
    ]));
    expect(await restored.text()).toContain(`"text":"${KEY}"`);
  });

  it("still refuses events appended after the DONE sentinel", async () => {
    const { hook } = await arm();
    const restored = await dispatch(hook, streamResponse([
      { type: "response.completed", response: { output: [] } },
      "[DONE]",
      { type: "response.output_text.delta", item_id: "msg_1", delta: "late" },
    ]));
    await expect(restored.text()).rejects.toThrow("malformed or incomplete");
  });

  it("degrades a truncated tail at stream end instead of failing the stream", async () => {
    const { hook } = await arm();
    const token = await mintToken(hook, KEY);
    const restored = await dispatch(hook, streamResponse([
      { type: "response.output_text.delta", item_id: "msg_1", delta: token.slice(0, 12) },
    ]));
    // P1 (2026-10-06b): the held partial tail is dropped with a WARN at
    // close; the stream completes and the original never appears.
    const output = await restored.text();
    expect(output).toContain("response.output_text.delta");
    expect(output).not.toContain(token);
    expect(output).not.toContain(KEY);
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

describe("responses attachment policy: allow", () => {
  it("wire layer sends media parts verbatim and masks input_text", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = {
      sessionID: "s",
      kind: "primary",
      request: responsesRequest({
        model: "gpt-response",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: `key ${KEY}` },
              { type: "media", mimeType: "image/png", data: "aGVsbG8=" },
            ],
          },
        ],
      }),
    };
    await hook("session:http.request")(event);
    const body = JSON.parse(await (event.request as Request).clone().text());
    const parts = body.input[0].content;
    expect(parts[0].type).toBe("input_text");
    expect(parts[0].text).not.toContain(KEY);
    expect(parts[0].text).toMatch(TOKEN_RE);
    expect(parts[1].type).toBe("media");
    expect(parts[1].data).toBe("aGVsbG8=");
  });
});

describe("responses attachments allow: wire image format", () => {
  const imageBody = {
    model: "gpt-test",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "what is in this picture" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ],
  };

  it("allow passes input_image parts through unscanned", async () => {
    const { hook } = await arm(baseConfig, "allow");
    const event = { sessionID: "session-1", kind: "primary", request: responsesRequest(imageBody) };
    await hook("session:http.request")(event);
    const body = JSON.parse(await (event.request as Request).clone().text()) as Record<string, unknown>;
    const parts = ((body.input as Array<{ content: Array<Record<string, unknown>> }>)[0]).content;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe("input_text");
    expect(parts[1].type).toBe("input_image");
    expect(JSON.stringify(parts[1])).toContain("aGVsbG8=");
  });

  it("block still refuses input_image parts", async () => {
    const { hook } = await arm(baseConfig, "block");
    const event = { sessionID: "session-1", kind: "primary", request: responsesRequest(imageBody) };
    await expect(hook("session:http.request")(event)).rejects.toThrow();
  });
});

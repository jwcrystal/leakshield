import { describe, expect, it } from "vitest";
import type { Part } from "@opencode-ai/sdk";
import { createHooks } from "../src/opencode-hooks.js";
import type { GuardConfig } from "../src/types.js";

const secret = "sk-12345678901234567890";

const config: GuardConfig = {
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

function textPart(text: string): Part {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text,
  };
}

describe("OpenCode plugin", () => {
  it("blocks sensitive user text before it is persisted or sent to the model", async () => {
    const hooks = createHooks(config, "block");
    const parts = [textPart(`token=${secret}`)];

    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });

    expect(parts[0]).toMatchObject({ type: "text" });
    expect((parts[0] as Extract<Part, { type: "text" }>).text).not.toContain(secret);
    expect((parts[0] as Extract<Part, { type: "text" }>).text).toContain("LeakShield blocked message text");
  });

  it("blocks unscannable attachments", async () => {
    const hooks = createHooks(config, "block");
    const parts: Part[] = [{
      id: "attachment-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "file",
      mime: "text/plain",
      url: "file:///private.txt",
    }];

    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });

    expect(parts[0]).toMatchObject({ type: "text", synthetic: true });
    expect((parts[0] as Extract<Part, { type: "text" }>).text).toContain("blocked an attachment");
  });

  it("redacts tool output and nested metadata before the next model turn", async () => {
    const hooks = createHooks(config, "redact");
    const output = {
      title: "read config",
      output: `token=${secret}`,
      metadata: { nested: { token: secret } },
    };

    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "session-1", callID: "call-1", args: {} }, output);

    expect(output.output).toContain("[REDACTED_API_KEY]");
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("scrubs historical tool output before it is replayed to the model", async () => {
    const hooks = createHooks(config, "block");
    const parts: Part[] = [{
      id: "tool-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "tool",
      callID: "call-1",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: `token=${secret}`,
        title: "read config",
        metadata: {},
        time: { start: 0, end: 1 },
      },
    }];

    await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info: {} as never, parts }] });

    expect(JSON.stringify(parts)).not.toContain(secret);
  });

  it("scrubs historical reasoning before it is replayed to the model", async () => {
    const hooks = createHooks(config, "block");
    const parts: Part[] = [{
      id: "reasoning-1",
      sessionID: "session-1",
      messageID: "message-1",
      type: "reasoning",
      text: `token=${secret}`,
      time: { start: 0, end: 1 },
    }];

    await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info: {} as never, parts }] });

    expect(JSON.stringify(parts)).not.toContain(secret);
    expect(JSON.stringify(parts)).toContain("LeakShield blocked reasoning text");
  });

  it("scrubs system prompts before they are sent to the model", async () => {
    const hooks = createHooks(config, "block");
    const output = { system: [`instructions with token=${secret}`] };

    await hooks["experimental.chat.system.transform"]!({ model: {} as never }, output);

    expect(JSON.stringify(output)).not.toContain(secret);
    expect(output.system[0]).toContain("LeakShield blocked system prompt");
  });

  it("scrubs tool definitions before they are sent to the model", async () => {
    const hooks = createHooks(config, "block");
    const output = {
      description: `uses token=${secret}`,
      parameters: { type: "object", example: secret },
    };

    await hooks["tool.definition"]!({ toolID: "unsafe-tool" }, output);

    expect(JSON.stringify(output)).not.toContain(secret);
  });
});

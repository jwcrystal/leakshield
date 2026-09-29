import { describe, expect, it } from "vitest";
import { createFailClosedV2Setup, createV2Setup } from "../src/opencode-v2.js";
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

type HookCallback = (event: unknown) => Promise<void> | void;
type RecordedHook = { domain: "session" | "tool"; name: string; callback: HookCallback };

function createFakeContext() {
  const hooks: RecordedHook[] = [];
  const register =
    (domain: "session" | "tool") =>
    async (name: string, callback: HookCallback) => {
      hooks.push({ domain, name, callback });
      return { dispose: async () => {} };
    };
  return {
    hooks,
    ctx: {
      options: {},
      location: { directory: process.cwd() },
      session: { hook: register("session") },
      tool: { hook: register("tool") },
    } as never,
  };
}

async function loadHooks(setup: (ctx: never) => Promise<void>) {
  const fake = createFakeContext();
  await setup(fake.ctx);
  return fake.hooks;
}

function findHook(hooks: RecordedHook[], name: string): HookCallback {
  const hook = hooks.find((h) => `${h.domain}:${h.name}` === name);
  if (!hook) throw new Error(`hook ${name} not registered`);
  return hook.callback;
}

describe("OpenCode v2 plugin", () => {
  it("protects prompt text and drops unscannable attachments at admission", async () => {
    const hooks = await loadHooks(createV2Setup(config, "block"));
    const event = {
      prompt: {
        text: `token=${secret}`,
        files: [{ uri: "file:///private.txt" }],
      },
    };

    await findHook(hooks, "session:prompt")(event);

    expect(event.prompt.text).not.toContain(secret);
    expect(event.prompt.text).toContain("Sensitive Guard blocked message text");
    expect(event.prompt.text).toContain("blocked an attachment");
    expect(event.prompt.files).toEqual([]);
  });

  it("scrubs system prompts, message parts, and tool definitions before dispatch", async () => {
    const hooks = await loadHooks(createV2Setup(config, "block"));
    const event = {
      system: [{ type: "text", text: `instructions with token=${secret}` }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `token=${secret}` },
            { type: "reasoning", text: `token=${secret}` },
            { type: "media", media: { source: { type: "bytes", data: new Uint8Array([1]) } } },
            { type: "tool-call", id: "call-1", name: "read", input: { path: secret } },
            {
              type: "tool-result",
              id: "call-1",
              name: "read",
              result: { type: "text", value: `token=${secret}` },
            },
          ],
        },
      ],
      tools: {
        read: { description: `uses token=${secret}`, input: { type: "object", example: secret } },
      },
    };

    await findHook(hooks, "session:context")(event);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    expect(event.system[0].text).toContain("Sensitive Guard blocked system prompt");
    const textPart = event.messages[0].content[0] as { text: string };
    expect(textPart.text).toContain("Sensitive Guard blocked message text");
    const mediaReplacement = event.messages[0].content[2] as { type: string; text: string };
    expect(mediaReplacement.type).toBe("text");
    expect(mediaReplacement.text).toContain("blocked an attachment");
    expect(event.tools.read.description).not.toContain(secret);
  });

  it("scrubs tool result content arrays before replay", async () => {
    const hooks = await loadHooks(createV2Setup(config, "block"));
    const event = {
      system: [],
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              id: "call-1",
              name: "read",
              result: {
                type: "content",
                value: [{ type: "text", text: `token=${secret}` }],
              },
            },
          ],
        },
      ],
      tools: {},
    };

    await findHook(hooks, "session:context")(event);

    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("protects tool execution results after completion", async () => {
    const hooks = await loadHooks(createV2Setup(config, "redact"));
    const event = {
      tool: "read",
      sessionID: "session-1",
      status: "completed",
      result: {
        content: [{ type: "text", text: `token=${secret}` }],
        output: { nested: `token=${secret}` },
        metadata: { title: `read ${secret}` },
      },
    };

    await findHook(hooks, "tool:execute.after")(event);

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED_API_KEY]");
  });

  it("leaves failed tool executions untouched", async () => {
    const hooks = await loadHooks(createV2Setup(config, "redact"));
    const event = {
      tool: "read",
      sessionID: "session-1",
      status: "error",
      error: { message: "boom" },
    };

    await findHook(hooks, "tool:execute.after")(event);

    expect(event.error.message).toBe("boom");
  });

  it("registers the same protection on auxiliary model requests", async () => {
    const hooks = await loadHooks(createV2Setup(config, "block"));

    for (const name of ["session:compaction", "session:generate", "session:title"]) {
      expect(hooks.some((h) => `${h.domain}:${h.name}` === name)).toBe(true);
    }
  });

  it("fails closed on every registered hook when initialization fails", async () => {
    const hooks = await loadHooks(createFailClosedV2Setup());

    expect(hooks).toHaveLength(6);
    for (const hook of hooks) {
      await expect(
        hook.callback({ prompt: { text: "safe text" }, system: [], messages: [], tools: {} }),
      ).rejects.toThrow("Sensitive Guard initialization failed");
    }
  });
});

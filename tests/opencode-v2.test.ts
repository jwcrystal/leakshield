import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createSessionKey, placeholderFor } from "../src/decision/deidentify.js";
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

describe("OpenCode v2 plugin — email de-identification", () => {
  const emailA = "alice.canary@example-test.invalid";
  const emailB = "bob.canary@example-test.invalid";

  it("replaces repeated emails with one stable per-session placeholder at prompt admission", async () => {
    const sessionKey = createSessionKey();
    const hooks = await loadHooks(createV2Setup(config, "redact", { sessionKey }));
    const event = {
      prompt: {
        text: `Email ${emailA} twice: ${emailA} and ${emailB} once.`,
        files: [],
      },
    };

    await findHook(hooks, "session:prompt")(event);

    const text = event.prompt.text;
    expect(text).not.toContain(emailA);
    expect(text).not.toContain(emailB);
    expect(text.split("[SG-EMAIL-").length - 1).toBe(3);
    const alicePlaceholder = placeholderFor(emailA, sessionKey);
    expect(text.split(alicePlaceholder).length - 1).toBe(2);
    const placeholders = text.match(/\[SG-EMAIL-[0-9a-f]{16}\]/g) ?? [];
    expect(placeholders.filter((p) => p !== alicePlaceholder)).toHaveLength(1);
  });

  it("uses the same placeholder for the same email across prompt and tool output hooks", async () => {
    const sessionKey = createSessionKey();
    const hooks = await loadHooks(createV2Setup(config, "redact", { sessionKey }));
    // Both hooks fire within session "session-1": its placeholder key is
    // HMAC-SHA256(masterKey, `session:session-1`).
    const sessionOneKey = createHmac("sha256", sessionKey).update("session:session-1").digest();

    const promptEvent = { sessionID: "session-1", prompt: { text: `reach ${emailA} tomorrow`, files: [] } };
    await findHook(hooks, "session:prompt")(promptEvent);
    const alicePlaceholder = placeholderFor(emailA, sessionOneKey);
    expect(promptEvent.prompt.text).toContain(alicePlaceholder);
    expect(promptEvent.prompt.text).not.toContain(emailA);

    const toolEvent = {
      tool: "read",
      sessionID: "session-1",
      status: "completed",
      result: { content: [{ type: "text", text: `mailbox owner: ${emailA}` }] },
    };
    await findHook(hooks, "tool:execute.after")(toolEvent);

    const serialized = JSON.stringify(toolEvent);
    expect(serialized).not.toContain(emailA);
    expect(serialized).toContain(alicePlaceholder);
  });

  it("keeps HIGH keys out of de-identified output", async () => {
    const sessionKey = createSessionKey();
    const hooks = await loadHooks(createV2Setup(config, "redact", { sessionKey }));
    const event = {
      prompt: {
        text: `rotate ${secret} then mail ${emailA}`,
        files: [],
      },
    };

    await findHook(hooks, "session:prompt")(event);

    const text = event.prompt.text;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(emailA);
    expect(text).toContain("[SG-EMAIL-");
  });

  it("derives placeholder keys per sessionID: stable within a session, different across sessions", async () => {
    const sessionKey = createSessionKey();
    const hooks = await loadHooks(createV2Setup(config, "redact", { sessionKey }));
    const placeholderRe = /\[SG-EMAIL-[0-9a-f]{16}\]/;

    const runPrompt = async (sessionID: string): Promise<string> => {
      const event = { sessionID, prompt: { text: `reach ${emailA} tomorrow`, files: [] } };
      await findHook(hooks, "session:prompt")(event);
      return event.prompt.text as string;
    };

    const s1 = await runPrompt("s1");
    const s2 = await runPrompt("s2");
    const s1Again = await runPrompt("s1");

    expect(s1).not.toContain(emailA);
    expect(s2).not.toContain(emailA);
    const p1 = s1.match(placeholderRe)![0];
    const p2 = s2.match(placeholderRe)![0];
    expect(p1).not.toBe(p2);
    expect(s1Again).toContain(p1);
    expect(s1Again).not.toContain(p2);
  });

  it("falls back to the setup master key for events without a sessionID", async () => {
    const sessionKey = createSessionKey();
    const hooks = await loadHooks(createV2Setup(config, "redact", { sessionKey }));
    const event = { prompt: { text: `reach ${emailA} tomorrow`, files: [] } };

    await findHook(hooks, "session:prompt")(event);

    expect(event.prompt.text).not.toContain(emailA);
    expect(event.prompt.text).toContain(placeholderFor(emailA, sessionKey));
  });
});

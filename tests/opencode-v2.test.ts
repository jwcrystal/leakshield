import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionKey, placeholderFor } from "../src/decision/deidentify.js";
import { createFailClosedV2Setup, createV2Setup } from "../src/opencode-v2.js";
import { EnvQueryService } from "../src/env-queries.js";
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
type RecordedTool = { name: string; tool: Record<string, unknown> };

function createFakeContext() {
  const hooks: RecordedHook[] = [];
  const transforms: Array<(editor: unknown) => void> = [];
  const register =
    (domain: "session" | "tool") =>
    async (name: string, callback: HookCallback) => {
      hooks.push({ domain, name, callback });
      return { dispose: async () => {} };
    };
  return {
    hooks,
    transforms,
    ctx: {
      options: {},
      location: { directory: process.cwd() },
      session: { hook: register("session") },
      tool: {
        hook: register("tool"),
        transform: async (callback: (editor: unknown) => void) => {
          transforms.push(callback);
          return { dispose: async () => {} };
        },
      },
    } as never,
  };
}

function runTransforms(transforms: Array<(editor: unknown) => void>): RecordedTool[] {
  const added: RecordedTool[] = [];
  const editor = {
    add: (tool: Record<string, unknown>) => added.push({ name: tool.name as string, tool }),
  };
  for (const transform of transforms) transform(editor);
  return added;
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

describe("OpenCode v2 plugin — readonly env query tools", () => {
  const temporaryDirectories: string[] = [];
  const secretValue = "unclassified-opaque-value-987654321";

  function makeEnvWorkspace(): { root: string; configPath: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-v2env-"));
    temporaryDirectories.push(root);
    const configPath = path.join(root, "guard.config.yaml");
    fs.writeFileSync(path.join(root, ".env"), `API_TOKEN=${secretValue}\nFLAG=true\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");
    return { root, configPath };
  }

  function makeService(root: string, configPath: string): EnvQueryService {
    return new EnvQueryService({
      envFiles: [".env"],
      workspaceRoot: root,
      resolveConfigPath: () => configPath,
      configFingerprint: createHash("sha256")
        .update(fs.readFileSync(configPath, "utf8"))
        .digest("hex"),
    });
  }

  it("registers the three tools alongside the protection hooks", async () => {
    const { root, configPath } = makeEnvWorkspace();
    const fake = createFakeContext();
    await createV2Setup(config, "block", undefined, makeService(root, configPath))(fake.ctx);

    // Protection hooks unchanged.
    expect(fake.hooks.map((h) => `${h.domain}:${h.name}`)).toContain("session:prompt");
    const added = runTransforms(fake.transforms);
    expect(added.map((t) => t.name).sort()).toEqual([
      "guard_env_compare",
      "guard_env_inspect",
      "guard_env_list",
    ]);
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("registers no tools without a service (default off)", async () => {
    const fake = createFakeContext();
    await createV2Setup(config, "block")(fake.ctx);
    expect(fake.transforms).toHaveLength(0);
  });

  it("executes list, inspect, and compare without exposing values", async () => {
    const { root, configPath } = makeEnvWorkspace();
    const fake = createFakeContext();
    await createV2Setup(config, "block", undefined, makeService(root, configPath))(fake.ctx);
    const added = runTransforms(fake.transforms);
    const byName = new Map(added.map((t) => [t.name, t.tool]));
    type Execute = (
      input: unknown,
      context: { sessionID: string },
    ) => Promise<{ output: Record<string, unknown>; content: string }>;
    const execute = (name: string) => byName.get(name)!.execute as Execute;

    const list = await execute("guard_env_list")({}, { sessionID: "session-1" });
    const files = (list.output as { files: Array<{ file_id: string; keys: string[] }> }).files;
    expect(files[0].keys).toEqual(["API_TOKEN", "FLAG"]);
    const fileId = files[0].file_id;

    const inspect = await execute("guard_env_inspect")({ file_id: fileId, key: "FLAG" }, { sessionID: "session-1" });
    expect(inspect.output).toEqual({ status: "nonempty", shape: "boolean_like" });

    const compare = await execute("guard_env_compare")(
      { left_file_id: fileId, left_key: "API_TOKEN", right_file_id: fileId, right_key: "FLAG" },
      { sessionID: "session-1" },
    );
    expect(compare.output).toEqual({ result: "different" });

    const serialized = JSON.stringify([list, inspect, compare]);
    expect(serialized).not.toContain(secretValue);
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain(root);
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps config drift to the fixed disabled error", async () => {
    const { root, configPath } = makeEnvWorkspace();
    const service = makeService(root, configPath);
    const fake = createFakeContext();
    await createV2Setup(config, "block", undefined, service)(fake.ctx);
    const added = runTransforms(fake.transforms);
    const listTool = added.find((t) => t.name === "guard_env_list")!.tool;
    const execute = listTool.execute as (
      input: unknown,
      context: { sessionID: string },
    ) => Promise<{ output: Record<string, unknown> }>;

    expect((await execute({}, { sessionID: "session-1" })).output).toHaveProperty("files");

    fs.writeFileSync(configPath, "settings:\n  env_files: []\n", "utf8");
    expect((await execute({}, { sessionID: "session-1" })).output).toEqual({
      error: "Env queries are disabled because the guard configuration changed. Restart OpenCode.",
    });
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Part } from "@opencode-ai/sdk";
import sensitiveGuardPlugin, * as pluginModule from "../src/opencode.js";

const secret = "sk-12345678901234567890";
const temporaryDirectories: string[] = [];
const exactSecret = "unclassified-opaque-value-987654321";

function textPart(text: string): Part {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text",
    text,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCode plugin entry", () => {
  it("exports one default entry that serves both OpenCode v1 and v2 loaders", () => {
    expect(Object.keys(pluginModule)).toEqual(["default"]);
    expect(sensitiveGuardPlugin.id).toBe("sensitive-guard");
    expect(typeof sensitiveGuardPlugin.setup).toBe("function");
    expect(typeof sensitiveGuardPlugin.server).toBe("function");
  });

  it("removes sensitive content before constructing a provider payload (v1 server)", async () => {
    const hooks = await sensitiveGuardPlugin.server({} as never, { mode: "block" });
    const parts = [textPart(`token=${secret}`)];

    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });
    const providerPayload = JSON.stringify(parts);

    expect(providerPayload).not.toContain(secret);
    expect(providerPayload).toContain("Sensitive Guard blocked message text");
  });

  it("blocks model requests when configuration loading fails (v1 server)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "invalid.yaml");
    fs.writeFileSync(configPath, "settings:\n  max_chars: invalid\n", "utf8");

    const hooks = await sensitiveGuardPlugin.server({} as never, { configPath });
    const invokeHook = hooks["chat.message"]!({ sessionID: "session-1" }, {
      message: {} as never,
      parts: [textPart("safe text")],
    });

    await expect(invokeHook).rejects.toThrow("Sensitive Guard initialization failed");
  });

  it("loads configured env_files relative to the OpenCode workspace (v1 server)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `TOKEN=${exactSecret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const hooks = await sensitiveGuardPlugin.server({ worktree: directory } as never, { configPath });
    const parts = [textPart(`token=${exactSecret}`)];
    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });

    expect(JSON.stringify(parts)).not.toContain(exactSecret);
    expect(JSON.stringify(parts)).toContain("Sensitive Guard blocked message text");
  });

  it("fails closed when deidentify is requested on the v1 server (v1 has no de-identification)", async () => {
    const hooks = await sensitiveGuardPlugin.server({} as never, { mode: "redact", deidentify: true });

    await expect(
      hooks["chat.message"]!({ sessionID: "session-1" }, {
        message: {} as never,
        parts: [textPart("safe text")],
      }),
    ).rejects.toThrow("Sensitive Guard initialization failed");
  });

  it("blocks model requests when plugin options are invalid (v1 server)", async () => {
    const hooks = await sensitiveGuardPlugin.server({} as never, { mode: "unsupported" });

    await expect(hooks["experimental.chat.messages.transform"]!({}, { messages: [] }))
      .rejects.toThrow("Sensitive Guard initialization failed");
  });

  it("registers protecting hooks on the OpenCode v2 context (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "block" },
      location: { directory: process.cwd() },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ domain: "session", name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ domain: "tool", name, callback });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered.map((r) => `${r.domain}:${r.name}`)).toEqual([
      "session:prompt",
      "session:context",
      "session:compaction",
      "session:generate",
      "session:title",
      "tool:execute.after",
    ]);

    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    const event = { prompt: { text: `token=${secret}`, files: [] } };
    await promptHook(event);

    expect((event.prompt as { text: string }).text).not.toContain(secret);
    expect((event.prompt as { text: string }).text).toContain("Sensitive Guard blocked message text");
  });

  it("registers fail-closed hooks when plugin options are invalid (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "unsupported" },
      location: { directory: process.cwd() },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name: `tool:${name}`, callback });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "Sensitive Guard initialization failed",
    );
  });

  it("initializes de-identification when mode is redact (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "redact", deidentify: true },
      location: { directory: process.cwd() },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ domain: "session", name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ domain: "tool", name, callback });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered.map((r) => `${r.domain}:${r.name}`)).toEqual([
      "session:prompt",
      "session:context",
      "session:compaction",
      "session:generate",
      "session:title",
      "tool:execute.after",
    ]);

    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    const event = {
      prompt: { text: "email alice@example.com twice: alice@example.com", files: [] },
    };
    await promptHook(event);

    const text = (event.prompt as { text: string }).text;
    expect(text).not.toContain("alice@example.com");
    const placeholders = text.match(/\[SG-EMAIL-[0-9a-f]{16}\]/g) ?? [];
    expect(placeholders).toHaveLength(2);
    expect(new Set(placeholders).size).toBe(1);
  });

  it("fails closed when deidentify is set without mode redact (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "block", deidentify: true },
      location: { directory: process.cwd() },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name: `tool:${name}`, callback });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "Sensitive Guard initialization failed",
    );
  });

  it("fails closed when deidentify has the wrong type (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { deidentify: "yes" },
      location: { directory: process.cwd() },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name: `tool:${name}`, callback });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "Sensitive Guard initialization failed",
    );
  });
});

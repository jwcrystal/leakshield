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

  it("registers no env query tools by default (v1 server)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), "KEY=value\n", "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const hooks = await sensitiveGuardPlugin.server({ worktree: directory } as never, { configPath });
    expect(hooks.tool).toBeUndefined();
  });

  it("fails closed when envQueries has the wrong type (v1 server)", async () => {
    const hooks = await sensitiveGuardPlugin.server({} as never, { envQueries: "yes" });

    await expect(hooks["chat.message"]!({ sessionID: "session-1" }, {
      message: {} as never,
      parts: [textPart("safe text")],
    })).rejects.toThrow("Sensitive Guard initialization failed");
  });

  it("exposes readonly env query tools when envQueries is enabled (v1 server)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${exactSecret}\nFLAG=true\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const hooks = await sensitiveGuardPlugin.server(
      { worktree: directory } as never,
      { configPath, envQueries: true },
    );
    const tools = hooks.tool!;
    expect(Object.keys(tools).sort()).toEqual(["guard_env_compare", "guard_env_inspect", "guard_env_list"]);

    const context = { sessionID: "session-1" } as never;
    const list = JSON.parse(
      (await (tools.guard_env_list!.execute as (args: unknown, ctx: unknown) => Promise<{ output: string }>)(
        {},
        context,
      )).output,
    );
    expect(list.files).toHaveLength(1);
    expect(list.files[0].available).toBe(true);
    expect(list.files[0].keys).toEqual(["API_TOKEN", "FLAG"]);
    const fileId = list.files[0].file_id;
    expect(fileId).toMatch(/^[0-9a-f]{16}$/);

    const inspect = JSON.parse(
      (await tools.guard_env_inspect!.execute({ file_id: fileId, key: "FLAG" }, context)).output,
    );
    expect(inspect).toEqual({ status: "nonempty", shape: "boolean_like" });

    const compare = JSON.parse(
      (await tools.guard_env_compare!.execute(
        { left_file_id: fileId, left_key: "API_TOKEN", right_file_id: fileId, right_key: "API_TOKEN" },
        context,
      )).output,
    );
    expect(compare).toEqual({ result: "equal" });

    // Tool payloads carry key names and statuses only — never values or paths.
    const serialized = JSON.stringify([list, inspect, compare]);
    expect(serialized).not.toContain(exactSecret);
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain(directory);

    // Config drift disables the tools until restart (fixed sanitized error).
    fs.writeFileSync(configPath, "settings:\n  env_files: []\n", "utf8");
    const disabled = JSON.parse(
      (await tools.guard_env_list!.execute({}, { sessionID: "session-1" } as never)).output,
    );
    expect(disabled).toEqual({
      error: "Env queries are disabled because the guard configuration changed. Restart OpenCode.",
    });
  });

  it("keeps protection hooks active alongside env query tools (v1 server)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${exactSecret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const hooks = await sensitiveGuardPlugin.server(
      { worktree: directory } as never,
      { configPath, envQueries: true },
    );
    const parts = [textPart(`token=${exactSecret}`)];
    await hooks["chat.message"]!({ sessionID: "session-1" }, { message: {} as never, parts });
    expect(JSON.stringify(parts)).not.toContain(exactSecret);
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

  it("fails closed when envQueries has the wrong type (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { envQueries: 1 },
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

  it("registers no env query tools by default (v2 setup)", async () => {
    const transforms: Array<(editor: unknown) => void> = [];
    const ctx = {
      options: {},
      location: { directory: process.cwd() },
      session: {
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: {
        hook: async () => ({ dispose: async () => {} }),
        transform: async (callback: (editor: unknown) => void) => {
          transforms.push(callback);
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(transforms).toHaveLength(0);
  });

  it("registers readonly env query tools when envQueries is enabled (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${exactSecret}\nFLAG=true\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const addedTools: Array<{ name: string; tool: Record<string, unknown> }> = [];
    const ctx = {
      options: { configPath, envQueries: true },
      location: { directory },
      session: {
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: {
        hook: async () => ({ dispose: async () => {} }),
        transform: async (callback: (editor: unknown) => void) => {
          callback({
            add: (tool: Record<string, unknown>) => addedTools.push({ name: tool.name as string, tool }),
          });
          return { dispose: async () => {} };
        },
      },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

    expect(addedTools.map((t) => t.name).sort()).toEqual([
      "guard_env_compare",
      "guard_env_inspect",
      "guard_env_list",
    ]);
    const listTool = addedTools.find((t) => t.name === "guard_env_list")!.tool;
    const execute = listTool.execute as (
      input: unknown,
      context: { sessionID: string },
    ) => Promise<{ output: unknown; content: string }>;

    const list = await execute({}, { sessionID: "session-1" });
    const payload = list.output as {
      files: Array<{ file_id: string; keys: string[] }>;
    };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].keys).toEqual(["API_TOKEN", "FLAG"]);
    const fileId = payload.files[0].file_id;
    expect(fileId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(list)).not.toContain(exactSecret);
    expect(JSON.stringify(list)).not.toContain(".env");

    const inspectTool = addedTools.find((t) => t.name === "guard_env_inspect")!.tool;
    const inspect = await (inspectTool.execute as typeof execute)(
      { file_id: fileId, key: "FLAG" },
      { sessionID: "session-1" },
    );
    expect(inspect.output).toEqual({ status: "nonempty", shape: "boolean_like" });

    // Runtime validation: malformed v2 input maps to the fixed error.
    const badArgs = await (inspectTool.execute as typeof execute)({ file_id: fileId }, { sessionID: "session-1" });
    expect(badArgs.output).toEqual({ error: "Invalid arguments." });
  });

  it("registers the transparent-mode hook set on the OpenCode v2 context (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const hookFor = (domain: string) => {
      return async (name: string, callback: unknown) => {
        registered.push({ domain, name, callback });
        return { dispose: async () => {} };
      };
    };
    const ctx = {
      options: { mode: "transparent" },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      aisdk: { hook: hookFor("aisdk") },
    };

    await sensitiveGuardPlugin.setup(ctx as never);

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

    // Transparent mode tokenizes the outbound snapshot instead of blocking.
    const transparentSecret = "sk-QwertyuiopAsdfghjklZx";
    const contextHook = registered[0].callback as (event: unknown) => Promise<void> | void;
    const event = {
      sessionID: "session-1",
      system: [{ type: "text", text: `use ${transparentSecret}` }],
      messages: [],
      options: {},
    };
    await contextHook(event);
    expect((event.system as Array<{ text: string }>)[0].text).not.toContain(transparentSecret);
    expect((event.system as Array<{ text: string }>)[0].text).toMatch(/\[SGP1:[0-9a-f]{32}-\d{8,12}\]/);
  });

  it("fails closed on every route when transparent is combined with deidentify (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const hookFor = (domain: string) => {
      return async (name: string, callback: unknown) => {
        registered.push({ domain, name, callback });
        return { dispose: async () => {} };
      };
    };
    const ctx = {
      options: { mode: "transparent", deidentify: true },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      aisdk: { hook: hookFor("aisdk") },
    };

    const cleanup = await sensitiveGuardPlugin.setup(ctx as never);

    // Transparent fallback must cover the transport routes (http/ws/aisdk),
    // not only the redact-mode hooks — a partial fallback leaves them open.
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
    for (const record of registered) {
      await expect((async () => record.callback({ sessionID: "s" }))()).rejects.toThrow(
        "Sensitive Guard initialization failed",
      );
    }
    expect(typeof cleanup).toBe("function");
  });

  it("fails closed on every route when transparent is combined with envQueries (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const hookFor = (domain: string) => {
      return async (name: string, callback: unknown) => {
        registered.push({ domain, name, callback });
        return { dispose: async () => {} };
      };
    };
    const ctx = {
      options: { mode: "transparent", envQueries: true },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      aisdk: { hook: hookFor("aisdk") },
    };

    const cleanup = await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered).toHaveLength(12);
    for (const record of registered) {
      await expect((async () => record.callback({ sessionID: "s" }))()).rejects.toThrow(
        "Sensitive Guard initialization failed",
      );
    }
    expect(typeof cleanup).toBe("function");
  });

  it("fails closed across all routes when transparent config loading fails (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "invalid.yaml");
    fs.writeFileSync(configPath, "settings:\n  max_chars: invalid\n", "utf8");

    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const hookFor = (domain: string) => {
      return async (name: string, callback: unknown) => {
        registered.push({ domain, name, callback });
        return { dispose: async () => {} };
      };
    };
    const ctx = {
      options: { mode: "transparent", configPath },
      location: { directory },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      aisdk: { hook: hookFor("aisdk") },
    };

    const cleanup = await sensitiveGuardPlugin.setup(ctx as never);

    expect(registered).toHaveLength(12);
    const httpHook = registered.find((r) => r.name === "http.request")!.callback as (
      event: unknown,
    ) => Promise<void>;
    await expect((async () => httpHook({ sessionID: "s" }))()).rejects.toThrow(
      "Sensitive Guard initialization failed",
    );
    expect(typeof cleanup).toBe("function");
  });

  it("returns a disposal that releases the transparent guard registrations (v2 setup)", async () => {
    const disposed: string[] = [];
    const hookFor = (domain: string) => {
      return async (name: string) => ({ dispose: async () => void disposed.push(`${domain}:${name}`) });
    };
    const ctx = {
      options: { mode: "transparent" },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") },
      tool: { hook: hookFor("tool") },
      aisdk: { hook: hookFor("aisdk") },
    };

    const cleanup = await sensitiveGuardPlugin.setup(ctx as never);
    expect(typeof cleanup).toBe("function");

    await (cleanup as () => Promise<void>)();
    expect(disposed).toHaveLength(12);
    expect(disposed[0]).toBe("tool:execute.before");
    expect(disposed[disposed.length - 1]).toBe("session:context");
  });

  it("fails closed when transparent is requested on the v1 server (v1 has no transport hooks)", async () => {
    const hooks = await sensitiveGuardPlugin.server({} as never, { mode: "transparent" });

    await expect(
      hooks["chat.message"]!({ sessionID: "session-1" }, {
        message: {} as never,
        parts: [textPart("safe text")],
      }),
    ).rejects.toThrow("Sensitive Guard initialization failed");
  });
});

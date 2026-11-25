import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import leakshieldPlugin, * as pluginModule from "../src/adapters/opencode/plugin.js";

const secret = "sk-12345678901234567890";
const temporaryDirectories: string[] = [];
const exactSecret = "unclassified-opaque-value-987654321";

function textPart(text: string) {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "text" as const,
    text,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenCode plugin entry", () => {
  it("exports one default entry with the v2 setup and a v1 fail-closed stub", () => {
    expect(Object.keys(pluginModule)).toEqual(["default"]);
    expect(leakshieldPlugin.id).toBe("leakshield");
    expect(typeof leakshieldPlugin.setup).toBe("function");
    expect(typeof leakshieldPlugin.server).toBe("function");
  });

  it("returns fail-closed hooks from the v1 server stub without throwing", async () => {
    const validOptions = [undefined, {}, { mode: "block" }, { mode: "redact" }, { mode: "transparent" }];
    for (const options of validOptions) {
      const hooks = await leakshieldPlugin.server({} as never, options);

      await expect(
        hooks["chat.message"]!({ sessionID: "session-1" }, {
          message: {} as never,
          parts: [textPart(`token=${secret}`)],
        }),
      ).rejects.toThrow("no longer supports OpenCode v1");
      await expect(hooks["experimental.chat.messages.transform"]!({}, { messages: [] }))
        .rejects.toThrow("Upgrade to OpenCode v2");
      await expect(hooks["experimental.chat.system.transform"]!({ model: {} as never }, { system: [] }))
        .rejects.toThrow("no longer supports OpenCode v1");
      await expect(hooks["tool.definition"]!({ toolID: "t" }, { description: "d", parameters: {} }))
        .rejects.toThrow("no longer supports OpenCode v1");
      await expect(hooks["tool.execute.after"]!(
        { tool: "read", sessionID: "session-1", callID: "call-1", args: {} },
        { title: "t", output: "o", metadata: {} },
      )).rejects.toThrow("no longer supports OpenCode v1");
      expect(hooks.tool).toBeUndefined();
    }
  });

  it("blocks model requests when configuration loading fails in block mode (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "invalid.yaml");
    fs.writeFileSync(configPath, "settings:\n  max_chars: invalid\n", "utf8");

    const registered: Array<{ name: string; callback: unknown }> = [];
    await leakshieldPlugin.setup({
      options: { mode: "block", configPath },
      location: { directory },
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
    } as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "LeakShield initialization failed",
    );
  });

  it("loads configured env_files relative to the OpenCode workspace (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `TOKEN=${exactSecret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const registered: Array<{ name: string; callback: unknown }> = [];
    await leakshieldPlugin.setup({
      options: { mode: "block", configPath },
      location: { directory },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: { hook: async () => ({ dispose: async () => {} }) },
    } as never);

    const promptHook = registered.find((r) => r.name === "prompt")!.callback as (event: unknown) => Promise<void>;
    const event = { prompt: { text: `token=${exactSecret}`, files: [] } };
    await promptHook(event);

    expect(event.prompt.text).not.toContain(exactSecret);
    expect(event.prompt.text).toContain("LeakShield blocked message text");
  });

  it("keeps protection hooks active alongside env query tools (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${exactSecret}\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const registered: Array<{ name: string; callback: unknown }> = [];
    const addedTools: string[] = [];
    await leakshieldPlugin.setup({
      options: { mode: "block", configPath, envQueries: true },
      location: { directory },
      session: {
        hook: async (name: string, callback: unknown) => {
          registered.push({ name, callback });
          return { dispose: async () => {} };
        },
      },
      tool: {
        hook: async () => ({ dispose: async () => {} }),
        transform: async (callback: (editor: unknown) => void) => {
          callback({ add: (tool: { name: string }) => addedTools.push(tool.name) });
          return { dispose: async () => {} };
        },
      },
    } as never);

    expect(addedTools).toHaveLength(3);
    const promptHook = registered.find((r) => r.name === "prompt")!.callback as (event: unknown) => Promise<void>;
    const event = { prompt: { text: `token=${exactSecret}`, files: [] } };
    await promptHook(event);
    expect(event.prompt.text).not.toContain(exactSecret);
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

    await leakshieldPlugin.setup(ctx as never);

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
    expect((event.prompt as { text: string }).text).toContain("LeakShield blocked message text");
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

    await leakshieldPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "LeakShield initialization failed",
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

    await leakshieldPlugin.setup(ctx as never);

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

    await leakshieldPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    for (const record of registered) {
      const refusal = (record.callback as (event: unknown) => Promise<void>)({ prompt: { text: "safe text" } });
      await expect(refusal).rejects.toThrow("LeakShield initialization failed");
      await expect(refusal).rejects.toThrow("deidentify requires mode 'redact'");
    }
  });

  it("fails closed when deidentify has the wrong type (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "block", deidentify: "yes" },
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

    await leakshieldPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "LeakShield initialization failed",
    );
  });

  it("fails closed when envQueries has the wrong type (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const ctx = {
      options: { mode: "block", envQueries: 1 },
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

    await leakshieldPlugin.setup(ctx as never);

    expect(registered.length).toBe(6);
    const promptHook = registered[0].callback as (event: unknown) => Promise<void>;
    await expect(promptHook({ prompt: { text: "safe text" } })).rejects.toThrow(
      "LeakShield initialization failed",
    );
  });

  it("registers no env query tools by default (v2 setup)", async () => {
    const transforms: Array<(editor: unknown) => void> = [];
    const ctx = {
      options: { mode: "block" },
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

    await leakshieldPlugin.setup(ctx as never);

    expect(transforms).toHaveLength(0);
  });

  it("registers readonly env query tools when envQueries is enabled (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
    temporaryDirectories.push(directory);
    const configPath = path.join(directory, "guard.config.yaml");
    fs.writeFileSync(path.join(directory, ".env"), `API_TOKEN=${exactSecret}\nFLAG=true\n`, "utf8");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");

    const addedTools: Array<{ name: string; tool: Record<string, unknown> }> = [];
    const ctx = {
      options: { mode: "block", configPath, envQueries: true },
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

    await leakshieldPlugin.setup(ctx as never);

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
      provider: { transform: async () => ({ dispose: async () => {} }) },
    };

    await leakshieldPlugin.setup(ctx as never);

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
    expect((event.system as Array<{ text: string }>)[0].text).toMatch(/\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/);
  });

  it("does not require or change provider transport settings in hook-only mode", async () => {
    const callbacks = new Map<string, (event: unknown) => unknown>();
    const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
      callbacks.set(`${domain}:${name}`, callback);
      return { dispose: async () => {} };
    };
    const cleanup = await leakshieldPlugin.setup({
      options: { mode: "transparent", wireProtection: false },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") },
      // No provider.transform or aisdk API: neither is needed for hook-only.
    } as never);
    expect([...callbacks.keys()].some((key) => key.startsWith("aisdk:") || key === "session:http.request")).toBe(false);
    const event = { sessionID: "s", system: ["safe text"], messages: [], options: {} };
    await expect(Promise.resolve().then(() => callbacks.get("session:context")!(event))).resolves.toBeUndefined();
    await cleanup?.();
  });

  it.each([undefined, true, false])("passes wireProtection=%s through setup without weakening legacy omission", async (wireProtection) => {
    const callbacks = new Map<string, (event: unknown) => unknown>();
    const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
      callbacks.set(`${domain}:${name}`, callback);
      return { dispose: async () => {} };
    };
    const cleanup = await leakshieldPlugin.setup({
      options: { mode: "transparent", ...(wireProtection === undefined ? {} : { wireProtection }) },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") }, aisdk: { hook: hookFor("aisdk") },
      provider: { transform: async () => ({ dispose: async () => {} }) },
    } as never);
    const secret = "sk-QwertyuiopAsdfghjklZx";
    const request = new Request("https://api.openai.com/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-test", input: secret }),
    });
    const event = { sessionID: "session-1", kind: "primary", request };
    expect(callbacks.has("session:http.request")).toBe(wireProtection !== false);
    await callbacks.get("session:http.request")?.(event);
    const body = await event.request.clone().text();
    if (wireProtection === false) {
      expect(event.request).toBe(request);
      expect(body).toContain(secret);
    } else {
      expect(body).not.toContain(secret);
    }
    await cleanup?.();
  });

  it("keeps initialization fail-closed when hook-first options are malformed", async () => {
    const callbacks = new Map<string, (event: unknown) => unknown>();
    const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
      callbacks.set(`${domain}:${name}`, callback);
      return { dispose: async () => {} };
    };
    const cleanup = await leakshieldPlugin.setup({
      options: { mode: "transparent", wireProtection: "false" },
      location: { directory: process.cwd() },
      session: { hook: hookFor("session") }, tool: { hook: hookFor("tool") }, aisdk: { hook: hookFor("aisdk") },
    } as never);
    for (const name of ["session:context", "session:http.request", "session:http.response", "session:experimental.ws.handshake", "aisdk:language", "tool:execute.before"]) {
      expect(() => callbacks.get(name)!({})).toThrow("LeakShield initialization failed");
    }
    await cleanup?.();
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

    const cleanup = await leakshieldPlugin.setup(ctx as never);

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
        "LeakShield initialization failed",
      );
    }
    expect(typeof cleanup).toBe("function");
  });

  it("sets up transparent mode and warns when envQueries is combined with it (v2 setup)", async () => {
    const registered: Array<{ domain: string; name: string; callback: unknown }> = [];
    const hookFor = (domain: string) => {
      return async (name: string, callback: unknown) => {
        registered.push({ domain, name, callback });
        return { dispose: async () => {} };
      };
    };
    const addedTools: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cleanup = await leakshieldPlugin.setup({
        options: { mode: "transparent", envQueries: true },
        location: { directory: process.cwd() },
        session: { hook: hookFor("session") },
        tool: {
          hook: hookFor("tool"),
          transform: async (callback: (editor: unknown) => void) => {
            callback({ add: (tool: Record<string, unknown>) => addedTools.push(tool.name as string) });
            return { dispose: async () => {} };
          },
        },
        aisdk: { hook: hookFor("aisdk") },
        provider: { transform: async () => ({ dispose: async () => {} }) },
      } as never);

      // Not the fail-closed fallback: the normal transparent hook set is live.
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
      expect(addedTools.filter((name) => name.startsWith("guard_env_"))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("envQueries is ignored in transparent mode");

      // A guarded route answers normally instead of refusing as uninitialized.
      const contextHook = registered[0]!.callback as (event: unknown) => Promise<void> | void;
      const event = {
        sessionID: "session-1",
        system: [{ type: "text", text: "safe text" }],
        messages: [],
        options: {},
      };
      await expect(Promise.resolve().then(() => contextHook(event))).resolves.toBeUndefined();

      expect(typeof cleanup).toBe("function");
      await cleanup?.();
    } finally {
      warn.mockRestore();
    }
  });

  it("fails closed across all routes when transparent config loading fails (v2 setup)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
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

    const cleanup = await leakshieldPlugin.setup(ctx as never);

    expect(registered).toHaveLength(12);
    const httpHook = registered.find((r) => r.name === "http.request")!.callback as (
      event: unknown,
    ) => Promise<void>;
    await expect((async () => httpHook({ sessionID: "s" }))()).rejects.toThrow(
      "LeakShield initialization failed",
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
      provider: { transform: async () => ({ dispose: async () => void disposed.push("provider:transform") }) },
    };

    const cleanup = await leakshieldPlugin.setup(ctx as never);
    expect(typeof cleanup).toBe("function");

    await (cleanup as () => Promise<void>)();
    expect(disposed).toHaveLength(13);
    expect(disposed[0]).toBe("provider:transform");
    expect(disposed[1]).toBe("tool:execute.before");
    expect(disposed[disposed.length - 1]).toBe("session:context");
  });

  it("routes only native OpenAI providers through protected HTTP without changing credentials", async () => {
    const providers = [
      { id: "openai", package: "@opencode/ai/providers/openai", settings: { transport: "websocket", baseURL: "https://example.invalid/v1" }, headers: { authorization: "synthetic" } },
      { id: "custom-openai", package: "@opencode/ai/providers/openai", settings: {} },
      { id: "anthropic", package: "@opencode/ai/providers/anthropic", settings: { transport: "websocket" } },
      { id: "legacy", package: "@ai-sdk/openai", settings: { transport: "websocket" } },
    ];
    let disposed = false;
    const ctx = {
      options: { mode: "transparent" },
      location: { directory: process.cwd() },
      session: { hook: async () => ({ dispose: async () => {} }) },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      aisdk: { hook: async () => ({ dispose: async () => {} }) },
      provider: { transform: async (callback: (editor: unknown) => void) => {
        callback({
          list: () => providers.map((provider) => ({ provider })),
          update: (id: string, update: (provider: unknown) => void) => update(providers.find((provider) => provider.id === id)),
        });
        return { dispose: async () => { disposed = true; } };
      } },
    };
    const cleanup = await leakshieldPlugin.setup(ctx as never);
    expect(providers.map((provider) => (provider.settings as { transport?: string }).transport)).toEqual([
      "http", "http", "websocket", "websocket",
    ]);
    expect(providers[0].settings.baseURL).toBe("https://example.invalid/v1");
    expect(providers[0].headers).toEqual({ authorization: "synthetic" });
    await (cleanup as () => Promise<void>)();
    expect(disposed).toBe(true);
  });

  it("cleans up the normal guard and arms fail-closed hooks if HTTP routing registration fails", async () => {
    const callbacks: Array<(event: unknown) => unknown> = [];
    let disposed = 0;
    const hook = async (_name: string, callback: (event: unknown) => unknown) => {
      callbacks.push(callback);
      return { dispose: async () => { disposed += 1; } };
    };
    const ctx = {
      options: { mode: "transparent" },
      location: { directory: process.cwd() },
      session: { hook }, tool: { hook }, aisdk: { hook },
      provider: { transform: async () => { throw new Error("synthetic registration failure"); } },
    };
    const cleanup = await leakshieldPlugin.setup(ctx as never);
    expect(disposed).toBe(12);
    expect(callbacks).toHaveLength(24);
    for (const callback of callbacks.slice(12)) {
      expect(() => callback({ sessionID: "s" })).toThrow("LeakShield initialization failed");
      expect(() => callback({ sessionID: "s" })).toThrow("leakshield --doctor");
    }
    await (cleanup as () => Promise<void>)();
    expect(disposed).toBe(24);
  });

  it("defaults to the transparent hook set when options omit mode (v2 setup)", async () => {
    const hookNames = async (options: unknown) => {
      const registered: string[] = [];
      const hookFor = (domain: string) => async (name: string) => {
        registered.push(`${domain}:${name}`);
        return { dispose: async () => {} };
      };
      await leakshieldPlugin.setup({
        options,
        location: { directory: process.cwd() },
        session: { hook: hookFor("session") },
        tool: { hook: hookFor("tool") },
        aisdk: { hook: hookFor("aisdk") },
        provider: { transform: async () => ({ dispose: async () => {} }) },
      } as never);
      return registered;
    };

    const explicit = await hookNames({ mode: "transparent" });
    expect(explicit).toContain("session:http.request");
    expect(await hookNames({})).toEqual(explicit);
    expect(await hookNames(undefined)).toEqual(explicit);
  });

  it("fails closed across all routes when options omit mode and are invalid (v2 setup)", async () => {
    const registered: Array<{ name: string; callback: unknown }> = [];
    const hookFor = () => async (name: string, callback: unknown) => {
      registered.push({ name, callback });
      return { dispose: async () => {} };
    };
    const ctx = {
      // deidentify is rejected outside redact mode; mode omitted means the
      // transparent default, so this fails closed before setup runs.
      options: { deidentify: true },
      location: { directory: process.cwd() },
      session: { hook: hookFor() },
      tool: { hook: hookFor() },
      aisdk: { hook: hookFor() },
    };

    await leakshieldPlugin.setup(ctx as never);

    expect(registered).toHaveLength(12);
    const httpHook = registered.find((r) => r.name === "http.request")!.callback as (event: unknown) => Promise<void>;
    await expect((async () => httpHook({ sessionID: "s" }))()).rejects.toThrow("LeakShield initialization failed");
    await expect((async () => httpHook({ sessionID: "s" }))()).rejects.toThrow("deidentify requires mode 'redact'");
  });
  it("does not put rejected option values into the refusal (v2 setup)", async () => {
    const SENTINEL = "sk-LEAKCHECK-option-value";
    const registered: Array<{ name: string; callback: unknown }> = [];
    const hook = async (name: string, callback: unknown) => {
      registered.push({ name, callback });
      return { dispose: async () => {} };
    };
    await leakshieldPlugin.setup({
      options: { mode: "transparent", attachments: SENTINEL },
      location: { directory: process.cwd() },
      session: { hook },
      tool: { hook },
      aisdk: { hook },
    } as never);

    expect(registered.length).toBeGreaterThan(0);
    for (const record of registered) {
      const refusal = (async () => (record.callback as (event: unknown) => unknown)({ sessionID: "s" }))();
      await expect(refusal).rejects.toThrow("Invalid LeakShield options in opencode.json: attachments:");
      await expect(refusal).rejects.not.toThrow(SENTINEL);
    }
  });

  it.each(["block", "transparent"] as const)(
    "names a config load failure without its details in mode %s (v2 setup)",
    async (mode) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-"));
      temporaryDirectories.push(directory);
      const configPath = path.join(directory, "guard.config.yaml");
      const SENTINEL = "SENTINEL-rule-description";
      // An uncompilable pattern makes loadConfig throw, naming the rule's description.
      fs.writeFileSync(configPath, `custom_rules:\n  - description: "${SENTINEL}"\n    pattern: "("\n`, "utf8");

      const registered: Array<{ name: string; callback: unknown }> = [];
      const hook = async (name: string, callback: unknown) => {
        registered.push({ name, callback });
        return { dispose: async () => {} };
      };
      await leakshieldPlugin.setup({
        options: { mode, configPath },
        location: { directory },
        session: { hook },
        tool: { hook },
        aisdk: { hook },
      } as never);

      expect(registered.length).toBeGreaterThan(0);
      for (const record of registered) {
        const refusal = (async () => (record.callback as (event: unknown) => unknown)({ sessionID: "s" }))();
        await expect(refusal).rejects.toThrow("guard config file could not be loaded");
        await expect(refusal).rejects.not.toThrow(SENTINEL);
        await expect(refusal).rejects.not.toThrow(directory);
      }
    },
  );
  it.each(["block", "transparent"] as const)(
    "fails closed when configPath names a missing file in mode %s, without the path in the refusal (v2 setup)",
    async (mode) => {
      const missing = path.join(os.tmpdir(), "leakshield-missing-dir-for-test", "guard.config.yaml");
      const registered: Array<{ name: string; callback: unknown }> = [];
      const hook = async (name: string, callback: unknown) => {
        registered.push({ name, callback });
        return { dispose: async () => {} };
      };
      await leakshieldPlugin.setup({
        options: { mode, configPath: missing },
        location: { directory: process.cwd() },
        session: { hook },
        tool: { hook },
        aisdk: { hook },
      } as never);

      expect(registered.length).toBeGreaterThan(0);
      for (const record of registered) {
        const refusal = (async () => (record.callback as (event: unknown) => unknown)({ sessionID: "s" }))();
        await expect(refusal).rejects.toThrow("guard config file could not be loaded");
        await expect(refusal).rejects.not.toThrow("leakshield-missing-dir-for-test");
      }
    },
  );
});

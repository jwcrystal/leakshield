// Component under test: the managed launcher (src/pi/launcher.ts). It is
// exercised with recorded deps: no pi process, no proxy socket, no filesystem.
import { describe, expect, it } from "vitest";
import {
  buildManagedFiles,
  installPiExtension,
  parseLauncherArgs,
  parsePiVersion,
  runPiLauncher,
  type PiLauncherDeps,
} from "../src/pi/launcher.js";
import { loadConfig } from "../src/config/loader.js";
import type { PiProxy, PiProxyOptions } from "../src/pi/proxy.js";

const EXTENSION = "/pkg/dist/pi/extension.js";
const HOME = "/home/test";
const DATA = "/data/leakshield";

interface Recorded {
  written: Record<string, { content: string; mode: number }>;
  madeDirs: string[];
  removed: string[];
  childArgs: string[] | null;
  childEnv: Record<string, string> | null;
  proxyOptions: PiProxyOptions | null;
  closed: boolean;
  logs: string[];
}

function harness(files: Record<string, string>, overrides: Partial<PiLauncherDeps> = {}) {
  const recorded: Recorded = {
    written: {},
    madeDirs: [],
    removed: [],
    childArgs: null,
    childEnv: null,
    proxyOptions: null,
    closed: false,
    logs: [],
  };
  const proxy: PiProxy = {
    url: "http://127.0.0.1:4321",
    port: 4321,
    token: "p".repeat(48),
    handle: async () => new Response(null),
    close: async () => {
      recorded.closed = true;
    },
  };
  const deps: PiLauncherDeps = {
    env: { HOME, ANTHROPIC_API_KEY: "sk-ant-upstream", COMMANDCODE_API_KEY: "user-test-key", PATH: "/usr/bin" },
    cwd: "/work",
    home: HOME,
    readFile: (filePath) => files[filePath] ?? null,
    writeFile: (filePath, content, mode) => {
      recorded.written[filePath] = { content, mode };
    },
    mkdirp: (dirPath) => {
      recorded.madeDirs.push(dirPath);
    },
    rmrf: (target) => {
      recorded.removed.push(target);
    },
    resolvePi: () => "/usr/local/bin/pi",
    piVersion: () => "1.6.0",
    piAuthKey: () => null,
    runChild: async (_bin, args, env) => {
      recorded.childArgs = [...args];
      recorded.childEnv = { ...env };
      return 0;
    },
    startProxy: async (options) => {
      recorded.proxyOptions = options;
      return proxy;
    },
    loadGuardConfig: (configPath, cwd) => loadConfig(configPath, cwd),
    extensionPath: () => EXTENSION,
    dataDir: () => DATA,
    log: (line) => recorded.logs.push(line),
    randomId: () => "fixed-id",
    ...overrides,
  };
  return { deps, recorded };
}

const ANTHROPIC_SETTINGS = JSON.stringify({
  defaultProvider: "anthropic",
  defaultModel: "claude-test",
});

describe("pi launcher argument parsing", () => {
  it("owns its flags and forwards everything else to pi", () => {
    const { launcher, error } = parseLauncherArgs([
      "--continue",
      "--provider",
      "anthropic",
      "--model",
      "anthropic/claude-test",
      "--persist",
      "--persist-ttl-days",
      "30",
      "-p",
      "review this diff",
    ]);
    expect(error).toBeUndefined();
    expect(launcher.provider).toBe("anthropic");
    expect(launcher.model).toBe("anthropic/claude-test");
    expect(launcher.persist).toBe(true);
    expect(launcher.persistTtlDays).toBe(30);
    expect(launcher.piArgs).toEqual(["--continue", "-p", "review this diff"]);
  });

  it("rejects invalid numeric options", () => {
    expect(parseLauncherArgs(["--control-port", "70000"]).error).toContain("--control-port");
    expect(parseLauncherArgs(["--persist-ttl-days", "-1"]).error).toContain("--persist-ttl-days");
  });

  it("stops owning flags at the pi `--` separator", () => {
    const parsed = parseLauncherArgs(["--continue", "--", "--persist", "hello"]);
    expect(parsed.error).toBeUndefined();
    expect(parsed.launcher.persist).toBe(false);
    expect(parsed.launcher.piArgs).toEqual(["--continue", "--", "--persist", "hello"]);
  });

  it("refuses extra extensions before the separator only", () => {
    expect(parseLauncherArgs(["-e", "extra.ts"]).error).toContain("refuses additional extensions");
    expect(parseLauncherArgs(["--extension=extra.ts"]).error).toContain("refuses additional extensions");
    expect(parseLauncherArgs(["--", "-e", "message"]).error).toBeUndefined();
  });

  it("accepts pi 1.6 and later within major 1 only", () => {
    expect(parsePiVersion("1.6.0")).toBe("1.6.0");
    expect(parsePiVersion("pi 1.9.3 (build)")).toBe("1.9.3");
    expect(parsePiVersion("1.5.9")).toBeNull();
    expect(parsePiVersion("2.0.0")).toBeNull();
    expect(parsePiVersion(null)).toBeNull();
  });
});

describe("pi managed files", () => {
  it("points the only provider at the boundary and keeps credentials out of it", () => {
    const files = buildManagedFiles(
      {
        provider: "anthropic",
        upstream: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
        models: ["claude-test"],
        modelEntries: [{ id: "claude-test", contextWindow: 200000, baseUrl: "https://evil.test", apiKey: "sk-should-not-copy" }],
      },
      { proxyUrl: "http://127.0.0.1:4321", sessionDir: "/home/test/.pi/agent/sessions", extensionPath: EXTENSION },
    );
    const models = JSON.parse(files.modelsJson) as {
      providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: Array<Record<string, unknown>> }>;
    };
    expect(models.providers.anthropic).toEqual({
      baseUrl: "http://127.0.0.1:4321",
      api: "anthropic-messages",
      apiKey: "$LEAKSHIELD_PI_TOKEN",
      models: [{ id: "claude-test", contextWindow: 200000 }],
    });
    expect(files.modelsJson).not.toContain("api.anthropic.com");
    expect(files.modelsJson).not.toContain("sk-should-not-copy");
    expect(files.modelsJson).not.toContain("evil.test");
    const settings = JSON.parse(files.settingsJson) as Record<string, unknown>;
    expect(settings).toEqual({
      packages: [],
      extensions: [EXTENSION],
      sessionDir: "/home/test/.pi/agent/sessions",
      defaultProvider: "anthropic",
    });
  });
});

describe("pi extension installation", () => {
  it("adds the extension once and preserves unrelated settings", () => {
    const files: Record<string, string> = {
      "/home/test/.pi/agent/settings.json": JSON.stringify({ defaultProvider: "anthropic", extensions: ["/other/ext.ts"] }),
    };
    const recorded: Array<{ path: string; content: string; mode: number }> = [];
    const deps = {
      readFile: (filePath: string) => files[filePath] ?? null,
      writeFile: (filePath: string, content: string, mode: number) => {
        recorded.push({ path: filePath, content, mode });
        files[filePath] = content;
      },
      mkdirp: () => {},
      extensionPath: () => EXTENSION,
    };
    const first = installPiExtension(deps, "/home/test/.pi/agent");
    expect(first).toEqual({ ok: true, settingsPath: "/home/test/.pi/agent/settings.json", changed: true });
    const written = JSON.parse(recorded[0]?.content ?? "{}") as { defaultProvider?: string; extensions?: string[] };
    expect(written.defaultProvider).toBe("anthropic");
    expect(written.extensions).toEqual(["/other/ext.ts", EXTENSION]);
    expect(recorded[0]?.mode).toBe(0o600);
    expect(installPiExtension(deps, "/home/test/.pi/agent")).toEqual({
      ok: true,
      settingsPath: "/home/test/.pi/agent/settings.json",
      changed: false,
    });
  });

  it("refuses malformed or wrongly shaped settings", () => {
    const deps = {
      readFile: () => "{oops",
      writeFile: () => {},
      mkdirp: () => {},
      extensionPath: () => EXTENSION,
    };
    expect(installPiExtension(deps, "/a")).toEqual({ ok: false, reason: "/a/settings.json is not valid JSON" });
    const shaped = { ...deps, readFile: () => JSON.stringify({ extensions: "x" }) };
    expect(installPiExtension(shaped, "/a")).toEqual({ ok: false, reason: "/a/settings.json.extensions is not an array" });
  });
});

describe("pi managed launch", () => {
  it("writes a generated agent directory and starts pi behind the boundary", async () => {
    const { deps, recorded } = harness({ "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS });
    const code = await runPiLauncher(["--continue", "--provider", "anthropic"], deps);
    expect(code).toBe(0);

    expect(recorded.proxyOptions?.upstream).toEqual({
      baseUrl: "https://api.anthropic.com",
      api: "anthropic-messages",
      apiKey: "sk-ant-upstream",
      headers: undefined,
    });
    expect(recorded.proxyOptions?.models).toEqual([]);

    const agentDir = `${DATA}/pi/run-fixed-id/agent`;
    expect(recorded.madeDirs).toContain(agentDir);
    expect(recorded.written[`${agentDir}/models.json`]?.mode).toBe(0o600);
    expect(recorded.written[`${agentDir}/settings.json`]?.mode).toBe(0o600);
    const models = JSON.parse(recorded.written[`${agentDir}/models.json`]?.content ?? "{}") as {
      providers: Record<string, { baseUrl: string }>;
    };
    expect(models.providers.anthropic?.baseUrl).toBe("http://127.0.0.1:4321");

    expect(recorded.childArgs).toEqual([
      "--continue",
      "--provider",
      "anthropic",
      "--model",
      "claude-test",
      "--no-extensions",
      "--extension",
      EXTENSION,
      "--no-approve",
    ]);
    expect(recorded.childEnv).toMatchObject({
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: "/home/test/.pi/agent/sessions",
      LEAKSHIELD_PI_URL: "http://127.0.0.1:4321",
      LEAKSHIELD_PI_TOKEN: "p".repeat(48),
      PATH: "/usr/bin",
    });
    expect(recorded.childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(recorded.childEnv).not.toHaveProperty("COMMANDCODE_API_KEY");
    expect(recorded.closed).toBe(true);
    expect(recorded.removed).toEqual([`${DATA}/pi/run-fixed-id`]);
  });

  it("selects the generated default provider when no model is configured", async () => {
    const { deps, recorded } = harness({
      "/home/test/.pi/agent/settings.json": JSON.stringify({ defaultProvider: "anthropic" }),
    });
    expect(await runPiLauncher([], deps)).toBe(0);
    expect(recorded.childArgs).not.toContain("--provider");
    expect(recorded.childArgs).not.toContain("--model");
    const settings = JSON.parse(recorded.written[`${DATA}/pi/run-fixed-id/agent/settings.json`]?.content ?? "{}") as {
      defaultProvider?: string;
    };
    expect(settings.defaultProvider).toBe("anthropic");
  });

  it("scrubs every environment name the credential resolution read", async () => {
    const { deps, recorded } = harness(
      {
        "/home/test/.pi/agent/settings.json": JSON.stringify({ defaultProvider: "local" }),
        "/home/test/.pi/agent/models.json": JSON.stringify({
          providers: {
            local: {
              baseUrl: "https://local.test/v1",
              api: "openai-completions",
              apiKey: "$LOCAL_KEY",
              headers: { "x-org": "$LOCAL_ORG" },
              models: [{ id: "m1" }],
            },
          },
        }),
      },
      { env: { HOME, LOCAL_KEY: "sk-local", LOCAL_ORG: "org-1", PATH: "/usr/bin" } },
    );
    expect(await runPiLauncher([], deps)).toBe(0);
    expect(recorded.proxyOptions?.upstream.apiKey).toBe("sk-local");
    expect(recorded.childEnv).not.toHaveProperty("LOCAL_KEY");
    expect(recorded.childEnv).not.toHaveProperty("LOCAL_ORG");
  });

  it("keeps mandatory flags before the pi message separator", async () => {
    const { deps, recorded } = harness({ "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS });
    expect(await runPiLauncher(["--", "--persist", "message"], deps)).toBe(0);
    expect(recorded.childArgs).toEqual([
      "--provider",
      "anthropic",
      "--model",
      "claude-test",
      "--no-extensions",
      "--extension",
      EXTENSION,
      "--no-approve",
      "--",
      "--persist",
      "message",
    ]);
  });

  it("falls back to pi's own credential resolution", async () => {
    const { deps, recorded } = harness(
      { "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS },
      { env: { HOME, PATH: "/usr/bin" }, piAuthKey: () => "sk-from-auth-file" },
    );
    expect(await runPiLauncher([], deps)).toBe(0);
    expect(recorded.proxyOptions?.upstream.apiKey).toBe("sk-from-auth-file");
  });

  it("refuses to launch without a credential, a supported pi, or a provider", async () => {
    const noCredential = harness(
      { "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS },
      { env: { HOME, PATH: "/usr/bin" } },
    );
    expect(await runPiLauncher([], noCredential.deps)).toBe(1);

    const noPi = harness(
      { "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS },
      { resolvePi: () => null },
    );
    expect(await runPiLauncher([], noPi.deps)).toBe(1);
    expect(noPi.recorded.logs.join("\n")).toContain("not found on PATH");

    const oldPi = harness(
      { "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS },
      { piVersion: () => "1.5.0" },
    );
    expect(await runPiLauncher([], oldPi.deps)).toBe(1);
    expect(oldPi.recorded.logs.join("\n")).toContain("unsupported pi version");

    const noProvider = harness({});
    expect(await runPiLauncher([], noProvider.deps)).toBe(1);
  });

  it("passes persistence options only when asked", async () => {
    const { deps, recorded } = harness({ "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS });
    await runPiLauncher([], deps);
    expect(recorded.proxyOptions?.persistence).toBeUndefined();
    const persisted = harness({ "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS });
    await runPiLauncher(["--persist", "--persist-ttl-days", "14", "--persist-path", "/store.db"], persisted.deps);
    expect(persisted.recorded.proxyOptions?.persistence).toEqual({
      ttlDays: 14,
      path: "/store.db",
      keyFile: false,
    });
  });

  it("closes the proxy and removes the generated directory even when pi fails", async () => {
    const { deps, recorded } = harness(
      { "/home/test/.pi/agent/settings.json": ANTHROPIC_SETTINGS },
      { runChild: async () => 7 },
    );
    expect(await runPiLauncher([], deps)).toBe(7);
    expect(recorded.closed).toBe(true);
    expect(recorded.removed).toHaveLength(1);
  });
});

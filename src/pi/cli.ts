/** Real-process wiring for the pi adapter's CLI entry points. */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/loader.js";
import { defaultStorePath } from "../decision/mapping-key.js";
import type { GuardConfig } from "../types.js";
import { defaultPiExtensionPath } from "./doctor.js";
import { installPiExtension, runPiLauncher, type PiLauncherDeps } from "./launcher.js";
import { startPiProxy } from "./proxy.js";
import { defaultPiAgentDir } from "./settings.js";

function withEncodingDetection(config: GuardConfig): GuardConfig {
  return { ...config, settings: { ...config.settings, encoding_detection: true } };
}

function whichPi(): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, ["pi"], { encoding: "utf8", timeout: 4000 });
  if (result.error || result.status !== 0) return null;
  const first = (result.stdout || "").split(/\r?\n/).find((line) => line.trim().length > 0);
  return first?.trim() ?? null;
}

/** pi may print notices before the key; the key is the last non-empty line. */
function readAuthKey(bin: string, provider: string): string | null {
  const result = spawnSync(bin, ["auth", "print-api-key", "--provider", provider], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (result.error || result.status !== 0) return null;
  const lines = (result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const key = lines.at(-1);
  if (key === undefined || key.length < 8 || key.length > 8192 || /\s/.test(key)) return null;
  return key;
}

function runChild(bin: string, args: readonly string[], env: Record<string, string>, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { cwd, env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal);
    };
    const handlers: Array<[NodeJS.Signals, () => void]> = [
      ["SIGINT", forward("SIGINT")],
      ["SIGTERM", forward("SIGTERM")],
      ["SIGHUP", forward("SIGHUP")],
    ];
    for (const [signal, handler] of handlers) process.once(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    };
    child.once("error", () => {
      cleanup();
      resolve(1);
    });
    child.once("exit", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

export function createPiLauncherDeps(): PiLauncherDeps {
  const bin = whichPi();
  return {
    env: process.env,
    cwd: process.cwd(),
    home: os.homedir(),
    readFile(filePath) {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    writeFile(filePath, content, mode) {
      fs.writeFileSync(filePath, content, { mode });
    },
    mkdirp(dirPath, mode) {
      fs.mkdirSync(dirPath, { recursive: true, mode });
    },
    rmrf(target) {
      fs.rmSync(target, { recursive: true, force: true });
    },
    resolvePi: () => bin,
    piVersion(binPath) {
      const result = spawnSync(binPath, ["--version"], { encoding: "utf8", timeout: 8000 });
      if (result.error || result.status !== 0) return null;
      return (result.stdout || "").trim() || null;
    },
    piAuthKey: readAuthKey,
    runChild,
    startProxy: startPiProxy,
    loadGuardConfig(configPath, cwd) {
      return withEncodingDetection(loadConfig(configPath, cwd));
    },
    extensionPath: defaultPiExtensionPath,
    dataDir: () => path.dirname(defaultStorePath()),
    log: (line) => console.error(line),
    randomId: () => randomUUID(),
  };
}

const PI_USAGE = `leakshield pi — run the pi coding agent behind the LeakShield boundary

Usage:
  leakshield pi [--provider <id>] [--model <provider/id>] [-- pi args...]

Launcher options:
  --provider <id>        pi provider to protect (default: pi's defaultProvider)
  --model <pattern>      model passed to pi (supports provider/id and :thinking)
  --upstream <url>       override the provider API base (https, or loopback http)
  --api <api>            override the wire api: openai-completions,
                         openai-responses, or anthropic-messages
  --config <path>        guard.config.yaml to use instead of discovery
  --control-port <port>  loopback boundary port (default: an ephemeral port)
  --persist              keep encrypted mappings across restarts
  --persist-ttl-days <n> mapping TTL in days for --persist (default: 7)
  --persist-path <path>  mapping store path for --persist
  --persist-keyfile      allow the weaker keyfile fallback when no OS keychain

Everything after the launcher options is passed to pi, for example:
  leakshield pi --provider anthropic --continue
  leakshield pi --provider openai --model openai/gpt-6 -p "review this diff"

Plain \`pi\` is not protected. If the LeakShield extension is installed in
pi's settings, it refuses input until pi runs through this launcher.`;

export async function runPi(args: readonly string[]): Promise<number> {
  const separator = args.indexOf("--");
  const launcherArgs = separator === -1 ? args : args.slice(0, separator);
  if (launcherArgs.includes("--help") || launcherArgs.includes("-h")) {
    console.log(PI_USAGE);
    return 0;
  }
  return runPiLauncher(args, createPiLauncherDeps());
}

export function runPiInstall(args: readonly string[]): number {
  const deps = createPiLauncherDeps();
  const agentDir = deps.env.PI_CODING_AGENT_DIR ?? defaultPiAgentDir(deps.home);
  const result = installPiExtension(deps, agentDir);
  if (!result.ok) {
    console.error(`leakshield: ${result.reason}`);
    return 1;
  }
  if (result.changed) {
    console.error(`leakshield: added the pi extension to ${result.settingsPath}`);
  } else {
    console.error(`leakshield: the pi extension is already registered in ${result.settingsPath}`);
  }
  console.error("leakshield: start pi with `leakshield pi` so provider requests go through the boundary.");
  if (args.includes("--json")) console.log(JSON.stringify({ ok: true, changed: result.changed, settingsPath: result.settingsPath }));
  return 0;
}

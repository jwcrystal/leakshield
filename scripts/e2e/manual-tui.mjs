#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(e2eDir, "../..");
const outDir = path.join(e2eDir, "out", "manual-tui");
const distDir = path.join(repoRoot, "dist");
const injectorDir = path.join(e2eDir, "fixtures", "second-plugin");
const captureServerPath = path.join(e2eDir, "capture-server.mjs");
const order = process.argv[2];

if (order === "--help" || order === "-h") {
  console.log("Usage: node scripts/e2e/manual-tui.mjs <guard-first|injector-first>");
  console.log("Starts an isolated OpenCode TUI against a loopback capture provider.");
  console.log("Uses synthetic plugin-order canaries; never sends requests to an external provider.");
  process.exit(0);
}

if (order !== "guard-first" && order !== "injector-first") {
  console.error("Choose guard-first or injector-first.");
  process.exit(2);
}

if (!existsSync(path.join(distDir, "index.js"))) {
  console.error("Plugin build missing. Run npm run build first.");
  process.exit(2);
}

function openCodeBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const candidate = path.join(os.homedir(), ".opencode", "bin", "opencode");
  return existsSync(candidate) ? candidate : "opencode";
}

function isolatedEnvironment(profileDir, captureDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCODE_|OPENCHAMBER_)/i.test(key)) continue;
    if (/(API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    if (["NODE_OPTIONS", "NODE_PATH"].includes(key)) continue;
    env[key] = value;
  }
  env.CAPTURE_API_KEY = "sg-manual-capture";
  env.CAPTURE_DIR = captureDir;
  env.XDG_CONFIG_HOME = path.join(profileDir, "config");
  env.XDG_DATA_HOME = path.join(profileDir, "data");
  env.XDG_STATE_HOME = path.join(profileDir, "state");
  env.XDG_CACHE_HOME = path.join(profileDir, "cache");
  env.XDG_RUNTIME_DIR = path.join(profileDir, "runtime");
  return env;
}

function buildConfig(port) {
  const guard = { package: distDir, options: { mode: "redact" } };
  const injector = { package: injectorDir };
  return {
    $schema: "https://opencode.ai/config.json",
    model: "capture/capture-1",
    providers: {
      capture: {
        name: "Local Capture",
        env: ["CAPTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "sg-manual-capture",
        },
        models: { "capture-1": { name: "Local Capture" } },
      },
    },
    plugins: order === "guard-first" ? [guard, injector] : [injector, guard],
  };
}

function startCaptureServer(captureDir, env) {
  const server = spawn(process.execPath, [captureServerPath, "0"], {
    cwd: repoRoot,
    env: { ...env, CAPTURE_DIR: captureDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const portReady = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Capture server did not report readiness.")), 10000);
    server.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      output = `${output}${text}`.slice(-4000);
      const match = output.match(/CAPTURE_SERVER_READY port=(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Capture server exited before ready (${code ?? "signal"}).`));
    });
  });
  return { server, portReady };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function summarizeCaptures(captureDir) {
  const files = readdirSync(captureDir).filter((name) => name.endsWith(".json"));
  let secondPluginSeen = false;
  let rawInjectedCanarySeen = false;
  let redactionMarkerSeen = false;
  for (const file of files) {
    try {
      const envelope = JSON.parse(readFileSync(path.join(captureDir, file), "utf8"));
      const body = JSON.stringify(envelope.body);
      secondPluginSeen ||= body.includes("SECOND-PLUGIN-MARKER");
      rawInjectedCanarySeen ||= body.includes("carol.injector@example-test.invalid");
      redactionMarkerSeen ||= body.includes("[REDACTED_");
    } catch {}
  }
  console.log(`Capture requests: ${files.length}`);
  console.log(`Second-plugin marker reached provider: ${secondPluginSeen}`);
  console.log(`Synthetic canary reached provider: ${rawInjectedCanarySeen}`);
  console.log(`Redaction marker reached provider: ${redactionMarkerSeen}`);
  console.log(`Capture files: ${captureDir}`);
}

async function main() {
  const profileDir = path.join(outDir, `${order}-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const captureDir = path.join(profileDir, "captures");
  for (const directory of [
    captureDir,
    path.join(profileDir, "config", "opencode"),
    path.join(profileDir, "data"),
    path.join(profileDir, "state"),
    path.join(profileDir, "cache"),
    path.join(profileDir, "runtime"),
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const env = isolatedEnvironment(profileDir, captureDir);
  const { server, portReady } = startCaptureServer(captureDir, env);
  let tui;
  try {
    const port = await portReady;
    const configDir = path.join(profileDir, "config", "opencode");
    const configPath = path.join(configDir, "opencode.json");
    writeFileSync(configPath, JSON.stringify(buildConfig(port), null, 2), { mode: 0o600, flag: "wx" });
    console.log(`C4 plugin order: ${order}`);
    console.log(`Global config untouched; isolated profile: ${profileDir}`);
    console.log("Use only synthetic input (for example: Say hi.) and exit TUI to inspect local capture results.");
    tui = spawn(openCodeBinary(), [], { cwd: repoRoot, env, stdio: "inherit" });
    const [code] = await once(tui, "exit");
    console.log(`OpenCode exit: ${code ?? "signal"}`);
  } finally {
    await stopChild(tui);
    await stopChild(server);
  }
  await summarizeCaptures(captureDir);
}

main().catch((error) => {
  console.error(`manual-tui: ${error?.message ?? error}`);
  process.exitCode = 1;
});

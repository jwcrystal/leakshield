/** Live SG retest. Uses a private server; never rewrites global configuration.
 * Requires existing model credentials. Forks, rather than edits, source history.
 * Prints metadata only: no prompts, model text, auth, or raw error payloads.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const bin = process.env.OPENCODE_BIN ??
  "/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode";
const sourceSession = flag("--source-session");
const model = flag("--model");
const pluginConfig = flag("--plugin-config");
if (!sourceSession?.startsWith("ses_") || !model || !pluginConfig) {
  console.error("Usage: node scripts/diagnostics/retest-installed-plugin.mjs --plugin-config /path/to/opencode.json --source-session ses_... --model provider/model#variant");
  process.exit(2);
}

const configFile = resolve(homedir(), ".config/opencode/opencode.json");
const logFile = resolve(homedir(), ".local/share/opencode/log/opencode.log");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforeConfig = hash(readFileSync(configFile));
const beforeLog = readFileSync(logFile).length;
const options = {
  mode: "transparent",
  configPath: flag("--config") ?? resolve(homedir(), ".config/opencode/leakshield.yaml"),
  wireProtection: false,
  attachments: "block",
  persistence: { enabled: false },
};
const fixture = JSON.parse(readFileSync(pluginConfig, "utf8"));
const guardEntry = fixture.plugins?.find((entry) =>
  entry.package === resolve(root, "dist"));
if (!guardEntry || JSON.stringify(guardEntry.options) !== JSON.stringify(options)) {
  throw new Error("Explicit fixture does not contain the requested SG options.");
}
// Current hosts require server auth; share one random password between the
// private server and its CLI clients (same scheme as the lifecycle runner).
const password = randomBytes(24).toString("hex");
const env = { ...process.env, OPENCODE_CONFIG: resolve(pluginConfig),
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password };
const refusal = "LeakShield blocked a model request because it could not be masked safely.";
const marker = "SG_LIVE_RETEST_OK";
const prompt = `This is a bounded availability test, not a development task. Do not use tools, execute commands, change files, or continue earlier tasks. Reply with exactly ${marker} and nothing else.`;
const result = {
  startedAt: new Date().toISOString(),
  scope: "private-server-with-existing-config-and-credentials",
  productionCodeChanged: false,
  pluginConfig: resolve(pluginConfig),
  options,
  model,
  sourceSession,
  compiledGuardSha256: hash(readFileSync(resolve(root, "dist/adapters/opencode/transparent.js"))),
  cases: [],
};
let server;
let serverText = "";
let serverURL;

function command(commandArgs, timeout = 20_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(bin, commandArgs, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeout);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-4_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1_000_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exit, signal) => {
      clearTimeout(timer);
      resolveResult({ stdout, stderr, exit, signal, timedOut });
    });
  });
}

async function api(path) {
  const output = await command(["api", "get", path, "--server", serverURL]);
  if (output.exit !== 0 || output.timedOut) throw new Error("Private API request failed.");
  return JSON.parse(output.stdout);
}

async function test(name, fork) {
  const commandArgs = ["run", "--server", serverURL, "--model", model, "--format", "json",
    "--title", `LeakShield live retest: ${name}`];
  if (fork) commandArgs.push("--session", sourceSession, "--fork");
  commandArgs.push(prompt);
  const output = await command(commandArgs, 120_000);
  const events = output.stdout.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const text = events.filter((event) => event.type === "text")
    .map((event) => event.part?.text ?? event.data?.part?.text ?? event.text ?? "").join("");
  const errorEvents = events.filter((event) => event.type === "error").length;
  const toolEvents = events.filter((event) => event.type === "tool_use" || event.part?.type === "tool").length;
  const sessionIDs = [...new Set(events.map((event) => event.sessionID ?? event.part?.sessionID)
    .filter((id) => typeof id === "string" && id.startsWith("ses_")))];
  const raw = output.stdout + "\n" + output.stderr;
  const blocked = raw.includes(refusal);
  const passed = output.exit === 0 && !output.timedOut && !blocked && errorEvents === 0 &&
    toolEvents === 0 && text.trim() === marker;
  const row = { name, exit: output.exit, timedOut: output.timedOut, passed,
    exactMarker: text.trim() === marker, preparationRefusal: blocked, errorEvents, toolEvents, sessionIDs };
  result.cases.push(row);
  return passed;
}

try {
  server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  serverURL = await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("Private server readiness timed out.")), 25_000);
    const receive = (chunk) => {
      serverText = (serverText + chunk).slice(-1_000_000);
      const match = serverText.replace(/\x1b\[[0-9;]*m/g, "")
        .match(/(?:server listening on|listening[^\n]*?)\s*(http:\/\/127\.0\.0\.1:\d+)/i);
      if (match) { clearTimeout(timer); ready(match[1]); }
    };
    server.stdout.on("data", receive);
    server.stderr.on("data", receive);
    server.once("error", (error) => { clearTimeout(timer); reject(error); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error("Private server exited before readiness.")); });
  });
  const info = await api("/api/info");
  const identity = info.data ?? info;
  result.server = { pid: identity.pid, version: identity.version };
  if (identity.pid !== server.pid) throw new Error("Private server identity mismatch.");
  const pluginPath = "/api/plugin?location%5Bdirectory%5D=" + encodeURIComponent(root);
  let plugins;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await api(pluginPath);
    if (!Array.isArray(response.data)) throw new Error("Unexpected plugin list shape.");
    plugins = response.data;
    if (plugins.some((plugin) => plugin.id === "leakshield" && plugin.state?.status === "active")) break;
    await new Promise((done) => setTimeout(done, 250));
  }
  const guard = plugins.find((plugin) => plugin.id === "leakshield");
  result.plugin = { id: guard?.id, status: guard?.state?.status, totalPlugins: plugins.length };
  if (guard?.state?.status !== "active") throw new Error("SG was not active; no model test was run.");
  if (await test("short-new-session", false)) await test("source-history-fork", true);
  result.passed = result.cases.length === 2 && result.cases.every((row) => row.passed);
} catch (error) {
  result.passed = false;
  result.runnerErrorType = error instanceof Error ? error.name : "UnknownError";
  result.runnerFailureStage = !result.server ? "server-start" :
    result.plugin?.status !== "active" ? "plugin-admission" : "model-test";
  result.runnerPreparationRefusal = String(error).includes(refusal);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    await new Promise((done) => {
      const killTimer = setTimeout(() => { server.kill("SIGKILL"); }, 5_000);
      server.once("exit", () => { clearTimeout(killTimer); done(); });
      server.kill("SIGTERM");
    });
  }
  result.privateServerStopped = !server || server.exitCode !== null || server.signalCode !== null;
  result.globalConfigUnchanged = hash(readFileSync(configFile)) === beforeConfig;
  const appended = readFileSync(logFile).subarray(beforeLog).toString("utf8");
  result.newPreparationRefusals = appended.split("\n").filter((line) => line.includes(refusal)).length;
  result.wsDegradationObserved = serverText.includes("[leakshield] degraded:");
  result.compiledGuardUnchanged = hash(readFileSync(resolve(root, "dist/adapters/opencode/transparent.js"))) ===
    result.compiledGuardSha256;
  result.passed = Boolean(result.passed && result.privateServerStopped && result.globalConfigUnchanged &&
    result.compiledGuardUnchanged && result.newPreparationRefusals === 0);
  result.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}

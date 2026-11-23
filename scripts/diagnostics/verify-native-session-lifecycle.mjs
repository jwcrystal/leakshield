/** Isolated, credential-free host deletion test. Evidence contains booleans only. */
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const preferredTemp = path.join(tmpdir(), "opencode");
const parent = process.env.E2E_WORK_ROOT || (existsSync(preferredTemp) ? preferredTemp : tmpdir());
const directory = mkdtempSync(path.join(parent, "sg-native-lifecycle-"));
const resultPath = path.join(directory, "result.json");
const bin = process.env.OPENCODE_BIN || "opencode";
const password = randomBytes(24).toString("hex");
for (const name of ["home", "config/opencode", "data", "state", "cache"]) mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
writeFileSync(path.join(directory, "config/opencode/opencode.json"), JSON.stringify({
  update: "disable", snapshots: false,
  permissions: [{ action: "*", resource: "*", effect: "deny" }],
  plugins: [{ package: path.join(root, "scripts/diagnostics/session-lifecycle-plugin"), options: { resultPath } }],
}), { mode: 0o600 });
const env = {
  HOME: path.join(directory, "home"), USER: "isolated-test", LOGNAME: "isolated-test", SHELL: "/bin/sh", LANG: "en_US.UTF-8",
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`,
  TMPDIR: directory, PWD: directory,
  XDG_CONFIG_HOME: path.join(directory, "config"), XDG_DATA_HOME: path.join(directory, "data"),
  XDG_STATE_HOME: path.join(directory, "state"), XDG_CACHE_HOME: path.join(directory, "cache"),
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
};
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const compiledHash = hash(path.join(root, "dist/adapters/opencode/transparent.js"));
const server = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
let serverText = "";
let serverURL;
const command = (args) => new Promise((done, reject) => {
  const child = spawn(bin, args, { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-2000000); });
  child.stderr.on("data", () => {});
  child.once("error", reject);
  child.once("close", (exit) => {
    clearTimeout(timer);
    if (exit !== 0) return reject(new Error("api_failed"));
    try { done(JSON.parse(stdout)); } catch { reject(new Error("api_metadata_invalid")); }
  });
});
let summary = { passed: false, directory, compiledGuardSha256: compiledHash };
try {
  serverURL = await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error("server_start_timeout")), 20000);
    const receive = (chunk) => {
      serverText = (serverText + chunk).slice(-1000000);
      const match = serverText.replace(/\x1b\[[0-9;]*m/g, "").match(/(?:server listening on|listening[^\n]*?)\s*(http:\/\/127\.0\.0\.1:\d+)/i);
      if (match) { clearTimeout(timer); ready(match[1]); }
    };
    server.stdout.on("data", receive); server.stderr.on("data", receive);
    server.once("error", () => { clearTimeout(timer); reject(new Error("server_start_failed")); });
    server.once("exit", () => { clearTimeout(timer); reject(new Error("server_exited_before_readiness")); });
  });
  const api = (route) => command(["api", "--server", serverURL, "get", route]);
  const info = await api("/api/info");
  const identity = info.data ?? info;
  if (identity.pid !== server.pid) throw new Error("server_identity_mismatch");
  summary.server = { pid: identity.pid, version: identity.version };
  let plugin;
  for (let i = 0; i < 12; i++) {
    const response = await api("/api/plugin?location%5Bdirectory%5D=" + encodeURIComponent(directory));
    plugin = response.data.find((entry) => entry.id === "sg-native-lifecycle-verification");
    if (plugin?.state?.status === "active") break;
    await new Promise((done) => setTimeout(done, 250));
  }
  summary.pluginStatus = plugin?.state?.status;
  if (summary.pluginStatus !== "active") throw new Error("verification_plugin_inactive");
  for (let i = 0; i < 600 && !existsSync(resultPath); i++) await new Promise((done) => setTimeout(done, 100));
  if (!existsSync(resultPath)) throw new Error("verification_timeout");
  summary = { ...summary, ...JSON.parse(readFileSync(resultPath, "utf8")) };
} catch (error) {
  summary.failureCode = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "runner_error";
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    await new Promise((done) => {
      const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
      server.once("exit", () => { clearTimeout(timer); done(); });
      server.kill("SIGTERM");
    });
  }
  summary.privateServerStopped = server.exitCode !== null || server.signalCode !== null;
  summary.compiledGuardUnchanged = hash(path.join(root, "dist/adapters/opencode/transparent.js")) === compiledHash;
  summary.passed = summary.passed && summary.privateServerStopped && summary.compiledGuardUnchanged;
  writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
}
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;

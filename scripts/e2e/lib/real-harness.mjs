/**
 * Shared plumbing for the issue-#26 verification scripts.
 *
 * Everything here is harness code: isolated HOME/XDG, a private OpenCode
 * server, a content-free egress observer, and spawn helpers. It never reads,
 * copies or prints credentials; real-provider keys are only forwarded by name
 * from the caller's environment to the host under test.
 *
 * Verification tooling only — no product code lives here.
 */
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Built at runtime so this source file never carries a literal placeholder
// token: the guard under test treats an unmapped token in tool input as a
// refusal, and that includes editing the harness itself.
const PLACEHOLDER_PREFIX = "[SGP" + "2:";
const PLACEHOLDER_PATTERN = "\\[SGP" + "[12]:[A-Z0-9_]+-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]";

export const PROVIDERS = {
  anthropic: {
    package: "@opencode/ai/providers/anthropic",
    env: ["ANTHROPIC_API_KEY"],
    keyEnv: "ANTHROPIC_API_KEY",
    defaultModel: "claude-haiku-4-5-20251001",
    route: "messages",
  },
  openai: {
    package: "@opencode/ai/providers/openai",
    env: ["OPENAI_API_KEY"],
    keyEnv: "OPENAI_API_KEY",
    defaultModel: undefined, // model names change; require E2E_OPENAI_MODEL
    route: "responses",
  },
  capture: {
    package: "@opencode/ai/providers/openai-compatible",
    env: ["CAPTURE_API_KEY"],
    keyEnv: null,
    defaultModel: "capture-1",
    route: "chat",
  },
};

/** Model ref for a provider, honouring the per-provider override env vars. */
export function modelFor(provider, env = process.env) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unknown provider: ${provider}`);
  const override =
    provider === "anthropic" ? env.E2E_ANTHROPIC_MODEL : provider === "openai" ? env.E2E_OPENAI_MODEL : env.E2E_MODEL_ID;
  return override || spec.defaultModel;
}

/** Provider block for a project config. Real providers resolve their own key
 * from the named env var; the capture stand-in gets a synthetic key + baseURL. */
export function providerEntry({ provider, model, baseURL, apiKey }) {
  const spec = PROVIDERS[provider];
  const entry = {
    name: provider,
    package: spec.package,
    env: [...spec.env],
    models: { [model]: { name: model } },
  };
  if (baseURL !== undefined) entry.settings = { baseURL, ...(apiKey === undefined ? {} : { apiKey }) };
  return entry;
}

/** An isolated environment: no user config, data, state, cache or credentials
 * beyond the ones explicitly forwarded. */
export function isolatedEnv(root, extra = {}) {
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const state = path.join(root, "state");
  const cache = path.join(root, "cache");
  for (const dir of [home, config, data, state, cache]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = extra.OPENCODE_SERVER_PASSWORD ?? randomBytes(24).toString("hex");
  const forwarded = {};
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
  ]) {
    if (extra[name] !== undefined) forwarded[name] = extra[name];
    else if (process.env[name] !== undefined) forwarded[name] = process.env[name];
  }
  return {
    HOME: home,
    USER: "leakshield-verify",
    LOGNAME: "leakshield-verify",
    SHELL: "/bin/sh",
    LANG: "en_US.UTF-8",
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/bin:/bin"}`,
    TMPDIR: root,
    PWD: root,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    OPENCODE_SERVER_PASSWORD: token,
    OPENCODE_PASSWORD: token,
    ...forwarded,
    ...extra,
  };
}

/** A project that loads the built plugin plus a content-free egress observer. */
export function writeObservedProject({ dir, repo, pluginOptions, providers }) {
  mkdirSync(path.join(dir, ".opencode"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "AGENTS.md"), "Synthetic verification only. Do not read user files or run tools.\n", {
    mode: 0o600,
  });
  const tracePath = path.join(dir, "egress-flags.jsonl");
  writeFileSync(tracePath, "", { mode: 0o600 });
  const observerDir = path.join(dir, "egress-observer");
  mkdirSync(observerDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(observerDir, "package.json"),
    JSON.stringify({ name: "leakshield-egress-observer", version: "0.0.0", type: "module", main: "index.js" }),
    { mode: 0o600 },
  );
  writeFileSync(path.join(observerDir, "index.js"), egressObserverSource(tracePath), { mode: 0o600 });
  const guardConfigPath = path.join(dir, "guard.config.yaml");
  writeFileSync(
    guardConfigPath,
    "nda_keywords: []\nprivate_domains: []\ncustom_rules: []\nsettings:\n  env_files: []\n",
    { mode: 0o600 },
  );
  const plugins = [
    { package: path.join(repo, "dist"), options: { mode: "transparent", configPath: guardConfigPath, ...pluginOptions } },
    { package: observerDir },
  ];
  writeFileSync(
    path.join(dir, ".opencode", "opencode.json"),
    JSON.stringify(
      {
        update: "disable",
        snapshots: false,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
        providers,
        plugins,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { tracePath, guardConfigPath };
}

/**
 * Observer source. It runs in the host process, sees the outgoing request the
 * way the host built it, and records ONLY booleans/counts — never content.
 */
export function egressObserverSource(tracePath) {
  return `
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const PLACEHOLDER = ${JSON.stringify(PLACEHOLDER_PREFIX)};
const PLACEHOLDER_RE = new RegExp(${JSON.stringify(PLACEHOLDER_PATTERN)}, "g");
// Distinct placeholders, as short hashes: enough to answer "does this request
// still carry turn 0's value?" without keeping the token or the content.
const hashOf = (token) => createHash("sha256").update(token).digest("hex").slice(0, 12);
export default { id: "leakshield-egress-observer", async setup(ctx) {
  const registered = await ctx.session.hook("http.request", async (event) => {
    const body = await event.request.clone().text();
    const pathname = new URL(event.request.url).pathname;
    const route = pathname.endsWith("/chat/completions") ? "chat"
      : pathname.endsWith("/messages") ? "messages"
      : pathname.endsWith("/responses") ? "responses" : "unknown";
    const tokens = [...new Set(body.match(PLACEHOLDER_RE) || [])];
    appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({
      sessionID: event.sessionID, kind: event.kind, route,
      syntheticOriginalPresent: /(verify-[a-z0-9]+@example\\.test|AKIAIOSFODNN7EXAMPLE)/.test(body),
      placeholderPresent: body.includes(PLACEHOLDER),
      canaryCount: (body.match(PLACEHOLDER_RE) || []).length,
      placeholderHashes: tokens.map(hashOf),
      bytes: Buffer.byteLength(body),
    }) + "\\n", { mode: 0o600 });
  });
  return () => registered.dispose();
} };`;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export async function waitForHealth(port, pathname = "/health", timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: pathname, timeout: 2000 }, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}

/**
 * Starts the stand-in provider. `record: false` runs it content-free: the body
 * is parsed in memory to build a reply but never written, because the issue-#26
 * evidence comes from the in-process egress observer (flags and counts) instead
 * of captured bodies.
 */
export function startCaptureServer({ repo, env, port, captureDir, record = true }) {
  const childEnv = record ? { ...env, CAPTURE_DIR: captureDir } : { ...env, CAPTURE_RECORD: "0" };
  const child = spawn(process.execPath, [path.join(repo, "scripts/e2e/capture-server.mjs"), String(port)], {
    env: childEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.resume();
  return child;
}

/** Starts `opencode serve --port 0` and resolves its base URL once listening. */
export async function startPrivateServer({ bin, cwd, env, timeoutMs = 30000 }) {
  const child = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server_start_timeout")), timeoutMs);
      const receive = (chunk) => {
        text = (text + chunk).slice(-200000);
        const match = text
          .replace(/\x1b\[[0-9;]*m/g, "")
          .match(/(?:server listening on|listening[^\n]*?)\s*(http:\/\/127\.0\.0\.1:\d+)/i);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      };
      child.stdout.on("data", receive);
      child.stderr.on("data", receive);
      child.once("error", () => {
        clearTimeout(timer);
        reject(new Error("server_start_failed"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("server_exited_before_ready"));
      });
    });
    return { child, url };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

export async function stopChild(child) {
  if (child === null || child === undefined) return true;
  if (child.exitCode !== null || child.signalCode !== null) return true;
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    child.kill("SIGTERM");
  });
  return child.exitCode !== null || child.signalCode !== null;
}

/** One host API call through `opencode api`. Content is never logged. */
export function runApi({ bin, serverURL, method, endpoint, data, cwd, env, timeoutMs = 120000 }) {
  const args = ["api"];
  if (serverURL) args.push("--server", serverURL);
  args.push(method, endpoint);
  if (data !== undefined) args.push("--data", JSON.stringify(data));
  const started = Date.now();
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  let value;
  let parseFailed = false;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    parseFailed = true;
  }
  return {
    status: result.status,
    value,
    parseFailed,
    timedOut: result.error?.code === "ETIMEDOUT",
    durationMs: Date.now() - started,
  };
}

/** One continued turn through the CLI, so the host replays session history. */
export function runCliTurn({ bin, serverURL, cwd, env, sessionID, modelRef, prompt, timeoutMs = 180000 }) {
  const args = ["run", "--server", serverURL, "--session", sessionID, "--model", modelRef, "--format", "json", "--auto"];
  args.push(prompt);
  const started = Date.now();
  const result = spawnSync(bin, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 40 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderrLength: (result.stderr ?? "").length,
    timedOut: result.error?.code === "ETIMEDOUT",
    durationMs: Date.now() - started,
  };
}

/**
 * True only when the host reports THIS session as absent. OpenCode answers
 * `GET /api/session/<id>` with `{ _tag: "SessionNotFoundError", sessionID }`; a
 * 404 from a wrong route, a proxy error page or "configuration file not found"
 * must never read as reclamation.
 */
export function sessionNotFound(result, sessionID) {
  if (typeof sessionID !== "string" || sessionID.length === 0) return false;
  if (result == null || result.timedOut === true || result.parseFailed === true) return false;
  const body = result.value?.data ?? result.value;
  if (body === null || typeof body !== "object") return false;
  const error = body.error !== null && typeof body.error === "object" ? body.error : body;
  if (error._tag !== "SessionNotFoundError") return false;
  // Exact identity, no message fallback: a prefix or a differently-named
  // session in the message must not stand in for this one being gone.
  return typeof error.sessionID === "string" && error.sessionID === sessionID;
}

/**
 * Request kinds that carry a user turn. `primary` is a CLI turn that replays
 * the session; `generate` is the one-shot API endpoint. Auxiliary requests
 * (titles, summaries) are excluded so they can neither prove nor hide replay.
 */
export const TURN_REQUEST_KINDS = ["primary", "generate"];

/**
 * Placeholders a turn's requests no longer carry, given the ones earlier turns
 * introduced. Distinct hashes, not occurrences: an assistant echo repeats an
 * existing placeholder and must not stand in for a lost one.
 */
export function missingPlaceholders(expected, actual) {
  const have = new Set(actual);
  return expected.filter((hash) => !have.has(hash));
}

/** Placeholders this request carries that no earlier turn introduced. */
export function newPlaceholders(known, actual) {
  const seen = new Set(known);
  return actual.filter((hash) => !seen.has(hash));
}

/**
 * Replay verdict for one turn, over its trace rows. Every request that carries
 * a user turn must still hold every placeholder earlier turns introduced; a
 * complete attempt cannot vouch for a deficient retry in the same turn. The
 * final turn asks only for a replay, so it must introduce nothing new.
 */
export function turnCoverage({ known = [], rows = [], finalTurn = false }) {
  const turnRows = rows.filter((row) => TURN_REQUEST_KINDS.includes(row.kind));
  const missing = turnRows.reduce(
    (max, row) => Math.max(max, missingPlaceholders(known, row.placeholderHashes ?? []).length),
    0,
  );
  const present = [...new Set(turnRows.flatMap((row) => row.placeholderHashes ?? []))];
  const introduced = newPlaceholders(known, present);
  return {
    covered: turnRows.length > 0 && missing === 0 && (finalTurn ? introduced.length === 0 : introduced.length >= 1),
    requests: turnRows.length,
    missing,
    introduced: introduced.length,
    present,
    maxBytes: turnRows.reduce((max, row) => Math.max(max, row.bytes ?? 0), 0),
  };
}

/** Resident set size of a process in KiB, or null when unavailable. */
export function sampleRssKb(pid) {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const value = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/** Waits until the leakshield plugin reports active for this location. */
export async function waitForPluginActive({ bin, serverURL, cwd, env, timeoutMs = 20000 }) {
  const deadline = Date.now() + timeoutMs;
  const route = `/api/plugin?location[directory]=${encodeURIComponent(cwd)}`;
  let lastStatus;
  while (Date.now() < deadline) {
    const response = runApi({ bin, serverURL, method: "get", endpoint: route, cwd, env, timeoutMs: 15000 });
    const entries = Array.isArray(response.value?.data) ? response.value.data : [];
    const plugin = entries.find((entry) => JSON.stringify(entry).includes("leakshield"));
    lastStatus = plugin?.state?.status;
    if (lastStatus === "active") return { active: true, status: lastStatus };
    await new Promise((done) => setTimeout(done, 250));
  }
  return { active: false, status: lastStatus };
}

export function requireGate(name, hint) {
  if (process.env[name] === "1") return;
  console.error(`Refusing to run: set ${name}=1 ${hint}`);
  process.exit(2);
}

export function readTrace(tracePath) {
  let text;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

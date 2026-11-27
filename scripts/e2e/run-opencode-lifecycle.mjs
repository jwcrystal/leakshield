#!/usr/bin/env node
/**
 * Lifecycle evidence for the LeakShield OpenCode plugin on real OpenCode 2.4.1.
 *
 * Four readiness rows, each driven through a loopback OpenAI-compatible stub
 * and an isolated OpenCode host:
 *
 *   compaction   default automatic compaction: the summarizer request and the
 *                following model request must carry placeholders, never a canary
 *   retry        a retryable 503 on the first attempt; OpenCode retries and both
 *                attempts are captured masked
 *   fresh-session a token minted in one session is not restored in a new
 *                session (default persistence off), with a same-session
 *                restoration control, a per-fresh-session own-token control,
 *                a persistence-on pair plus a cross-process store control
 *   same-host    two sessions inside one long-lived `opencode serve` process
 *                (persistence off): the second session must not restore the
 *                first session's token (rules out a process-global map)
 *
 * Every provider request body is written under `<out>/requests/`. The final
 * JSON summary never contains a canary value.
 *
 * Usage: node scripts/e2e/run-opencode-lifecycle.mjs --out <dir>
 *        [--only compaction,retry,fresh-session]
 * Requires `npm run build`; OPENCODE_BIN overrides the pinned binary.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSPARENT_TOKEN } from "./transparent-token.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(E2E_DIR, "..", "..");
const DIST_DIR = join(REPO, "dist");
const EXPECTED_VERSION = "2.4.1";
const DEFAULT_BIN = "/Users/jared/.local/share/mise/installs/node/24.22.3/bin/opencode";
const ALL_CASES = ["compaction", "retry", "fresh-session", "same-host"];
const RUN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240000);
const HOME_AT_START = homedir();
const REAL_TMP = realpathSync(tmpdir());
const REAL_HOME = realpathSync(HOME_AT_START);
const REAL_REPO = realpathSync(REPO);
const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const realpathAllowingMissing = (target) => {
  const missing = [];
  let current = resolve(target);
  while (!existsSync(current)) {
    missing.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...missing);
};

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
};
const onlyFlagPresent = process.argv.some(
  (arg) => arg === "--only" || arg.startsWith("--only="),
);
const onlyOption =
  option("--only") ?? process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
if (onlyFlagPresent && typeof onlyOption !== "string") {
  console.error("--only requires a comma-separated list of case names");
  process.exit(2);
}
const outArg = option("--out");
if (!outArg) {
  console.error(
    "usage: node scripts/e2e/run-opencode-lifecycle.mjs --out <dir> [--only compaction,retry,fresh-session,same-host]",
  );
  process.exit(2);
}
const OUT = resolve(outArg);
if (OUT.includes(delimiter)) {
  console.error(`--out must not contain "${delimiter}": the keychain stub directory is prepended to PATH`);
  process.exit(2);
}
const REAL_OUT = realpathAllowingMissing(OUT);
if (REAL_OUT === REAL_TMP || !isInside(REAL_TMP, REAL_OUT) || isInside(REAL_REPO, REAL_OUT)) {
  console.error(
    `--out must be a directory under os.tmpdir() (${REAL_TMP}), outside the repository (${REAL_REPO}) and the real home (${REAL_HOME}); got ${REAL_OUT}`,
  );
  process.exit(2);
}
mkdirSync(REAL_OUT, { recursive: true });
const selected = typeof onlyOption === "string"
  ? onlyOption.split(",").map((name) => name.trim()).filter(Boolean)
  : ALL_CASES;
if (onlyFlagPresent && selected.length === 0) {
  console.error("--only selected no cases");
  process.exit(2);
}
const unknown = selected.filter((name) => !ALL_CASES.includes(name));
if (unknown.length > 0) {
  console.error(`unknown case(s): ${unknown.join(", ")}`);
  process.exit(2);
}
if (!existsSync(join(DIST_DIR, "index.js"))) {
  console.error(`missing ${join(DIST_DIR, "index.js")}; run npm run build first`);
  process.exit(2);
}

const BIN = process.env.OPENCODE_BIN || (existsSync(DEFAULT_BIN) ? DEFAULT_BIN : "opencode");
// Even `--version` initialises OpenCode's data and log directories, so the
// probe gets the same HOME/XDG isolation as the cases.
const versionProbeDir = join(OUT, "version-probe");
mkdirSync(versionProbeDir, { recursive: true });
const versionEnv = {};
for (const [key, value] of Object.entries(process.env))
  if (!/^(OPENCODE_|OPENCHAMBER_|LEAKSHIELD_|CAPTURE_|CLAUDE_)/.test(key)) versionEnv[key] = value;
Object.assign(versionEnv, {
  HOME: join(versionProbeDir, "home"),
  XDG_CONFIG_HOME: join(versionProbeDir, "config"),
  XDG_DATA_HOME: join(versionProbeDir, "data"),
  XDG_STATE_HOME: join(versionProbeDir, "state"),
  XDG_CACHE_HOME: join(versionProbeDir, "cache"),
  OPENCODE_CONFIG_DIR: join(versionProbeDir, "config", "opencode"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
});
const version = execFileSync(BIN, ["--version"], {
  encoding: "utf8",
  cwd: versionProbeDir,
  env: versionEnv,
}).trim();
if (version !== `opencode v${EXPECTED_VERSION}` && version !== EXPECTED_VERSION) {
  console.error(`This harness is pinned to OpenCode ${EXPECTED_VERSION}, received ${version}`);
  process.exit(2);
}
let gitHead = "unknown";
try {
  gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim();
} catch {}

const REQUESTS_DIR = join(OUT, "requests");
const WORK_ROOT = join(OUT, "work");
const LOGS_DIR = join(OUT, "logs");
rmSync(REQUESTS_DIR, { recursive: true, force: true });
rmSync(WORK_ROOT, { recursive: true, force: true });
rmSync(LOGS_DIR, { recursive: true, force: true });
mkdirSync(REQUESTS_DIR, { recursive: true });
mkdirSync(WORK_ROOT, { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });

const TOKEN_G = new RegExp(TRANSPARENT_TOKEN.source, "g");
const canaries = {
  compaction: "alice.compaction" + "@" + "example-test.invalid",
  retry: "bob.retry" + "@" + "example-test.invalid",
  freshMint: "carol.fresh" + "@" + "example-test.invalid",
  freshOwn: "dave.fresh" + "@" + "example-test.invalid",
  persistMint: "erin.persist" + "@" + "example-test.invalid",
  sameHostMint: "frank.samehost" + "@" + "example-test.invalid",
  sameHostOwn: "grace.samehost" + "@" + "example-test.invalid",
};
const ALL_CANARIES = Object.values(canaries);

const SUMMARY_HEADINGS = [
  "## Objective",
  "## Requirements",
  "## Decisions",
  "## Work State",
  "### Completed",
  "### Active",
  "### Blocked",
  "## Next Move",
  "## Relevant Files",
  "## Important Context",
];
const TITLE_MARK = "You name conversations so the user can find them later";
const SUMMARIZER_MARKS = [
  "You MUST summarize the conversation above",
  "Update the existing checkpoint in the conversation above",
  "did not fill in the required summary template",
];

const checks = [];
const recordCheck = (label, ok, detail = "") => {
  checks.push({ label, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? `: ${detail}` : ""}`);
  return !!ok;
};

function installKeychainStubs(binDir) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(KEYCHAIN_LOG, "");
  for (const name of ["security", "secret-tool"]) {
    const file = join(binDir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$LS_KEYCHAIN_STUB_LOG"\nexit 1\n`,
    );
    chmodSync(file, 0o755);
  }
}
const KEYCHAIN_DIR = join(OUT, "keychain-stub");
const KEYCHAIN_LOG = join(OUT, "keychain-stub.log");
installKeychainStubs(KEYCHAIN_DIR);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const countOccurrences = (text, needle) => text.split(needle).length - 1;
const countCanaries = (raw) =>
  ALL_CANARIES.reduce((total, value) => total + countOccurrences(raw, value), 0);
const countPlaceholders = (raw) => (raw.match(TOKEN_G) ?? []).length;
const firstPlaceholder = (raw) => raw.match(TOKEN_G)?.[0] ?? null;

function classify(raw) {
  if (raw.includes(TITLE_MARK)) return "title";
  if (SUMMARIZER_MARKS.some((mark) => raw.includes(mark))) return "summarizer";
  return "model";
}

function summarizerText(token) {
  const line = token ? `- retain ${token}` : "- (none)";
  return SUMMARY_HEADINGS.map((heading) => `${heading}\n${line}`).join("\n");
}

let requestIndex = 0;
function createStub(caseName, behaviour) {
  const state = {
    phase: "mint",
    modelSteps: 0,
    mintedToken: null,
    oldToken: null,
    ownToken: null,
  };
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "capture-1", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":{"message":"not found"}}');
      return;
    }
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsed: true, raw: raw.slice(0, 50000) };
    }
    const kind = classify(raw);
    const index = ++requestIndex;
    const entry = {
      case: caseName,
      index,
      kind,
      canaryCount: countCanaries(raw),
      placeholderCount: countPlaceholders(raw),
    };
    const file = join(REQUESTS_DIR, `${String(index).padStart(3, "0")}-${caseName}.json`);
    writeFileSync(file, JSON.stringify({ ...entry, file: `requests/${String(index).padStart(3, "0")}-${caseName}.json`, body }, null, 2));
    const recorded = { ...entry, raw, body, file };
    requests.push(recorded);

    const action = await behaviour({ kind, raw, body, state, entry });
    if (action.status && action.status !== 200) {
      response.writeHead(action.status, { "content-type": "application/json" });
      response.end(JSON.stringify(action.payload ?? { error: { message: "stub error" } }));
      return;
    }
    if (body?.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const base = {
        id: `chatcmpl-lifecycle-${index}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "capture-1",
      };
      const chunk = (delta, finishReason = null) => {
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
        );
      };
      chunk({ role: "assistant", content: null });
      if (action.toolCall) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call-${index}`,
              type: "function",
              function: { name: action.toolCall.name, arguments: JSON.stringify(action.toolCall.args) },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        chunk({ content: action.text ?? "" });
        chunk({}, "stop");
      }
      if (body.stream_options?.include_usage) {
        const usage = action.usage ?? { prompt_tokens: 100, completion_tokens: 10 };
        response.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.prompt_tokens + usage.completion_tokens,
            },
          })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: `chatcmpl-lifecycle-${index}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "capture-1",
        choices: [
          {
            index: 0,
            message: action.toolCall
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `call-${index}`,
                      type: "function",
                      function: { name: action.toolCall.name, arguments: JSON.stringify(action.toolCall.args) },
                    },
                  ],
                }
              : { role: "assistant", content: action.text ?? "" },
            finish_reason: action.toolCall ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    );
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () =>
      done({
        server,
        state,
        requests,
        port: server.address().port,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      }),
    );
  });
}

const behaviours = {
  compaction({ kind, raw, state }) {
    if (kind === "summarizer") {
      return {
        text: summarizerText(firstPlaceholder(raw)),
        usage: { prompt_tokens: 6000, completion_tokens: 200 },
      };
    }
    if (kind === "model") {
      state.modelSteps += 1;
      if (state.modelSteps === 1) {
        return {
          toolCall: { name: "read", args: { path: "notes.txt" } },
          usage: { prompt_tokens: 190000, completion_tokens: 20 },
        };
      }
      return { text: "compaction follow-up ok" };
    }
    return { text: "Lifecycle title" };
  },
  retry({ kind, state }) {
    if (kind === "model") {
      state.modelSteps += 1;
      if (state.modelSteps === 1) {
        return {
          status: 503,
          payload: { error: { message: "overloaded", type: "server_error" } },
        };
      }
      return { text: "retry follow-up ok" };
    }
    return { text: "Lifecycle title" };
  },
  "fresh-session"({ kind, raw, state }) {
    if (kind !== "model") return { text: "Lifecycle title" };
    state.modelSteps += 1;
    if (state.phase === "mint" || state.phase === "persist-mint") {
      if (state.modelSteps === 1) {
        const token = firstPlaceholder(raw);
        state.mintedToken = token;
        return {
          toolCall: { name: "read", args: { path: `fixtures/${token ?? "missing-token"}` } },
          usage: { prompt_tokens: 1200, completion_tokens: 20 },
        };
      }
      return { text: "mint follow-up ok" };
    }
    if (state.phase === "persist-continue") {
      if (state.modelSteps === 1) {
        const token = state.oldToken ?? firstPlaceholder(raw);
        return {
          toolCall: { name: "read", args: { path: `fixtures/${token ?? "missing-token"}` } },
          usage: { prompt_tokens: 1200, completion_tokens: 20 },
        };
      }
      return { text: "persist continue follow-up ok" };
    }
    if (state.modelSteps === 1) {
      return {
        toolCall: {
          name: "read",
          args: { path: `fixtures/${state.oldToken ?? "unknown-old-token"}` },
        },
        usage: { prompt_tokens: 1200, completion_tokens: 20 },
      };
    }
    if (state.modelSteps === 2) {
      const token = firstPlaceholder(raw);
      state.ownToken = token;
      return {
        toolCall: { name: "read", args: { path: `fixtures/${token ?? "missing-token"}` } },
        usage: { prompt_tokens: 1400, completion_tokens: 20 },
      };
    }
    return { text: "fresh follow-up ok" };
  },
};
behaviours["same-host"] = behaviours["fresh-session"];

function buildConfig(port, { persistence } = {}) {
  const pluginOptions = { mode: "transparent" };
  if (persistence) pluginOptions.persistence = persistence;
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      capture: {
        name: "Capture",
        env: ["CAPTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "sg-e2e-capture",
        },
        models: {
          "capture-1": {
            name: "Capture 1",
            limit: { context: 200000, output: 32000 },
          },
        },
      },
    },
    plugins: [{ package: DIST_DIR, options: pluginOptions }],
  };
}

function prepareCaseDir(name) {
  const dir = join(WORK_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ["data", "state", "cache", "config/opencode", "home", "fixtures"]) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function opencodeEnv(workdir, extraEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCODE_|OPENCHAMBER_|LEAKSHIELD_|CAPTURE_|CLAUDE_)/.test(key)) continue;
    env[key] = value;
  }
  env.CAPTURE_API_KEY = "sg-e2e-capture";
  env.PWD = workdir;
  env.HOME = join(workdir, "home");
  env.XDG_CONFIG_HOME = join(workdir, "config");
  env.XDG_DATA_HOME = join(workdir, "data");
  env.XDG_STATE_HOME = join(workdir, "state");
  env.XDG_CACHE_HOME = join(workdir, "cache");
  // 2.4.1 merges opencode.json(c) and .opencode/opencode.json(c) from cwd and
  // every ancestor through the filesystem root; HOME/XDG alone does not stop
  // that. Pin the global config directory and disable project discovery.
  env.OPENCODE_CONFIG_DIR = join(workdir, "config", "opencode");
  env.OPENCODE_CONFIG_PROJECT_DISABLE = "1";
  env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "1";
  env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
  env.LS_KEYCHAIN_STUB_LOG = KEYCHAIN_LOG;
  env.PATH = `${KEYCHAIN_DIR}${delimiter}${dirname(resolve(BIN))}${delimiter}${env.PATH ?? ""}`;
  return { ...env, ...extraEnv };
}

function opencodeArgs({ prompt, sessionID, server }) {
  const args = ["run"];
  if (server) args.push("--server", server);
  else args.push("--standalone");
  args.push("--format", "json", "--model", "capture/capture-1");
  if (sessionID) args.push("--session", sessionID);
  args.push(prompt);
  return args;
}

function runOpencode({ workdir, prompt, sessionID, server, extraEnv }) {
  const env = opencodeEnv(workdir, extraEnv);
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(BIN, opencodeArgs({ prompt, sessionID, server }), {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      done({ exitCode, timedOut, stdout, stderr });
    });
  });
}

function inspectEffectiveConfig(workdir) {
  const workdirReal = realpathSync(workdir);
  const expectedPath = realpathSync(join(workdir, "config", "opencode", "opencode.json"));
  let sources;
  try {
    const stdout = execFileSync(BIN, ["debug", "config", "--standalone"], {
      cwd: workdir,
      env: opencodeEnv(workdir),
      encoding: "utf8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    sources = JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      error: `debug config failed: ${String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500)}`,
      expectedPath,
    };
  }
  if (!Array.isArray(sources)) {
    return { ok: false, error: "debug config did not return an array", expectedPath };
  }
  const documents = sources.filter((source) => source?.type === "document");
  const pluginPackages = documents
    .flatMap((doc) => (Array.isArray(doc.info?.plugins) ? doc.info.plugins : []))
    .map((plugin) => (typeof plugin === "string" ? plugin : plugin?.package))
    .filter((value) => typeof value === "string");
  const providers = documents.flatMap((doc) => Object.keys(doc.info?.providers ?? {}));
  const sourcePaths = sources.map((source) => source?.path).filter((value) => typeof value === "string");
  const pathsInside = sourcePaths.every((path) => {
    try {
      return isInside(workdirReal, realpathSync(path));
    } catch {
      return false;
    }
  });
  let documentPath = null;
  try {
    documentPath = documents.length === 1 ? realpathSync(documents[0].path) : null;
  } catch {}
  const pluginsExact =
    pluginPackages.length === 1 &&
    (() => {
      try {
        return realpathSync(pluginPackages[0]) === realpathSync(DIST_DIR);
      } catch {
        return false;
      }
    })();
  const providersExact = providers.length === 1 && providers[0] === "capture";
  const ok =
    documents.length === 1 &&
    documentPath === expectedPath &&
    pluginsExact &&
    providersExact &&
    pathsInside;
  return {
    ok,
    documents: documents.length,
    documentPath,
    pluginPackages,
    pluginsExact,
    providers,
    providersExact,
    sourcePaths,
    pathsInside,
    expectedPath,
  };
}

function checkConfigIsolation(caseName, workdir, label = "") {
  const info = inspectEffectiveConfig(workdir);
  const suffix = label ? ` (${label})` : "";
  recordCheck(
    `${caseName}: effective config is only the harness's${suffix}`,
    info.ok,
    info.error ??
      `documents=${info.documents} plugins=${JSON.stringify(info.pluginPackages)} providers=${JSON.stringify(info.providers)} pathsInside=${info.pathsInside}`,
  );
  return info;
}

function waitFor(predicate, timeoutMs, intervalMs = 100) {
  return new Promise((done) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return done(true);
      if (Date.now() >= deadline) return done(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function freePort() {
  return new Promise((done) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

function readToolEvents(stdout) {
  return parseEvents(stdout)
    .filter((event) => event?.type === "tool_use" && event.part?.tool === "read")
    .map((event) => ({
      status: event.part?.state?.status ?? null,
      inputPath: event.part?.state?.input?.path ?? null,
      output: typeof event.part?.state?.output === "string" ? event.part.state.output : "",
    }));
}

function sessionIDs(stdout) {
  return [
    ...new Set(
      parseEvents(stdout)
        .map((event) => event?.sessionID)
        .filter((id) => typeof id === "string" && id.length > 0),
    ),
  ];
}

function readSucceeded(stdout, expectedPath) {
  return readToolEvents(stdout).some(
    (event) =>
      event.status === "completed" &&
      event.output.startsWith(`Read file ${expectedPath}, lines `),
  );
}

function saveRun(caseName, label, run) {
  const base = join(LOGS_DIR, `${caseName}.${label}`);
  writeFileSync(`${base}.stdout.txt`, run.stdout);
  writeFileSync(`${base}.stderr.txt`, run.stderr);
}

function caseCounts(requests) {
  return {
    requests: requests.length,
    canaryOccurrences: requests.reduce((total, request) => total + request.canaryCount, 0),
    placeholderOccurrences: requests.reduce((total, request) => total + request.placeholderCount, 0),
    modelRequests: requests.filter((request) => request.kind === "model").length,
    summarizerRequests: requests.filter((request) => request.kind === "summarizer").length,
    titleRequests: requests.filter((request) => request.kind === "title").length,
  };
}

function fixturePath(workdir, canary) {
  const file = join(workdir, "fixtures", canary);
  writeFileSync(file, `Synthetic lifecycle fixture for ${canary}\n`);
  return `fixtures/${canary}`;
}

function writeConfig(workdir, port, options) {
  writeFileSync(
    join(workdir, "config", "opencode", "opencode.json"),
    `${JSON.stringify(buildConfig(port, options), null, 2)}\n`,
  );
}

function commonChecks(caseName, requests) {
  recordCheck(`${caseName}: provider requests recorded`, requests.length > 0, `count=${requests.length}`);
  const leaked = requests.filter((request) => request.canaryCount > 0);
  recordCheck(
    `${caseName}: no request carries a canary`,
    leaked.length === 0,
    leaked.length > 0
      ? `${leaked.length} request(s) leaked, first index ${leaked[0].index}`
      : "",
  );
  const placeholders = requests.reduce((total, request) => total + request.placeholderCount, 0);
  recordCheck(`${caseName}: requests carry placeholders`, placeholders > 0, `count=${placeholders}`);
  return { leaked, placeholders };
}

const caseResults = [];

async function runCompaction() {
  const name = "compaction";
  const workdir = prepareCaseDir(name);
  writeFileSync(join(workdir, "notes.txt"), `Rotation contact: ${canaries.compaction}\n`);
  const stub = await createStub(name, behaviours[name]);
  writeConfig(workdir, stub.port);
  const configIsolation = checkConfigIsolation(name, workdir);
  const run = await runOpencode({
    workdir,
    prompt: `Contact ${canaries.compaction} about the rotation. Read notes.txt and confirm.`,
  });
  await sleep(300);
  await stub.close();
  saveRun(name, "run1", run);

  const requests = stub.requests;
  const common = commonChecks(name, requests);
  const summarizer = requests.find((request) => request.kind === "summarizer");
  const followingModel = summarizer
    ? requests.find((request) => request.index > summarizer.index && request.kind === "model")
    : undefined;
  const followingModelHasCheckpoint = followingModel
    ? JSON.stringify(followingModel.body).includes("<conversation-checkpoint>")
    : false;
  let verdict = "fail";
  let reason = "no canary in any request, but automatic compaction did not run";
  let evidence = {};
  if (common.leaked.length > 0) {
    reason = "canary reached the provider";
  } else if (!summarizer) {
    verdict = "unverified";
    reason = "automatic compaction did not produce a summarizer request";
  } else if (!followingModel) {
    verdict = "unverified";
    reason = "no model request followed the summarizer request";
  } else if (summarizer.placeholderCount === 0 || followingModel.placeholderCount === 0) {
    reason = "summarizer or following model request carried no placeholder";
  } else if (!followingModelHasCheckpoint) {
    verdict = "unverified";
    reason = "following model request did not carry the compaction checkpoint";
  } else {
    verdict = "pass";
    reason = "automatic compaction ran; summarizer and following model request are canary-free with placeholders";
  }
  evidence = {
    summarizerIndex: summarizer?.index ?? null,
    followingModelIndex: followingModel?.index ?? null,
    summarizerCanaries: summarizer?.canaryCount ?? null,
    summarizerPlaceholders: summarizer?.placeholderCount ?? null,
    followingModelCanaries: followingModel?.canaryCount ?? null,
    followingModelPlaceholders: followingModel?.placeholderCount ?? null,
    followingModelHasCheckpoint,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    configIsolation,
  };
  recordCheck(`${name}: run exited cleanly`, run.exitCode === 0 && !run.timedOut, `exit=${run.exitCode}`);
  recordCheck(`${name}: summarizer request found`, !!summarizer);
  recordCheck(`${name}: model request after summarizer found`, !!followingModel);
  recordCheck(
    `${name}: summarizer and following model both masked`,
    !!summarizer &&
      !!followingModel &&
      summarizer.canaryCount === 0 &&
      followingModel.canaryCount === 0 &&
      summarizer.placeholderCount > 0 &&
      followingModel.placeholderCount > 0,
  );
  recordCheck(`${name}: following model request carries the checkpoint`, followingModelHasCheckpoint);
  if (run.exitCode !== 0 && common.leaked.length === 0 && verdict === "pass") {
    verdict = "unverified";
    reason = `compaction requests masked, but opencode exited ${run.exitCode}`;
  }
  caseResults.push({
    case: name,
    verdict,
    reason,
    requests: requests.length,
    counts: caseCounts(requests),
    evidence,
  });
}

async function runRetry() {
  const name = "retry";
  const workdir = prepareCaseDir(name);
  const stub = await createStub(name, behaviours[name]);
  writeConfig(workdir, stub.port);
  const configIsolation = checkConfigIsolation(name, workdir);
  const run = await runOpencode({
    workdir,
    prompt: `Contact ${canaries.retry} about the rotation.`,
  });
  await sleep(300);
  await stub.close();
  saveRun(name, "run1", run);

  const requests = stub.requests;
  const common = commonChecks(name, requests);
  const modelRequests = requests.filter((request) => request.kind === "model");
  const events = parseEvents(run.stdout);
  const retryEvents = events.filter((event) => event?.type === "retry");
  const allAttemptsMasked =
    modelRequests.length >= 2 &&
    modelRequests.every((request) => request.canaryCount === 0 && request.placeholderCount > 0);
  const attemptBodies = modelRequests.map((request) => JSON.stringify(request.body));
  const attemptBodiesIdentical =
    attemptBodies.length >= 2 && attemptBodies.every((body) => body === attemptBodies[0]);
  let verdict = "fail";
  let reason = "the provider error was not retried";
  if (common.leaked.length > 0) {
    reason = "canary reached the provider";
  } else if (modelRequests.length < 2) {
    reason = "opencode did not resend the request; 2.4.1 retries provider-internal 503s at the session layer";
  } else if (!allAttemptsMasked) {
    reason = "an attempt was not masked";
  } else if (retryEvents.length === 0) {
    verdict = "unverified";
    reason = "two attempts were recorded but no opencode session retry event was observed; resend may be SDK-level";
  } else {
    verdict = "pass";
    reason = "opencode retried the provider error at the session layer; every attempt was masked";
  }
  recordCheck(`${name}: run exited cleanly`, run.exitCode === 0 && !run.timedOut, `exit=${run.exitCode}`);
  recordCheck(`${name}: at least two model attempts`, modelRequests.length >= 2, `attempts=${modelRequests.length}`);
  recordCheck(
    `${name}: every attempt masked`,
    allAttemptsMasked,
    `attempts=${modelRequests.length}`,
  );
  recordCheck(`${name}: opencode retry event observed`, retryEvents.length > 0);
  if (run.exitCode !== 0 && common.leaked.length === 0 && verdict === "pass") {
    verdict = "unverified";
    reason = `attempts masked, but opencode exited ${run.exitCode}`;
  }
  caseResults.push({
    case: name,
    verdict,
    reason,
    requests: requests.length,
    counts: caseCounts(requests),
    evidence: {
      attempts: modelRequests.length,
      attemptBodiesIdentical,
      retryLayer: retryEvents.length > 0 ? "opencode-session" : "unidentified",
      retryEvents: retryEvents.map((event) => ({
        attempt: event.attempt,
        errorType: event.error?.type ?? null,
        status: event.error?.status ?? null,
        delayMs:
          typeof event.nextRetryAt === "number" && typeof event.timestamp === "number"
            ? event.nextRetryAt - event.timestamp
            : null,
      })),
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      configIsolation,
    },
  });
}

async function runFreshPair({
  workdir,
  stub,
  mintPrompt,
  ownPrompt,
  mintCanary,
  ownCanary,
  oldToken,
  persistence,
  label,
}) {
  const options = persistence
    ? {
        persistence: {
          enabled: true,
          path: join(workdir, "persist", "SGP.db"),
          keyFile: true,
          keyfilePath: join(workdir, "persist", "key"),
        },
      }
    : {};
  writeConfig(workdir, stub.port, options);
  const configIsolation = checkConfigIsolation("fresh-session", workdir, label);
  const fixtures = {
    mint: fixturePath(workdir, mintCanary),
    own: fixturePath(workdir, ownCanary),
  };
  stub.state.phase = "mint";
  stub.state.modelSteps = 0;
  stub.state.mintedToken = null;
  stub.state.oldToken = null;
  const mintRun = await runOpencode({ workdir, prompt: mintPrompt });
  const mintedToken = stub.state.mintedToken;
  const mintSessionIDs = sessionIDs(mintRun.stdout);
  await sleep(300);

  let persistControl = null;
  if (persistence) {
    stub.state.phase = "persist-continue";
    stub.state.modelSteps = 0;
    stub.state.oldToken = mintedToken ?? null;
    const continueRun = await runOpencode({
      workdir,
      prompt: `Continue from the store: ${mintedToken ?? "missing-token"}.`,
      sessionID: mintSessionIDs[0],
    });
    saveRun("fresh-session", `${label}.continue`, continueRun);
    persistControl = {
      ran: true,
      exitCode: continueRun.exitCode,
      timedOut: continueRun.timedOut,
      sessionID: mintSessionIDs[0] ?? null,
      restored: readSucceeded(continueRun.stdout, fixtures.mint),
    };
    await sleep(300);
  }

  stub.state.phase = "fresh";
  stub.state.modelSteps = 0;
  stub.state.oldToken = oldToken ?? mintedToken ?? null;
  stub.state.ownToken = null;
  const freshRun = await runOpencode({ workdir, prompt: ownPrompt });
  saveRun("fresh-session", `${label}.mint`, mintRun);
  saveRun("fresh-session", `${label}.fresh`, freshRun);

  const sameSessionRestore = readSucceeded(mintRun.stdout, fixtures.mint);
  const oldTokenRestored = readSucceeded(freshRun.stdout, fixtures.mint);
  const ownTokenRestored = readSucceeded(freshRun.stdout, fixtures.own);
  const freshSessionIDs = sessionIDs(freshRun.stdout);
  const distinctSessionIDs =
    mintSessionIDs.length > 0 &&
    freshSessionIDs.length > 0 &&
    mintSessionIDs.every((id) => !freshSessionIDs.includes(id));
  const oldTokenAttempted =
    typeof mintedToken === "string" &&
    readToolEvents(freshRun.stdout).some((event) =>
      (event.inputPath ?? "").includes(mintedToken),
    );
  return {
    fixtures,
    mintRun,
    freshRun,
    mintedToken,
    sameSessionRestore,
    oldTokenRestored,
    ownTokenRestored,
    oldTokenAttempted,
    mintSessionIDs,
    freshSessionIDs,
    distinctSessionIDs,
    persistControl,
    configIsolation,
  };
}

async function runFreshSession() {
  const name = "fresh-session";
  const workdir = prepareCaseDir(name);
  const stub = await createStub(name, behaviours[name]);
  const pair = await runFreshPair({
    workdir,
    stub,
    mintCanary: canaries.freshMint,
    ownCanary: canaries.freshOwn,
    mintPrompt: `Record this contact for the session: ${canaries.freshMint}.`,
    ownPrompt: `This is a new session. Record this contact: ${canaries.freshOwn}.`,
    label: "default",
  });
  const defaultRequests = stub.requests.slice();
  await stub.close();

  const persistDir = join(workdir, "persist");
  mkdirSync(persistDir, { recursive: true });
  const keychainProbesBefore = readFileSync(KEYCHAIN_LOG, "utf8").split("\n").filter(Boolean).length;
  const persistStub = await createStub(name, behaviours[name]);
  const persistPair = await runFreshPair({
    workdir,
    stub: persistStub,
    mintCanary: canaries.persistMint,
    ownCanary: canaries.freshOwn,
    mintPrompt: `Record this persistence contact: ${canaries.persistMint}.`,
    ownPrompt: `This is a new persistence session. Record this contact: ${canaries.freshOwn}.`,
    persistence: true,
    label: "persistence",
  });
  await persistStub.close();
  const allRequests = [...defaultRequests, ...persistStub.requests];
  const common = commonChecks(name, allRequests);

  recordCheck(
    `${name}: mint run exited cleanly`,
    pair.mintRun.exitCode === 0 && !pair.mintRun.timedOut,
    `exit=${pair.mintRun.exitCode}`,
  );
  recordCheck(
    `${name}: fresh run exited cleanly`,
    pair.freshRun.exitCode === 0 && !pair.freshRun.timedOut,
    `exit=${pair.freshRun.exitCode}`,
  );
  recordCheck(`${name}: fresh run is a different session`, pair.distinctSessionIDs);
  recordCheck(`${name}: token minted in the first session`, typeof pair.mintedToken === "string");
  recordCheck(`${name}: same-session restoration control`, pair.sameSessionRestore);
  recordCheck(`${name}: fresh session attempted the previous token`, pair.oldTokenAttempted);
  recordCheck(`${name}: fresh session does not restore the old token`, !pair.oldTokenRestored);
  recordCheck(`${name}: fresh session restores its own token`, pair.ownTokenRestored);

  let verdict = "fail";
  let reason = "fresh-session controls failed";
  if (common.leaked.length > 0) {
    reason = "canary reached the provider";
  } else if (!pair.mintedToken) {
    reason = "no minted token was observed in the first session";
  } else if (!pair.sameSessionRestore) {
    reason = "the same-session restoration control failed";
  } else if (!pair.ownTokenRestored) {
    reason = "the fresh session could not restore its own token";
  } else if (!pair.distinctSessionIDs) {
    reason = "the fresh run did not use a different session";
  } else if (!pair.oldTokenAttempted) {
    verdict = "unverified";
    reason = "the fresh session never attempted the previous session's token";
  } else if (pair.oldTokenRestored) {
    reason = "the fresh session restored a token minted in the previous session";
  } else {
    verdict = "pass";
    reason =
      "same-session restoration works; a fresh session restores its own token but not the previous session's token";
  }

  const persistStorePath = join(persistDir, "SGP.db");
  const persistKeyPath = join(persistDir, "key");
  const workdirReal = realpathSync(workdir);
  const storeInsideTree =
    existsSync(persistStorePath) && isInside(workdirReal, realpathSync(persistStorePath));
  const keyfileInsideTree =
    existsSync(persistKeyPath) && isInside(workdirReal, realpathSync(persistKeyPath));
  const keychainProbes = Math.max(
    0,
    readFileSync(KEYCHAIN_LOG, "utf8").split("\n").filter(Boolean).length - keychainProbesBefore,
  );
  const continueControl = persistPair.persistControl;
  const persistenceIssues = [];
  if (
    !persistPair.mintRun ||
    persistPair.mintRun.exitCode !== 0 ||
    persistPair.mintRun.timedOut
  ) {
    persistenceIssues.push("persistence-on mint run did not exit cleanly");
  }
  if (
    !persistPair.freshRun ||
    persistPair.freshRun.exitCode !== 0 ||
    persistPair.freshRun.timedOut
  ) {
    persistenceIssues.push("persistence-on fresh run did not exit cleanly");
  }
  if (
    !continueControl ||
    continueControl.exitCode !== 0 ||
    continueControl.timedOut ||
    continueControl.restored !== true
  ) {
    persistenceIssues.push("continued-process store control did not restore the minted token");
  }
  if (!persistPair.distinctSessionIDs) {
    persistenceIssues.push("persistence-on fresh run was not a distinct session");
  }
  if (!persistPair.oldTokenAttempted) {
    persistenceIssues.push("persistence-on fresh session did not attempt the previous token");
  }
  if (persistPair.oldTokenRestored) {
    persistenceIssues.push("persistence-on fresh session restored the previous token");
  }
  if (!persistPair.ownTokenRestored) {
    persistenceIssues.push("persistence-on fresh session did not restore its own token");
  }
  if (!storeInsideTree) {
    persistenceIssues.push("store file missing or outside the isolated tree");
  }
  if (!keyfileInsideTree) {
    persistenceIssues.push("keyfile missing or outside the isolated tree");
  }
  if (keychainProbes === 0) {
    persistenceIssues.push("keychain stub was not probed");
  }
  const persistenceOnPass = persistenceIssues.length === 0;

  const persistenceOn = {
    ran: true,
    mintedToken: typeof persistPair.mintedToken === "string",
    distinctSessionIDs: persistPair.distinctSessionIDs,
    oldTokenAttempted: persistPair.oldTokenAttempted,
    oldTokenRestored: persistPair.oldTokenRestored,
    ownTokenRestored: persistPair.ownTokenRestored,
    storeCreated: existsSync(persistStorePath),
    keyfileCreated: existsSync(persistKeyPath),
    storeInsideTree,
    keyfileInsideTree,
    keychainProbes,
    continueControl,
    pass: persistenceOnPass,
    issues: persistenceIssues,
    status: persistPair.oldTokenRestored ? "restored" : "not-restored",
  };
  recordCheck(
    `${name}: persistence-on mint, fresh and continue processes exited cleanly`,
    persistPair.mintRun.exitCode === 0 &&
      !persistPair.mintRun.timedOut &&
      persistPair.freshRun.exitCode === 0 &&
      !persistPair.freshRun.timedOut &&
      !!continueControl &&
      continueControl.exitCode === 0 &&
      !continueControl.timedOut,
    `exit=${persistPair.mintRun.exitCode}/${persistPair.freshRun.exitCode}/${continueControl?.exitCode ?? "none"}`,
  );
  recordCheck(
    `${name}: persistence-on fresh run is a different session`,
    persistPair.distinctSessionIDs,
  );
  recordCheck(
    `${name}: persistence-on fresh session attempted the previous token`,
    persistPair.oldTokenAttempted,
  );
  recordCheck(
    `${name}: persistence-on fresh session does not restore the previous token`,
    !persistPair.oldTokenRestored,
  );
  recordCheck(
    `${name}: persistence-on fresh session restores its own token`,
    persistPair.ownTokenRestored,
  );
  recordCheck(
    `${name}: persistence-on store and keyfile exist inside the isolated tree`,
    storeInsideTree && keyfileInsideTree,
    `store=${storeInsideTree} keyfile=${keyfileInsideTree}`,
  );
  recordCheck(`${name}: persistence-on keychain stub was probed`, keychainProbes > 0, `probes=${keychainProbes}`);
  recordCheck(
    `${name}: persistence-on store restores the minted token in a continued session`,
    !!continueControl && continueControl.restored === true,
    continueControl ? `exit=${continueControl.exitCode}` : "no continue run",
  );
  if (!persistenceOnPass && verdict !== "fail") {
    verdict = "fail";
    reason = `persistence-on controls failed: ${persistenceIssues.join("; ")}`;
  }

  caseResults.push({
    case: name,
    verdict,
    reason,
    requests: allRequests.length,
    counts: caseCounts(allRequests),
    evidence: {
      mintedTokenObserved: typeof pair.mintedToken === "string",
      mintSessionID: pair.mintSessionIDs[0] ?? null,
      freshSessionID: pair.freshSessionIDs[0] ?? null,
      distinctSessionIDs: pair.distinctSessionIDs,
      sameSessionRestore: pair.sameSessionRestore,
      oldTokenAttempted: pair.oldTokenAttempted,
      oldTokenRestored: pair.oldTokenRestored,
      ownTokenRestored: pair.ownTokenRestored,
      mintExitCode: pair.mintRun.exitCode,
      freshExitCode: pair.freshRun.exitCode,
      configIsolation: {
        default: pair.configIsolation,
        persistenceOn: persistPair.configIsolation,
      },
      persistenceOn,
    },
  });
}

async function runSameHost() {
  const name = "same-host";
  const workdir = prepareCaseDir(name);
  const stub = await createStub(name, behaviours[name]);
  writeConfig(workdir, stub.port);
  const configIsolation = checkConfigIsolation(name, workdir);
  const fixtures = {
    mint: fixturePath(workdir, canaries.sameHostMint),
    own: fixturePath(workdir, canaries.sameHostOwn),
  };
  const port = await freePort();
  const serverURL = `http://127.0.0.1:${port}`;
  const serverEnv = { OPENCODE_PASSWORD: ["ls", "e2e", "same", "host"].join("-") };
  const serve = spawn(BIN, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: workdir,
    env: opencodeEnv(workdir, serverEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serveOut = "";
  let serveErr = "";
  let serveExit = null;
  serve.stdout.on("data", (chunk) => (serveOut += chunk.toString()));
  serve.stderr.on("data", (chunk) => (serveErr += chunk.toString()));
  serve.on("close", (code) => {
    serveExit = code;
  });
  const serverPid = serve.pid;
  const listening = await waitFor(
    () => serveOut.includes("server listening on") || serveExit !== null,
    30000,
  );

  let mintRun = null;
  let freshRun = null;
  let mintedToken = null;
  if (listening && serveExit === null) {
    stub.state.phase = "mint";
    stub.state.modelSteps = 0;
    stub.state.mintedToken = null;
    stub.state.oldToken = null;
    mintRun = await runOpencode({
      workdir,
      prompt: `Record this same-host contact: ${canaries.sameHostMint}.`,
      server: serverURL,
      extraEnv: serverEnv,
    });
    mintedToken = stub.state.mintedToken;
    await sleep(300);

    stub.state.phase = "fresh";
    stub.state.modelSteps = 0;
    stub.state.oldToken = mintedToken ?? null;
    stub.state.ownToken = null;
    freshRun = await runOpencode({
      workdir,
      prompt: `This is a second same-host session. Record this contact: ${canaries.sameHostOwn}.`,
      server: serverURL,
      extraEnv: serverEnv,
    });
    await sleep(300);
  }

  const serverWasListening = listening && serveExit === null;
  const serverStillRunning =
    serveExit === null &&
    (() => {
      try {
        process.kill(serverPid, 0);
        return true;
      } catch {
        return false;
      }
    })();
  const serveExitBeforeStop = serveExit;
  writeFileSync(join(LOGS_DIR, `${name}.serve.stdout.txt`), serveOut);
  writeFileSync(join(LOGS_DIR, `${name}.serve.stderr.txt`), serveErr);
  if (mintRun) saveRun(name, "mint", mintRun);
  if (freshRun) saveRun(name, "fresh", freshRun);
  await stopServer(serve);
  await stub.close();

  const requests = stub.requests;
  const common = commonChecks(name, requests);
  const mintSessionIDs = mintRun ? sessionIDs(mintRun.stdout) : [];
  const freshSessionIDs = freshRun ? sessionIDs(freshRun.stdout) : [];
  const distinctSessionIDs =
    mintSessionIDs.length > 0 &&
    freshSessionIDs.length > 0 &&
    mintSessionIDs.every((id) => !freshSessionIDs.includes(id));
  const mintRestore = mintRun ? readSucceeded(mintRun.stdout, fixtures.mint) : false;
  const oldTokenRestored = freshRun ? readSucceeded(freshRun.stdout, fixtures.mint) : false;
  const ownTokenRestored = freshRun ? readSucceeded(freshRun.stdout, fixtures.own) : false;
  const oldTokenAttempted =
    typeof mintedToken === "string" &&
    !!freshRun &&
    readToolEvents(freshRun.stdout).some((event) =>
      (event.inputPath ?? "").includes(mintedToken),
    );
  const sameServer = serverStillRunning && distinctSessionIDs;

  recordCheck(
    `${name}: serve reported listening`,
    serverWasListening,
    `exit=${serveExitBeforeStop}`,
  );
  recordCheck(
    `${name}: both runs exited cleanly`,
    !!mintRun &&
      !!freshRun &&
      mintRun.exitCode === 0 &&
      !mintRun.timedOut &&
      freshRun.exitCode === 0 &&
      !freshRun.timedOut,
    `exit=${mintRun?.exitCode ?? "none"}/${freshRun?.exitCode ?? "none"}`,
  );
  recordCheck(`${name}: first session minted and restored its own token`, mintRestore);
  recordCheck(`${name}: second session restored its own token`, ownTokenRestored);
  recordCheck(`${name}: the two runs created distinct sessions`, distinctSessionIDs);
  recordCheck(
    `${name}: both sessions used the same live server process`,
    sameServer,
    `pid=${serverPid} alive=${serverStillRunning}`,
  );
  recordCheck(`${name}: second session attempted the first session's token`, oldTokenAttempted);
  recordCheck(
    `${name}: second session did not restore the first session's token`,
    !oldTokenRestored,
  );

  let verdict = "fail";
  let reason = "same-host controls failed";
  if (common.leaked.length > 0) {
    reason = "canary reached the provider";
  } else if (!serverWasListening) {
    verdict = "unverified";
    reason = `opencode serve did not report listening (exit=${serveExitBeforeStop}); same-host sub-scenario unverified`;
  } else if (!mintRun || mintRun.exitCode !== 0 || mintRun.timedOut) {
    reason = "the first same-host session did not exit cleanly";
  } else if (!freshRun || freshRun.exitCode !== 0 || freshRun.timedOut) {
    reason = "the second same-host session did not exit cleanly";
  } else if (typeof mintedToken !== "string") {
    reason = "no minted token was observed in the first same-host session";
  } else if (!mintRestore) {
    reason = "the first same-host session failed its own-token restoration control";
  } else if (!ownTokenRestored) {
    reason = "the second same-host session could not restore its own token";
  } else if (!distinctSessionIDs) {
    reason = "the two same-host runs did not create distinct sessions";
  } else if (!sameServer) {
    reason = "the two same-host runs were not served by the same live server process";
  } else if (!oldTokenAttempted) {
    verdict = "unverified";
    reason = "the second same-host session never attempted the first session's token";
  } else if (oldTokenRestored) {
    reason = "the same host restored a token minted in another session";
  } else {
    verdict = "pass";
    reason =
      "two sessions in one serve process: session 2 restores its own token but not session 1's token";
  }

  caseResults.push({
    case: name,
    verdict,
    reason,
    requests: requests.length,
    counts: caseCounts(requests),
    evidence: {
      serverPid,
      serverURL,
      serverListening: serverWasListening,
      serverStillRunning,
      sameServer,
      mintSessionID: mintSessionIDs[0] ?? null,
      freshSessionID: freshSessionIDs[0] ?? null,
      distinctSessionIDs,
      mintedTokenObserved: typeof mintedToken === "string",
      mintRestore,
      ownTokenRestored,
      oldTokenAttempted,
      oldTokenRestored,
      mintExitCode: mintRun?.exitCode ?? null,
      freshExitCode: freshRun?.exitCode ?? null,
      configIsolation,
    },
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    child.once("close", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 3000);
    setTimeout(finish, 5000);
  });
}

const runners = {
  compaction: runCompaction,
  retry: runRetry,
  "fresh-session": runFreshSession,
  "same-host": runSameHost,
};

for (const name of selected) {
  try {
    await runners[name]();
  } catch (error) {
    caseResults.push({
      case: name,
      verdict: "fail",
      reason: `runner error: ${error?.message ?? error}`,
      requests: 0,
      evidence: {},
    });
    recordCheck(`${name}: runner completed`, false, String(error?.message ?? error));
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  opencodeVersion: version,
  gitHead,
  model: "capture/capture-1",
  config: {
    provider: "@opencode/ai/providers/openai-compatible",
    modelLimit: { context: 200000, output: 32000 },
    pluginPackage: DIST_DIR,
    plugin: { options: { mode: "transparent" } },
    compaction: "OpenCode defaults (no compaction overrides)",
    persistence:
      "default off for the main fresh-session pair; persistence-on pair uses an isolated store and keyfile plus a cross-process continue control",
    isolation: {
      out: REAL_OUT,
      outUnderTmp: isInside(REAL_TMP, REAL_OUT),
      outOutsideRepo: !isInside(REAL_REPO, REAL_OUT),
      home: REAL_HOME,
      configDir: "OPENCODE_CONFIG_DIR=<case>/config/opencode",
      projectDiscovery: "disabled via OPENCODE_CONFIG_PROJECT_DISABLE=1",
      checkedWith: "opencode debug config --standalone",
    },
  },
  hostBehaviour: {
    configDiscovery:
      "OpenCode 2.4.1 reads global config from $XDG_CONFIG_HOME/opencode (or $OPENCODE_CONFIG_DIR) and merges opencode.json(c) and .opencode/opencode.json(c) from the working directory and every ancestor through the filesystem root; HOME/XDG overrides alone do not stop ancestor discovery. OPENCODE_CONFIG_PROJECT_DISABLE=1 (alias OPENCODE_DISABLE_PROJECT_CONFIG=1) disables project/ancestor discovery, OPENCODE_CONFIG_DIR pins the global directory, and OPENCODE_CONFIG/OPENCODE_CONFIG_CONTENT are additional sources the harness strips. Each case runs `opencode debug config --standalone` and asserts exactly one document (the harness config), plugin packages exactly [dist], providers exactly [capture], and every source path inside the case tree.",
    sameHost:
      "`opencode serve --port <p> --hostname 127.0.0.1` plus `opencode run --server http://127.0.0.1:<p>` works on 2.4.1: consecutive runs create distinct sessions served by one long-lived server process (same PID), with the server requiring OPENCODE_PASSWORD for its client. This proves mappings are per-session inside one plugin instance rather than process-global.",
    compaction:
      "Automatic compaction is on by default (compaction.auto true, keep 15000 tokens, background true). It runs at the start of a model step when the estimated context reaches the window minus the default buffer: max(15% of context, 16000) when the window is at least 32000, so 170000 on a 200000-token window. This run drove the estimate with a 190000 prompt_tokens usage chunk.",
    retry:
      "OpenCode 2.4.1 retries at the session layer: rate limit, provider-internal 503/529, and unsent/known transport failures; up to 3 retries with a roughly 2s jittered base delay. Evidence is the `retry` event with attempt 2 and error.type provider.internal; the resend is therefore the session-retry path, not a separate AI SDK retry.",
    persistence:
      "Transparent-mode mappings are memory-only unless plugins[].options.persistence.enabled is true. Store hydration is keyed by OpenCode session ID, so a continued process restores the minted token while a different session in the same process does not.",
  },
  cases: caseResults,
  checks,
};

writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log("");
console.log(
  `${version}  git=${gitHead.slice(0, 10)}  model=capture/capture-1  cases=${caseResults.length}`,
);
for (const result of caseResults) {
  console.log(`${result.verdict.toUpperCase().padEnd(14)} ${result.case}: ${result.reason}`);
}
console.log("");
console.log(JSON.stringify(summary, null, 2));

if (caseResults.some((result) => result.verdict === "fail") || checks.some((check) => !check.ok)) {
  process.exit(1);
}

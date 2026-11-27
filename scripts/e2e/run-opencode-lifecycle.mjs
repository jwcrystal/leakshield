#!/usr/bin/env node
/**
 * Lifecycle evidence for the LeakShield OpenCode plugin on real OpenCode 2.4.1.
 *
 * Three readiness rows, each driven through a loopback OpenAI-compatible stub
 * and `opencode run --standalone` in isolated XDG/HOME dirs:
 *
 *   compaction   default automatic compaction: the summarizer request and the
 *                following model request must carry placeholders, never a canary
 *   retry        a retryable 503 on the first attempt; OpenCode retries and both
 *                attempts are captured masked
 *   fresh-session a token minted in one session is not restored in a new
 *                session (default persistence off), with a same-session
 *                restoration control and a per-fresh-session own-token control
 *
 * Every provider request body is written under `<out>/requests/`. The final
 * JSON summary never contains a canary value.
 *
 * Usage: node scripts/e2e/run-opencode-lifecycle.mjs --out <dir>
 *        [--only compaction,retry,fresh-session]
 * Requires `npm run build`; OPENCODE_BIN overrides the pinned binary.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSPARENT_TOKEN } from "./transparent-token.mjs";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(E2E_DIR, "..", "..");
const DIST_DIR = join(REPO, "dist");
const EXPECTED_VERSION = "2.4.1";
const DEFAULT_BIN = "/Users/jared/.local/share/mise/installs/node/24.22.3/bin/opencode";
const ALL_CASES = ["compaction", "retry", "fresh-session"];
const RUN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240000);

const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
};
const onlyOption =
  option("--only") ?? process.argv.find((arg) => arg.startsWith("--only="))?.slice(7);
const outArg = option("--out");
if (!outArg) {
  console.error(
    "usage: node scripts/e2e/run-opencode-lifecycle.mjs --out <dir> [--only compaction,retry,fresh-session]",
  );
  process.exit(2);
}
const OUT = resolve(outArg);
if (OUT.includes(delimiter)) {
  console.error(`--out must not contain "${delimiter}": the keychain stub directory is prepended to PATH`);
  process.exit(2);
}
const selected = onlyOption
  ? onlyOption.split(",").map((name) => name.trim()).filter(Boolean)
  : ALL_CASES;
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
const version = execFileSync(BIN, ["--version"], { encoding: "utf8" }).trim();
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

function installKeychainStubs(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logPath, "");
  for (const name of ["security", "secret-tool"]) {
    const file = join(binDir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${logPath}'\nexit 1\n`,
    );
    chmodSync(file, 0o755);
  }
}
const KEYCHAIN_DIR = join(OUT, "keychain-stub");
const KEYCHAIN_LOG = join(OUT, "keychain-stub.log");
installKeychainStubs(KEYCHAIN_DIR, KEYCHAIN_LOG);

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

function runOpencode({ workdir, prompt }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCODE_|OPENCHAMBER_|LEAKSHIELD_|CAPTURE_)/.test(key)) continue;
    env[key] = value;
  }
  env.CAPTURE_API_KEY = "sg-e2e-capture";
  env.PWD = workdir;
  env.HOME = join(workdir, "home");
  env.XDG_CONFIG_HOME = join(workdir, "config");
  env.XDG_DATA_HOME = join(workdir, "data");
  env.XDG_STATE_HOME = join(workdir, "state");
  env.XDG_CACHE_HOME = join(workdir, "cache");
  env.PATH = `${KEYCHAIN_DIR}${delimiter}${dirname(resolve(BIN))}${delimiter}${env.PATH ?? ""}`;
  const args = [
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    "capture/capture-1",
    prompt,
  ];
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(BIN, args, {
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
  await sleep(300);

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
  const mintSessionIDs = sessionIDs(mintRun.stdout);
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

  const persistenceOn = {
    ran: true,
    mintedToken: typeof persistPair.mintedToken === "string",
    distinctSessionIDs: persistPair.distinctSessionIDs,
    oldTokenAttempted: persistPair.oldTokenAttempted,
    oldTokenRestored: persistPair.oldTokenRestored,
    ownTokenRestored: persistPair.ownTokenRestored,
    storeCreated: existsSync(join(workdir, "persist", "SGP.db")),
    keyfileCreated: existsSync(join(workdir, "persist", "key")),
    keychainProbes: readFileSync(KEYCHAIN_LOG, "utf8").split("\n").filter(Boolean).length,
    status: persistPair.oldTokenRestored ? "restored" : "not-restored",
  };
  recordCheck(
    `${name}: persistence-on extra run completed`,
    persistPair.mintRun.exitCode === 0 && persistPair.freshRun.exitCode === 0,
    `exit=${persistPair.mintRun.exitCode}/${persistPair.freshRun.exitCode}`,
  );

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
      persistenceOn,
    },
  });
}

const runners = {
  compaction: runCompaction,
  retry: runRetry,
  "fresh-session": runFreshSession,
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
    persistence: "default off for the main fresh-session pair; extra persistence-on pair uses isolated store and keyfile",
  },
  hostBehaviour: {
    compaction:
      "Automatic compaction is on by default (compaction.auto true, keep 15000 tokens, background true). It runs at the start of a model step when the estimated context reaches the window minus the default buffer: max(15% of context, 16000) when the window is at least 32000, so 170000 on a 200000-token window. This run drove the estimate with a 190000 prompt_tokens usage chunk.",
    retry:
      "OpenCode 2.4.1 retries at the session layer: rate limit, provider-internal 503/529, and unsent/known transport failures; up to 3 retries with a roughly 2s jittered base delay. Evidence is the `retry` event with attempt 2 and error.type provider.internal; the resend is therefore the session-retry path, not a separate AI SDK retry.",
    persistence:
      "Transparent-mode mappings are memory-only unless plugins[].options.persistence.enabled is true.",
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

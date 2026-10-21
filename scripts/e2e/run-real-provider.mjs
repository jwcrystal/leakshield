#!/usr/bin/env node
/**
 * Real-provider transparent-mode verification (issue #26).
 *
 * Runs the built plugin against a REAL model provider in a private server with
 * an isolated HOME, and proves from the host's own outgoing request that the
 * synthetic originals never leave the machine while placeholders do. Records
 * only booleans/counts — never prompts, replies, keys or request bodies. The
 * stand-in provider runs with recording off, so multi-turn replay is asserted
 * from each turn's placeholder count rather than from captured text.
 *
 * Gate: E2E_REAL=1 (spends real credits). Stand-in mode (`E2E_PROVIDER=capture`)
 * needs no credentials and validates the harness itself.
 *
 * Usage:
 *   npm run build
 *   E2E_REAL=1 E2E_PROVIDER=anthropic node scripts/e2e/run-real-provider.mjs
 *   E2E_PROVIDER=capture node scripts/e2e/run-real-provider.mjs   # offline self-test
 *
 * Env:
 *   E2E_PROVIDER        anthropic | openai | capture      (default anthropic)
 *   E2E_ANTHROPIC_MODEL default claude-haiku-4-5-20251001
 *   E2E_OPENAI_MODEL    required for E2E_PROVIDER=openai
 *   E2E_TURNS           long-history turns               (default 6)
 *   E2E_TIMEOUT_MS      per model call                   (default 180000)
 *   E2E_WORK_ROOT       evidence parent                  (default $TMPDIR/opencode)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY as required by the provider
 *
 * Exit: 0 all cases passed, 1 a case failed, 2 preconditions missing.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS,
  expectedCanariesFor,
  freePort,
  isolatedEnv,
  modelFor,
  providerEntry,
  readTrace,
  requireGate,
  runApi,
  runCliTurn,
  startCaptureServer,
  startPrivateServer,
  stopChild,
  waitForHealth,
  waitForPluginActive,
  writeObservedProject,
} from "./lib/real-harness.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.OPENCODE_BIN || "opencode";
const PROVIDER = process.env.E2E_PROVIDER || "anthropic";
const SPEC = PROVIDERS[PROVIDER];
if (!SPEC) {
  console.error(`E2E_PROVIDER must be anthropic, openai or capture (got "${PROVIDER}")`);
  process.exit(2);
}
const MODEL = modelFor(PROVIDER);
if (!MODEL) {
  console.error("E2E_OPENAI_MODEL is required for E2E_PROVIDER=openai (model names change; no default).");
  process.exit(2);
}
if (PROVIDER !== "capture") {
  requireGate("E2E_REAL", `to call the real ${PROVIDER} API (this spends credits).`);
  if (SPEC.keyEnv && !process.env[SPEC.keyEnv]) {
    console.error(`Missing ${SPEC.keyEnv}. Export it in this shell; the script never stores or prints it.`);
    process.exit(2);
  }
}
const TURNS = Math.max(1, Number(process.env.E2E_TURNS || 6));
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180000);
const WORK_PARENT =
  process.env.E2E_WORK_ROOT ||
  (existsSync(path.join(os.tmpdir(), "opencode")) ? path.join(os.tmpdir(), "opencode") : os.tmpdir());
const ROOT = mkdtempSync(path.join(WORK_PARENT, "sg-real-"));
const PLACEHOLDER_PREFIX = "[SGP" + "2:";
const EXPECTED_ROUTES = PROVIDER === "anthropic" ? ["messages"] : PROVIDER === "capture" ? ["chat"] : ["responses", "chat"];

if (!existsSync(path.join(REPO, "dist/opencode-transparent.js"))) {
  console.error("dist/ is missing or stale: run `npm run build` first.");
  process.exit(2);
}

const EMAILS = Array.from({ length: TURNS }, (_, index) => `verify-t${index + 1}@example.test`);
const AWS_CANARY = "AKIAIOSFODNN7EXAMPLE"; // public AWS documentation key

const rows = [];
let capture = null;
let capturePort = 0;

function responseText(result) {
  const data = result?.value?.data ?? result?.value;
  return typeof data === "string" ? data : typeof data?.text === "string" ? data.text : "";
}

function traceSummary(rows) {
  return {
    count: rows.length,
    routes: [...new Set(rows.map((row) => row.route))],
    originals: rows.filter((row) => row.syntheticOriginalPresent).length,
    placeholderRows: rows.filter((row) => row.placeholderPresent).length,
    canaryTotal: rows.reduce((sum, row) => sum + (row.canaryCount || 0), 0),
    bytesPerRequest: rows.map((row) => row.bytes || 0),
  };
}

/** Per-request observations for one session, in arrival order. */
function traceRows(tracePath, sessionID) {
  return readTrace(tracePath).filter((row) => row.sessionID === sessionID);
}

async function runCase({ id, wireProtection, turns, canaries }) {
  const dir = path.join(ROOT, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = isolatedEnv(dir);
  const provider = providerEntry({
    provider: PROVIDER,
    model: MODEL,
    ...(PROVIDER === "capture" ? { baseURL: `http://127.0.0.1:${capturePort}/v1`, apiKey: "sg-e2e-capture" } : {}),
  });
  const { tracePath } = writeObservedProject({
    dir,
    repo: REPO,
    pluginOptions: { wireProtection, persistence: { enabled: false } },
    providers: { [PROVIDER]: provider },
  });
  const state = { id, provider: PROVIDER, model: MODEL, wireProtection, turns, passed: false };
  let server = null;
  try {
    const started = await startPrivateServer({ bin: BIN, cwd: dir, env });
    server = started.child;
    state.plugin = await waitForPluginActive({ bin: BIN, serverURL: started.url, cwd: dir, env });
    const created = runApi({
      bin: BIN,
      serverURL: started.url,
      method: "post",
      endpoint: "/api/session",
      data: {
        title: `leakshield real verification ${id}`,
        model: { providerID: PROVIDER, id: MODEL },
        location: { directory: dir },
      },
      cwd: dir,
      env,
      timeoutMs: 30000,
    });
    const session = created.value?.data ?? created.value;
    const sessionID = session?.id;
    state.sessionCreated = typeof sessionID === "string" && sessionID.startsWith("ses_");
    if (!state.sessionCreated) {
      state.failure = "session_create_failed";
      return state;
    }
    const turnsRun = [];
    let lastReply = "";
    for (let turn = 0; turn < turns; turn++) {
      const canary = canaries[turn % canaries.length];
      const prompt =
        turns === 1
          ? `Reply with exactly this one line and nothing else: Contact ${canary} READY. Do not use tools.`
          : turn === turns - 1
            ? "Without using tools, repeat verbatim every line I asked you to repeat, one per line, and nothing else."
            : `Without using tools, repeat verbatim only this line: Contact ${canary} TURN_${turn + 1}.`;
      // Requests that arrive during this turn; history replay is asserted from
      // their placeholder counts below (turn N carries N earlier canaries).
      const seenBefore = traceRows(tracePath, sessionID).length;
      // The generate endpoint starts a fresh turn without replaying history,
      // so multi-turn cases must go through the CLI, which loads the session.
      const generated =
        turns > 1
          ? runCliTurn({
              bin: BIN,
              serverURL: started.url,
              cwd: dir,
              env,
              sessionID,
              modelRef: `${PROVIDER}/${MODEL}`,
              prompt,
              timeoutMs: TIMEOUT_MS,
            })
          : runApi({
              bin: BIN,
              serverURL: started.url,
              method: "post",
              endpoint: `/api/session/${sessionID}/generate`,
              data: { prompt },
              cwd: dir,
              env,
              timeoutMs: TIMEOUT_MS,
            });
      lastReply = turns > 1 ? generated.stdout ?? "" : responseText(generated);
      const turnRows = traceRows(tracePath, sessionID).slice(seenBefore);
      const expectedCanaries = expectedCanariesFor(turn, turns);
      turnsRun.push({
        turn,
        status: generated.status,
        timedOut: generated.timedOut ?? false,
        durationMs: generated.durationMs,
        requests: turnRows.length,
        // Replay evidence: a request that carries history carries the earlier
        // turns' placeholders too. Counts only — no content is kept.
        maxCanaries: turnRows.reduce((max, row) => Math.max(max, row.canaryCount || 0), 0),
        expectedCanaries,
        maxBytes: turnRows.reduce((max, row) => Math.max(max, row.bytes || 0), 0),
      });
      if (generated.status !== 0) break;
    }
    const observed = traceRows(tracePath, sessionID);
    const traces = traceSummary(observed);
    state.turnsCompleted = turnsRun.filter((row) => row.status === 0).length;
    state.turnsDetail = turnsRun;
    state.trace = traces;
    // Turn 0 must carry one placeholder, turn 1 two, and so on: anything less
    // means the host did not replay the earlier history.
    state.replayOk =
      turnsRun.length === turns && turnsRun.every((row) => row.maxCanaries >= row.expectedCanaries);
    // The first canary is the one every later request should still carry, so it
    // is the one worth looking for in the final reply. Recorded, not gated: a
    // model is free to paraphrase, and the stand-in never echoes by design.
    state.echoedFirstCanary = lastReply.includes(canaries[0]);
    state.placeholderInDisplay = lastReply.includes(PLACEHOLDER_PREFIX);
    state.replyLength = lastReply.length;
    const routeOk = traces.count > 0 && traces.routes.every((route) => EXPECTED_ROUTES.includes(route));
    state.failedChecks = [];
    if (state.turnsCompleted !== turns) state.failedChecks.push("turns_incomplete");
    if (traces.count === 0) state.failedChecks.push("no_requests");
    if (traces.originals !== 0) state.failedChecks.push("originals_on_wire");
    if (traces.placeholderRows !== traces.count) state.failedChecks.push("request_without_placeholder");
    if (!routeOk) state.failedChecks.push("unexpected_route");
    if (state.plugin.active !== true) state.failedChecks.push("plugin_inactive");
    if (!state.replayOk) state.failedChecks.push("history_not_replayed");
    state.passed = state.failedChecks.length === 0;
    if (!state.passed) state.failure = "assertion_failed";
    runApi({
      bin: BIN,
      serverURL: started.url,
      method: "delete",
      endpoint: `/api/session/${sessionID}`,
      cwd: dir,
      env,
      timeoutMs: 30000,
    });
    return state;
  } catch (error) {
    state.failure = error instanceof Error ? error.message : "case_error";
    return state;
  } finally {
    await stopChild(server);
  }
}

function record(state, label = state.id) {
  rows.push(state);
  console.log(
    `${label}: ${state.passed ? "PASS" : "FAIL"} wire=${state.wireProtection} turns=${state.turnsCompleted ?? 0}/${state.turns}` +
      (state.trace
        ? ` requests=${state.trace.count} originals=${state.trace.originals} placeholders=${state.trace.placeholderRows}` +
          ` replay=${state.replayOk === true ? "yes" : "no"}`
        : "") +
      (state.failedChecks?.length ? ` failed=[${state.failedChecks.join(",")}]` : "") +
      (state.failure ? ` (${state.failure})` : ""),
  );
}

try {
  if (PROVIDER === "capture") {
    capturePort = await freePort();
    const captureEnv = isolatedEnv(path.join(ROOT, "capture"));
    capture = startCaptureServer({
      repo: REPO,
      env: captureEnv,
      port: capturePort,
      record: false,
    });
    if (!(await waitForHealth(capturePort))) throw new Error("capture server did not become healthy");
  }

  record(await runCase({ id: "real-basic-hook", wireProtection: false, turns: 1, canaries: [EMAILS[0]] }));
  record(await runCase({ id: "real-basic-wire", wireProtection: true, turns: 1, canaries: [EMAILS[0]] }));
  record(await runCase({ id: "real-long-history", wireProtection: true, turns: TURNS, canaries: EMAILS }));
} catch (error) {
  record(
    { id: "harness", passed: false, failure: error instanceof Error ? error.message : "harness_error" },
    "harness",
  );
} finally {
  await stopChild(capture);
}

const hostVersion = spawnSync(BIN, ["--version"], { encoding: "utf8" }).stdout?.trim();
const summary = {
  generatedAt: new Date().toISOString(),
  issue: 26,
  provider: PROVIDER,
  model: MODEL,
  realAccountUsage: PROVIDER !== "capture",
  hostVersion,
  turns: TURNS,
  rows,
  passed: rows.length > 0 && rows.every((row) => row.passed === true),
};
mkdirSync(ROOT, { recursive: true });
writeFileSync(path.join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`Evidence: ${path.join(ROOT, "summary.json")}`);
if (!summary.passed) process.exitCode = 1;

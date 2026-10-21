#!/usr/bin/env node
/**
 * Soak / lifecycle run for transparent mode (issue #26).
 *
 * One private server, many short sessions: create → one tiny model turn →
 * delete, sampling the server's RSS throughout. Proves reclamation and gives
 * a memory-growth series. Content-free: only counts, durations and KiB.
 *
 * This is NOT a WebSocket-reuse proof: the stand-in provider is HTTP, and the
 * real-provider path follows whatever transport that provider's package uses
 * (Anthropic = HTTP Messages). A native Responses-WS soak needs a provider that
 * actually opens WS; record that separately when one is available.
 *
 * Usage:
 *   npm run build
 *   E2E_SOAK=1 node scripts/e2e/run-soak.mjs                       # offline, capture provider
 *   E2E_SOAK=1 E2E_REAL=1 E2E_PROVIDER=anthropic \
 *     E2E_SOAK_MS=3600000 node scripts/e2e/run-soak.mjs            # 1h real soak
 *
 * Env: E2E_PROVIDER (capture|anthropic|openai), E2E_SOAK_MS (60000),
 *      E2E_SOAK_INTERVAL_MS (1000), E2E_SOAK_MAX_ITERATIONS (unbounded),
 *      E2E_WIRE=0 (disable wire protection), E2E_WORK_ROOT,
 *      plus the provider's key/model vars as in run-real-provider.mjs.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS,
  freePort,
  isolatedEnv,
  modelFor,
  providerEntry,
  requireGate,
  runApi,
  sampleRssKb,
  startCaptureServer,
  startPrivateServer,
  stopChild,
  waitForHealth,
  waitForPluginActive,
  writeObservedProject,
} from "./lib/real-harness.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = process.env.OPENCODE_BIN || "opencode";
const PROVIDER = process.env.E2E_PROVIDER || "capture";
const SPEC = PROVIDERS[PROVIDER];
if (!SPEC) {
  console.error(`E2E_PROVIDER must be capture, anthropic or openai (got "${PROVIDER}")`);
  process.exit(2);
}
requireGate("E2E_SOAK", "to acknowledge that this loop creates and deletes real sessions.");
if (PROVIDER !== "capture") {
  requireGate("E2E_REAL", `to call the real ${PROVIDER} API (this spends credits for the whole soak).`);
  if (SPEC.keyEnv && !process.env[SPEC.keyEnv]) {
    console.error(`Missing ${SPEC.keyEnv}. Export it in this shell; the script never stores or prints it.`);
    process.exit(2);
  }
}
const MODEL = modelFor(PROVIDER);
if (!MODEL) {
  console.error("E2E_OPENAI_MODEL is required for E2E_PROVIDER=openai.");
  process.exit(2);
}
const DURATION_MS = Math.max(1000, Number(process.env.E2E_SOAK_MS || 60000));
const INTERVAL_MS = Math.max(100, Number(process.env.E2E_SOAK_INTERVAL_MS || 1000));
const MAX_ITERATIONS = Number(process.env.E2E_SOAK_MAX_ITERATIONS || 0) || Infinity;
const WIRE = process.env.E2E_WIRE !== "0";
const WORK_PARENT =
  process.env.E2E_WORK_ROOT ||
  (existsSync(path.join(os.tmpdir(), "opencode")) ? path.join(os.tmpdir(), "opencode") : os.tmpdir());
const ROOT = mkdtempSync(path.join(WORK_PARENT, "sg-soak-"));
const DIR = path.join(ROOT, "work");

if (!existsSync(path.join(REPO, "dist/opencode-transparent.js"))) {
  console.error("dist/ is missing or stale: run `npm run build` first.");
  process.exit(2);
}

let capture = null;
let server = null;
const rss = [];
const failures = [];
const summary = {
  generatedAt: new Date().toISOString(),
  issue: 26,
  kind: "soak",
  provider: PROVIDER,
  model: MODEL,
  wireProtection: WIRE,
  durationMs: DURATION_MS,
  realAccountUsage: PROVIDER !== "capture",
  iterations: 0,
  passes: 0,
  failures: [],
  rssKb: {},
  sessionsAfterDelete: null,  passed: false,
};

function fatal(code) {
  summary.failure = code;
  return code;
}

try {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  let capturePort = 0;
  if (PROVIDER === "capture") {
    capturePort = await freePort();
    capture = startCaptureServer({
      repo: REPO,
      env: isolatedEnv(path.join(ROOT, "capture")),
      port: capturePort,
      captureDir: path.join(ROOT, "captured"),
    });
    if (!(await waitForHealth(capturePort))) throw new Error(fatal("capture_unhealthy"));
  }
  const provider = providerEntry({
    provider: PROVIDER,
    model: MODEL,
    ...(PROVIDER === "capture" ? { baseURL: `http://127.0.0.1:${capturePort}/v1`, apiKey: "sg-e2e-capture" } : {}),
  });
  const { tracePath } = writeObservedProject({
    dir: DIR,
    repo: REPO,
    pluginOptions: { wireProtection: WIRE, persistence: { enabled: false } },
    providers: { [PROVIDER]: provider },
  });
  void tracePath;
  const env = isolatedEnv(DIR);
  const started = await startPrivateServer({ bin: BIN, cwd: DIR, env });
  server = started.child;
  const plugin = await waitForPluginActive({ bin: BIN, serverURL: started.url, cwd: DIR, env });
  summary.plugin = plugin;
  if (!plugin.active) throw new Error(fatal("plugin_not_active"));

  const info = runApi({ bin: BIN, serverURL: started.url, method: "get", endpoint: "/api/info", cwd: DIR, env });
  const identity = info.value?.data ?? info.value;
  summary.serverPid = identity?.pid ?? null;
  summary.hostVersion = identity?.version;

  const startedAt = Date.now();
  let iteration = 0;
  while (Date.now() - startedAt < DURATION_MS && iteration < MAX_ITERATIONS) {
    iteration++;
    const created = runApi({
      bin: BIN,
      serverURL: started.url,
      method: "post",
      endpoint: "/api/session",
      data: { title: `leakshield soak ${iteration}`, model: { providerID: PROVIDER, id: MODEL }, location: { directory: DIR } },
      cwd: DIR,
      env,
      timeoutMs: 30000,
    });
    const session = created.value?.data ?? created.value;
    const sessionID = session?.id;
    let ok = typeof sessionID === "string" && sessionID.startsWith("ses_");
    if (ok) {
      const generated = runApi({
        bin: BIN,
        serverURL: started.url,
        method: "post",
        endpoint: `/api/session/${sessionID}/generate`,
        data: { prompt: "Reply with exactly OK and nothing else. Do not use tools." },
        cwd: DIR,
        env,
        timeoutMs: 60000,
      });
      ok = generated.status === 0;
      const deleted = runApi({
        bin: BIN,
        serverURL: started.url,
        method: "delete",
        endpoint: `/api/session/${sessionID}`,
        cwd: DIR,
        env,
        timeoutMs: 30000,
      });
      ok = ok && deleted.status === 0;
      if (deleted.status === 0) {
        const after = runApi({
          bin: BIN,
          serverURL: started.url,
          method: "get",
          endpoint: `/api/session/${sessionID}`,
          cwd: DIR,
          env,
          timeoutMs: 15000,
        });
        const body = after.value?.data ?? after.value;
        const stillThere = typeof body === "object" && body !== null && body.id === sessionID;
        summary.deletedSessionsChecked = (summary.deletedSessionsChecked ?? 0) + 1;
        if (!stillThere) summary.deletedSessionsGone = (summary.deletedSessionsGone ?? 0) + 1;
        else failures.push({ iteration, code: "deleted_session_still_listed" });
        ok = ok && !stillThere;
      }
      if (!ok) failures.push({ iteration, code: "session_cycle_failed" });
    } else {
      failures.push({ iteration, code: "session_create_failed" });
    }
    summary.iterations = iteration;
    if (ok) summary.passes++;
    else summary.failures = failures.slice(-20);
    const pid = summary.serverPid;
    const value = pid === null ? null : sampleRssKb(pid);
    if (value !== null) rss.push({ atMs: Date.now() - startedAt, kb: value });
    await new Promise((done) => setTimeout(done, INTERVAL_MS));
  }

  if (rss.length > 0) {
    const values = rss.map((row) => row.kb);
    summary.rssKb = {
      samples: rss.length,
      first: values[0],
      last: values[values.length - 1],
      peak: Math.max(...values),
      min: Math.min(...values),
      delta: values[values.length - 1] - values[0],
    };
  }
  summary.elapsedMs = Date.now() - startedAt;
  summary.passed =
    summary.iterations > 0 && summary.passes === summary.iterations && summary.failures.length === 0;
} catch (error) {
  summary.failure = summary.failure ?? fatal("harness_error");
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  summary.serverStopped = await stopChild(server);
  await stopChild(capture);
}

mkdirSync(ROOT, { recursive: true });
writeFileSync(path.join(ROOT, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `soak: ${summary.passed ? "PASS" : "FAIL"} iterations=${summary.iterations} passes=${summary.passes}` +
    (summary.rssKb.samples ? ` rss ${summary.rssKb.first}→${summary.rssKb.last} KiB (peak ${summary.rssKb.peak})` : "") +
    (summary.failure ? ` (${summary.failure})` : ""),
);
console.log(`Evidence: ${path.join(ROOT, "summary.json")}`);
if (!summary.passed) process.exitCode = 1;

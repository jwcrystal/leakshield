#!/usr/bin/env node
/**
 * Boundary-evidence orchestrator for GitHub issue #19 (sensitive-guard).
 *
 * Runs real `opencode run --standalone` sessions against a local capture
 * server that stands in for the model provider, and records — per case —
 * whether synthetic canary values reach:
 *   1. provider request bodies (out/captured/<case>-<seq>.json),
 *   2. session storage / logs under the isolated XDG dirs,
 *   3. the run's own stdout.
 *
 * Cases:
 *   C1 block        sensitive-guard {mode:"block"}    + canary prompt
 *   C2 redact       sensitive-guard {mode:"redact"}   + canary prompt
 *   C3 tool-output  sensitive-guard {mode:"redact"}   + notes.txt canaries
 *                  (capture server forces a read tool_call on reply #1)
 *   C4a order1      [sensitive-guard(redact), canary-injector] "Say hi."
 *   C4b order2      [canary-injector, sensitive-guard(redact)] "Say hi."
 *   C5 invalid      sensitive-guard {mode:"bogus"}    + canary prompt (fail-closed)
 *   C6 absent       no plugins                        + canary prompt (expected leak;
 *                  documents the deployment boundary, NOT a product failure)
 *   C7 deidentify   sensitive-guard {mode:"redact",
 *                  deidentify:true} + email-twice prompt (issue #20 trial:
 *                  stable per-session [SG-EMAIL-… placeholders, no canary)
 *   C8 ignore       sensitive-guard {mode:"redact"} + canary prompt carrying
 *                  '// sg-ignore' on the same line (in-text ignore directives
 *                  must not bypass the model boundary)
 *
 * Safety: all canaries are synthetic (example-test.invalid / sk-CANARYTEST…),
 * every case runs in a fresh workdir with XDG_DATA_HOME / XDG_STATE_HOME /
 * XDG_CACHE_HOME / XDG_CONFIG_HOME redirected into it, so the user's real
 * OpenCode state and credentials are never touched. No real secrets.
 *
 * Usage: node scripts/e2e/run-boundary.mjs [--only=C1,C4a]
 * Env:   OPENCODE_BIN (default ~/.opencode/bin/opencode, then PATH)
 *        E2E_TIMEOUT_MS (default 240000), E2E_PRINT_LOGS=1 (adds --print-logs)
 */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(E2E_DIR, "..", "..");
const OUT_DIR = path.join(E2E_DIR, "out");
const CAPTURED_DIR = path.join(OUT_DIR, "captured");
// Case workdirs live OUTSIDE the repo: OpenCode's config discovery walks up from
// cwd, and a repo-internal workdir would pick up this repo's own `.opencode/`
// directory (plugins, worktree state), contaminating or stalling the runs.
const WORK_ROOT = path.join(os.tmpdir(), "sensitive-guard-e2e-work");
const LOGS_DIR = path.join(OUT_DIR, "logs");
const EVIDENCE_PATH = path.join(OUT_DIR, "evidence.json");
const SERVER_SCRIPT = path.join(E2E_DIR, "capture-server.mjs");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const INJECTOR_DIR = path.join(E2E_DIR, "fixtures", "second-plugin");

const RUN_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 240000);
const SETTLE_MS = 2500; // window after process exit for trailing requests

// ---------------------------------------------------------------- canaries --
const CANARIES = [
  { key: "email-alice", value: "alice.canary@example-test.invalid" },
  { key: "email-bob", value: "bob.canary@example-test.invalid" },
  { key: "email-carol", value: "carol.injector@example-test.invalid" },
  { key: "high-key", value: "sk-CANARYTEST1234567890abcdef" },
];
const MARKERS = {
  blockedNotice: "[Sensitive Guard blocked",
  redacted: "[REDACTED_",
  deidentified: "[SG-EMAIL-",
  secondPluginMarker: "SECOND-PLUGIN-MARKER",
};
const CANARY_PROMPT =
  "Contact alice.canary@example-test.invalid and bob.canary@example-test.invalid about sk-CANARYTEST1234567890abcdef rotation.";

// ------------------------------------------------------------------ cases --
const CASES = [
  {
    id: "C1-block",
    description: "block mode: canary prompt must never reach provider; block notice must",
    plugins: [{ package: DIST_DIR, options: { mode: "block" } }],
    prompt: CANARY_PROMPT,
    expectation: (r) =>
      r.canariesInProviderRequests.length === 0 && r.markersInProviderRequests.blockedNotice.length > 0
        ? { verdict: "pass", reason: "no canary in any provider request; block notice present" }
        : { verdict: "fail", reason: "canary leaked or block notice missing" },
  },
  {
    id: "C2-redact",
    description: "redact mode: canary prompt must never reach provider; [REDACTED_ must",
    plugins: [{ package: DIST_DIR, options: { mode: "redact" } }],
    prompt: CANARY_PROMPT,
    expectation: (r) =>
      r.canariesInProviderRequests.length === 0 && r.markersInProviderRequests.redacted.length > 0
        ? { verdict: "pass", reason: "no canary in any provider request; redaction marker present" }
        : { verdict: "fail", reason: "canary leaked or redaction marker missing" },
  },
  {
    id: "C3-tool-output",
    description:
      "tool output: read notes.txt (contains canaries) via forced tool_call; tool output scrubbed in request 2+",
    plugins: [{ package: DIST_DIR, options: { mode: "redact" } }],
    prompt: "Read the file notes.txt and summarize it.",
    notesFile: true,
    control: { label: "C3-tool-output", toolCallNext: true, toolName: "read", toolArgs: { path: "notes.txt" } },
    expectation: (r) => {
      const mainReqs = r.requests.filter((q) => q.hasTools);
      const firstMain = mainReqs[0];
      const later = mainReqs.slice(1); // requests carrying the tool result back
      if (!firstMain)
        return { verdict: "observe", reason: "no tools-bearing (main agent) request observed; inspect out/logs" };
      if (later.length === 0)
        return { verdict: "observe", reason: "tool round-trip did not happen (no follow-up main request); inspect tool name/args in out/logs" };
      if (later.some((q) => q.canaries.length > 0))
        return { verdict: "fail", reason: "canary present in tool-result request (tool output not scrubbed)" };
      const scrubbed = later.some((q) => q.markers.includes("redacted") || q.markers.includes("blockedNotice"));
      return scrubbed
        ? { verdict: "pass", reason: "no canary in tool-result request; scrub marker present" }
        : { verdict: "observe", reason: "no canary in tool-result request but no scrub marker either (tool may have errored before output contained canaries)" };
    },
  },
  {
    id: "C4a-order1",
    description: "plugin order [sensitive-guard(redact), canary-injector]: does injected canary reach provider?",
    plugins: [
      { package: DIST_DIR, options: { mode: "redact" } },
      { package: INJECTOR_DIR },
    ],
    prompt: "Say hi.",
    control: { label: "C4a-order1" },
    expectation: (r) => ({
      verdict: "observe",
      reason: r.injectedCanaryReachedProvider
        ? "carol canary REACHED provider (guard did not scrub later plugin's injection with this order)"
        : "carol canary did NOT reach provider",
    }),
  },
  {
    id: "C4b-order2",
    description: "plugin order [canary-injector, sensitive-guard(redact)]: does injected canary reach provider?",
    plugins: [
      { package: INJECTOR_DIR },
      { package: DIST_DIR, options: { mode: "redact" } },
    ],
    prompt: "Say hi.",
    control: { label: "C4b-order2" },
    expectation: (r) => ({
      verdict: "observe",
      reason: r.injectedCanaryReachedProvider
        ? "carol canary REACHED provider (guard did not scrub earlier plugin's injection with this order)"
        : "carol canary did NOT reach provider",
    }),
  },
  {
    id: "C5-invalid-options",
    description: "invalid options {mode:\"bogus\"}: fail-closed — no canary may reach provider",
    plugins: [{ package: DIST_DIR, options: { mode: "bogus" } }],
    prompt: CANARY_PROMPT,
    expectation: (r) =>
      r.canariesInProviderRequests.length === 0
        ? {
            verdict: "pass",
            reason:
              r.requests.length === 0
                ? "fail-closed: no provider request made at all"
                : "fail-closed: requests made but no canary present",
          }
        : { verdict: "fail", reason: "canary leaked despite invalid options (fail-open!)" },
  },
  {
    id: "C6-absent",
    description: "no plugin (deployment boundary documentation): canary EXPECTED to reach provider",
    plugins: [],
    prompt: CANARY_PROMPT,
    expectation: (r) =>
      r.canariesInProviderRequests.length > 0
        ? { verdict: "expected-leak", reason: "canary reached provider — documents that absence of the plugin is unprotected" }
        : { verdict: "unexpected", reason: "canary did NOT reach provider without plugin — harness or host config issue (check for global plugins)" },
  },
  {
    id: "C7-deidentify",
    description:
      "deidentify trial (issue #20): {mode:\"redact\",deidentify:true}; alice×2 → one stable [SG-EMAIL-… placeholder, bob → a different one; no canary reaches provider",
    plugins: [{ package: DIST_DIR, options: { mode: "redact", deidentify: true } }],
    prompt:
      "Email alice.canary@example-test.invalid twice: alice.canary@example-test.invalid and bob.canary@example-test.invalid once, plus key sk-CANARYTEST1234567890abcdef.",
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider despite de-identification" };
      if (r.requests.length === 0)
        return { verdict: "observe", reason: "no provider request observed; inspect out/logs" };
      // Aggregate [SG-EMAIL-<16 hex>] placeholder occurrences across requests.
      const totals = {};
      for (const q of r.requests)
        for (const [ph, n] of Object.entries(q.placeholderCounts ?? {}))
          totals[ph] = (totals[ph] ?? 0) + n;
      const distinct = Object.keys(totals);
      if (distinct.length < 2)
        return { verdict: "fail", reason: `expected ≥2 distinct [SG-EMAIL-… placeholders (alice+bob), saw ${distinct.length}` };
      const stable = distinct.filter((ph) => totals[ph] >= 2);
      if (stable.length < 1)
        return { verdict: "fail", reason: "no placeholder value repeated ≥2 times — alice's two occurrences did not map to one stable per-session placeholder" };
      return {
        verdict: "pass",
        reason: `no canary in any provider request; ${distinct.length} distinct [SG-EMAIL-… placeholders with ≥1 stable across repeats`,
      };
    },
  },
  {
    id: "C8-ignore-bypass",
    description:
      "in-text ignore directives must not bypass the model boundary: {mode:\"redact\"} + canary prompt carrying '// sg-ignore' on the same line (regression guard for the fail-open fix)",
    plugins: [{ package: DIST_DIR, options: { mode: "redact" } }],
    prompt:
      "bob.canary@example-test.invalid // sg-ignore plus sk-CANARYTEST1234567890abcdef on the same ignored line",
    expectation: (r) =>
      r.canariesInProviderRequests.length === 0
        ? { verdict: "pass", reason: "no canary in any provider request despite the in-text ignore directive" }
        : { verdict: "fail", reason: "canary leaked to provider via in-text ignore directive (fail-open bypass)" },
  },
];

// ------------------------------------------------------------- utilities --
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function opencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const homeCandidate = path.join(os.homedir(), ".opencode", "bin", "opencode");
  if (existsSync(homeCandidate)) return homeCandidate;
  return "opencode";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

async function postControl(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`control endpoint ${res.status}`);
}

/** Scan dir recursively for canary values. Returns [{canary, file}]. */
function scanDirForCanaries(dir, { exclude = () => false } = {}) {
  const hits = [];
  if (!existsSync(dir)) return hits;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (exclude(p)) continue;
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile()) {
        let content;
        try {
          if (statSync(p).size > 2 * 1024 * 1024) continue; // skip very large files
          content = readFileSync(p, "utf8");
        } catch {
          continue;
        }
        for (const c of CANARIES) {
          if (content.includes(c.value)) hits.push({ canary: c.key, file: p });
        }
      }
    }
  };
  walk(dir);
  return hits;
}

function buildConfig(caseDef, port) {
  // OpenCode v2.0.19 schema: `providers` (plural) with `package` + `settings`.
  // Verified against packages/schema/src/config/provider.ts @ v2.0.19.
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
        models: { "capture-1": { name: "Capture 1" } },
      },
    },
    plugins: caseDef.plugins,
  };
}

// ------------------------------------------------------------- case runner --
async function runCase(caseDef, port) {
  const workdir = path.join(WORK_ROOT, caseDef.id);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  for (const sub of ["data", "state", "cache", "config"]) {
    mkdirSync(path.join(workdir, sub), { recursive: true });
  }
  // Config must sit at the GLOBAL config path ($XDG_CONFIG_HOME/opencode/opencode.json).
  // A bare <workdir>/opencode.json is NOT loaded by `opencode run --standalone` in
  // v2.0.19 (the standalone server's config discovery never picked it up in probes).
  const globalConfigDir = path.join(workdir, "config", "opencode");
  mkdirSync(globalConfigDir, { recursive: true });
  writeFileSync(path.join(globalConfigDir, "opencode.json"), JSON.stringify(buildConfig(caseDef, port), null, 2));
  if (caseDef.notesFile) {
    writeFileSync(
      path.join(workdir, "notes.txt"),
      `Contact list (synthetic test data):\n- alice.canary@example-test.invalid\n- bob.canary@example-test.invalid\nRotation key: sk-CANARYTEST1234567890abcdef\n`,
    );
  }
  if (caseDef.control) await postControl(port, caseDef.control);

  // Scrub host-session contamination: OPENCODE_* / OPENCHAMBER_* vars (notably
  // OPENCODE_CONFIG pointing at a desktop-managed config with global plugins)
  // would otherwise leak the host's config and plugins into these runs.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(OPENCODE_|OPENCHAMBER_)/.test(key)) continue;
    env[key] = value;
  }
  env.CAPTURE_API_KEY = "sg-e2e-capture";
  // `opencode run --standalone` re-spawns helper processes via PATH; the host
  // session's PATH may not contain the opencode bin dir, so prepend it.
  const binDir = path.dirname(path.resolve(opencodeBin()));
  env.PATH = `${binDir}${path.delimiter}${env.PATH ?? ""}`;
  env.XDG_DATA_HOME = path.join(workdir, "data");
  env.XDG_STATE_HOME = path.join(workdir, "state");
  env.XDG_CACHE_HOME = path.join(workdir, "cache");
  env.XDG_CONFIG_HOME = path.join(workdir, "config");

  const args = ["run", "--standalone", "--format", "json", "--model", "capture/capture-1"];
  if (process.env.E2E_PRINT_LOGS === "1") args.push("--print-logs");
  args.push(caseDef.prompt);

  const startedAt = Date.now();
  let timedOut = false;
  // stdin 'ignore': a piped-open stdin makes `opencode run` wait for EOF and hang.
  const child = spawn(opencodeBin(), args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await sleep(SETTLE_MS); // let trailing requests land inside the window
  const windowEnd = Date.now();

  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.stdout.txt`), stdout);
  writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.stderr.txt`), stderr);

  // ---- attribute raw captures to this case by time window, rename in place --
  const attributed = [];
  for (const name of readdirSync(CAPTURED_DIR)) {
    if (!name.startsWith("raw-")) continue;
    const p = path.join(CAPTURED_DIR, name);
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (envelope.receivedAt >= startedAt && envelope.receivedAt <= windowEnd) {
      envelope.case = caseDef.id;
      envelope.caseWindow = { start: startedAt, end: windowEnd };
      const target = path.join(CAPTURED_DIR, `${caseDef.id}-${envelope.seq}.json`);
      writeFileSync(target, JSON.stringify(envelope, null, 2));
      if (!existsSync(p) || p !== target) rmSync(p, { force: true });
      attributed.push(envelope);
    }
  }
  attributed.sort((a, b) => a.seq - b.seq);

  // ---- analyze provider request bodies --
  // OpenCode fires a title-generation request (no `tools` array) alongside the
  // main agent request (with `tools`); both are captured and both are leak
  // channels, so all requests are scanned for canaries.
  const requests = attributed.map((e) => {
    const s = JSON.stringify(e.body);
    const placeholderCounts = {};
    let m;
    const placeholderRe = /\[SG-EMAIL-([0-9a-f]{16})\]/g;
    while ((m = placeholderRe.exec(s)) !== null) {
      placeholderCounts[m[1]] = (placeholderCounts[m[1]] ?? 0) + 1;
    }
    return {
      seq: e.seq,
      hasTools: Array.isArray(e.body?.tools) && e.body.tools.length > 0,
      file: path.basename(CAPTURED_DIR) + "/" + `${caseDef.id}-${e.seq}.json`,
      canaries: CANARIES.filter((c) => s.includes(c.value)).map((c) => c.key),
      markers: Object.entries(MARKERS)
        .filter(([, v]) => s.includes(v))
        .map(([k]) => k),
      placeholderCounts,
    };
  });
  const canariesInProviderRequests = requests.flatMap((q) =>
    q.canaries.map((c) => ({ canary: c, file: q.file })),
  );
  const markersInProviderRequests = {};
  for (const mk of Object.keys(MARKERS)) {
    markersInProviderRequests[mk] = requests.filter((q) => q.markers.includes(mk)).map((q) => q.file);
  }

  // ---- scan isolated storage / logs / cache --
  // Session storage lives under XDG_DATA_HOME/opencode (minus its log/ subdir);
  // opencode also writes data/opencode/log/opencode.log and XDG_STATE_HOME.
  const isLogPath = (p) => p.includes(`${path.sep}log`);
  const sessionStorageHits = scanDirForCanaries(path.join(workdir, "data"), { exclude: isLogPath });
  const logHits = [
    ...scanDirForCanaries(path.join(workdir, "state")),
    ...scanDirForCanaries(path.join(workdir, "data"), { exclude: (p) => !isLogPath(p) }),
  ];
  const cacheHits = scanDirForCanaries(path.join(workdir, "cache"));

  const stdoutCanaries = CANARIES.filter((c) => stdout.includes(c.value)).map((c) => c.key);  const result = {
    case: caseDef.id,
    description: caseDef.description,
    exitCode,
    timedOut,
    requestCount: requests.length,
    requests,
    canariesInProviderRequests,
    markersInProviderRequests,
    injectedCanaryReachedProvider: canariesInProviderRequests.some((h) => h.canary === "email-carol"),
    sessionStorageHits,
    logHits,
    cacheHits,
    stdoutCanaries,
    workdir,
  };
  const { verdict, reason } = caseDef.expectation(result);
  result.verdict = verdict;
  result.expectation = reason;
  result.notes = [
    timedOut ? "run timed out and was killed" : null,
    exitCode !== 0 ? `opencode exited ${exitCode}; see out/logs/${caseDef.id}.stderr.txt` : null,
  ].filter(Boolean);
  return result;
}

// ------------------------------------------------------------------- main --
async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice(7).split(",").map((s) => s.trim()) : null;
  const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;

  if (!existsSync(path.join(DIST_DIR, "index.js"))) {
    console.error(`ERROR: ${DIST_DIR}/index.js not found. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const bin = opencodeBin();
  let opencodeVersion = "unknown";
  try {
    opencodeVersion = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    console.error(`ERROR: could not run ${bin} --version: ${err.message}`);
    process.exit(1);
  }
  let gitRev = "unknown";
  try {
    gitRev = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {}

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(CAPTURED_DIR, { recursive: true });
  mkdirSync(WORK_ROOT, { recursive: true });

  // Start capture server (retry on port races).
  let server = null;
  let port = 0;
  for (let attempt = 0; attempt < 3 && !server; attempt++) {
    port = await freePort();
    const child = spawn(process.execPath, [SERVER_SCRIPT, String(port)], {
      env: { ...process.env, CAPTURE_DIR: CAPTURED_DIR },
      stdio: ["ignore", "pipe", "pipe"], // piped (and consumed) so the child never shares our stdout/stderr
    });
    child.stdout.on("data", (d) => console.error(`  [capture-server] ${d.toString().trim()}`));
    child.stderr.on("data", (d) => console.error(`  [capture-server:err] ${d.toString().trim()}`));
    const ready = await waitForHealth(port);
    if (ready) {
      server = child;
      break;
    }
    child.kill("SIGKILL");
  }
  if (!server) {
    console.error("ERROR: capture server failed to start");
    process.exit(1);
  }

  const results = [];
  const writeEvidence = (final) => {
    const unattributedSoFar = existsSync(CAPTURED_DIR)
      ? readdirSync(CAPTURED_DIR).filter((f) => f.startsWith("raw-"))
      : [];
    const evidence = {
      generatedAt: new Date().toISOString(),
      final,
      opencodeVersion,
      gitRev,
      modelRef: "capture/capture-1",
      provider: "@opencode/ai/providers/openai-compatible @ http://127.0.0.1:" + port + "/v1",
      canaries: CANARIES,
      markers: MARKERS,
      unattributedCaptures: unattributedSoFar,
      cases: results,
    };
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
  };
  try {
    for (const caseDef of cases) {
      console.error(`→ ${caseDef.id}: ${caseDef.description}`);
      let result;
      try {
        result = await runCase(caseDef, port);
      } catch (err) {
        result = {
          case: caseDef.id,
          description: caseDef.description,
          verdict: "error",
          expectation: String(err?.message ?? err),
          notes: ["case runner threw"],
        };
      }
      results.push(result);
      writeEvidence(false); // incremental: a crash later must not lose earlier evidence
      const leak = result.canariesInProviderRequests?.length ?? "n/a";
      console.error(
        `  exit=${result.exitCode ?? "?"} reqs=${result.requestCount ?? 0} canaryLeaks=${leak} verdict=${result.verdict}`,
      );
    }
  } finally {
    if (server) {
      server.kill("SIGTERM");
      const killTimer = setTimeout(() => server.kill("SIGKILL"), 1500);
      killTimer.unref?.();
    }
  }

  const unattributed = readdirSync(CAPTURED_DIR).filter((f) => f.startsWith("raw-"));
  writeEvidence(true);

  // ---- compact human summary ----
  const w = (s, n) => String(s).slice(0, n).padEnd(n);
  console.log(`\n${opencodeVersion} @ ${gitRev.slice(0, 10)}  model=capture/capture-1  cases=${results.length}`);
  console.log(w("case", 20) + w("exit", 6) + w("reqs", 5) + w("leaks", 6) + w("verdict", 14) + "finding");
  console.log("-".repeat(100));
  for (const r of results) {
    const leaks = r.canariesInProviderRequests ? r.canariesInProviderRequests.length : "?";
    console.log(
      w(r.case, 20) +
        w(r.exitCode ?? "-", 6) +
        w(r.requestCount ?? "-", 5) +
        w(leaks, 6) +
        w(r.verdict, 14) +
        (r.expectation ?? ""),
    );
  }
  const storageHits = results.reduce((n, r) => n + (r.sessionStorageHits?.length ?? 0), 0);
  const logHitCount = results.reduce((n, r) => n + (r.logHits?.length ?? 0), 0);
  console.log("-".repeat(100));
  console.log(`storage canary hits: ${storageHits}   log canary hits: ${logHitCount}   unattributed captures: ${unattributed.length}`);
  console.log(`evidence: ${EVIDENCE_PATH}`);
  process.exit(0); // undici keep-alive sockets and child pipes must not hold the loop open
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Issue #22 recovery probe (handoff-22) — RUNTIME BLOCKED BY DEFAULT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * OFFLINE AUTHORIZATION (2026-09-30, handoff-22 "Current authorization"):
 * correction of runner/fixture safety defects and plugin-specific assertions
 * ONLY. The runtime mode of this runner is BLOCKED and FAILS CLOSED. There is
 * intentionally NO CLI flag that re-enables it: unlocking requires editing
 * RUNTIME_UNLOCKED below together with independently documented (1) exclusive
 * `--server` targeting WITH a verified API-token propagation mechanism and
 * no-fallback proof, (2) a confinement profile with endpoint-scoped networking
 * and bounded reads verified on this host, (3) a canonical SQLite query shape
 * verified against the installed runtime schema, and (4) the user's explicit
 * approval recorded in this file. The 2026-09-30 incident (an unconfined
 * `opencode run --server` fell back to the user's live background service and
 * provider) is the reason this gate exists; see handoff-22.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Modes:
 *   (default)          prints the RUNTIME BLOCKED notice and a matrix whose
 *                      every control is not-run; exit code 4. Zero filesystem
 *                      writes, zero subprocesses, zero network — the gate sits
 *                      before any side-effectful call and the runtime body is
 *                      additionally guarded internally (defense in depth).
 *   --offline          SELF-CONTAINED validation suite ONLY (this round's
 *                      authorized check): pure functions + synthetic
 *                      in-memory Request/Response + fake contexts/mocks. No
 *                      fs writes, no spawn, no network, no OpenCode. Exit 0/1.
 *   --dump-legacy-cases  prints the source-repaired legacy case definitions
 *                      (stdout only). Legacy A–E/P remain historical: their
 *                      old broad run results are NOT success evidence.
 *
 * The runtime body below p1–p7/R1–R4b is retained SOURCE-REPAIRED per the
 * final oracle defect list (quarantined behind the gate, unexecuted):
 *   - canonical session directory is asserted BEFORE arming/executing
 *   - p7 effective-config validation is fail-closed: fetch failure fails,
 *     consumed config compared by CANONICAL path, exact provider/plugin set,
 *     the single capture provider validated as the EXACT generated profile
 *     (package/env list/synthetic credential/mandatory baseURL equal to the
 *     loopback capture endpoint incl. scheme/host/port/path, no userinfo,
 *     http(s) only), schema hosts allowed ONLY inside $schema (checked
 *     against the exact expected URL), no auth-ish keys anywhere except the
 *     generated synthetic apiKey, no unknown provider/plugin/settings
 *     fields, and case-insensitive URL scheme detection across the document
 *   - provenance hashes the CONSUMED config file, not the evidence copy
 *   - malformed capture/event evidence FAILS instead of being discarded
 *   - broad SQLite table scans removed; canonical persistence is UNKNOWN
 *     (exit 3) until a canonical query is verified against installed schema
 *   - `opencode --version` and the capture server no longer run with the
 *     inherited host environment (isolated env)
 *   - CLI fallback surface gated: without a verified API-token mechanism the
 *     `opencode run --server` invocation is refused before spawn
 *   - sandbox profile marked UNVERIFIED (localhost:* broad allow + default
 *     reads) and cannot gate a run until endpoint scoping is verified
 *   - R4a correlates the EXACT armed shell CALL+MESSAGE identifiers across
 *     the before event, the permission SOURCE ({type:"tool",id,messageID}
 *     per installed declarations), the deny action/effect/restored resource,
 *     and a permission-attributed error on the SAME call, plus absence of
 *     receipts — an unrelated read denial or unrelated shell error cannot
 *     pass it; missing attribution is nonsuccess; no runtime-ordering
 *     inference; R1 requires the nonce in the SUCCESSFUL read result, not
 *     just in an error; CLI exit success is never plugin success
 *   - rebuilt outbound requests PRESERVE the original transport controls
 *     (redirect/credentials/abort signal) — only body/headers are replaced
 *   - the runner entrypoint is guarded (importing it runs NOTHING) and pure
 *     validators are exported via __probeRunnerInternals
 *
 * All values synthetic. Historical evidence under scripts/e2e/out/ preserved.
 *
 * Usage: node scripts/e2e/run-restoration-probe.mjs [--offline]
 *                                             [--dump-legacy-cases]
 * Env:   PROBE_TIMEOUT_MS (quarantined runtime only; default 120000)
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(E2E_DIR, "..", "..");
const SERVER_SCRIPT = path.join(E2E_DIR, "capture-server.mjs");
const FIXTURE_DIR = path.join(E2E_DIR, "fixtures", "restoration-probe");
const FIXTURE_INDEX = path.join(FIXTURE_DIR, "index.js");
const RUNNER_SELF = fileURLToPath(import.meta.url);
const OUT_ROOT = path.join(E2E_DIR, "out");
const PREFERRED_TMP = path.join(os.tmpdir(), "opencode");
const TMP_ROOT = existsSync(PREFERRED_TMP) ? PREFERRED_TMP : os.tmpdir();
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SQLITE3 = "/usr/bin/sqlite3";

const RUN_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 120000);
const SERVE_HEALTH_MS = 30000;
const SETTLE_MS = 3500;
const KILL_GRACE_MS = 4000;
const MODEL_REF = "capture/capture-1";

// Synthetic mapping constants — must stay in sync with the fixture plugin.
const ORIG_EMAIL = "alice.probe@example-test.invalid";
const ORIG_KEY = "sk-PROBETEST1234567890abcdef";
const PH_KEY = "[SGPROBE-KEY-1]";
const PH_PATH = "[SGPROBE-PATH-1]";
const R1_NONCE = "R1-NONCE-7f3d9c21";
const R1_FILE = "nonce-r1-original.txt";
const R2_RECEIPT = "R2-RECEIPT-4b81";
const R3_MARKER = "SGPROBE-R3-REFUSED";
const R4A_RECEIPT = "R4A-RECEIPT-5d07";
const R4B_RECEIPT = "R4B-RECEIPT-2e94";
const C_MARKER = "RESTORE-C-AFTER";
const B_THROW = "SGPROBE-B-THROW";
const E_THROW = "SGPROBE-E-THROW";

// ═══════════════════════════ runtime gate (fail-closed) ═════════════════════
// RUNTIME_UNLOCKED is deliberately a SOURCE constant, not a flag. Flipping it
// without the documented prerequisites below would be an unauthorized
// re-enable, not a safety proof. Required before it may ever become true:
//   1. exclusive `--server` targeting WITH a VERIFIED API-token propagation
//      mechanism and runtime no-fallback proof (the 2026-09-30 incident showed
//      an unauthenticated `opencode run --server` can silently fall back to
//      the user's live background service and provider);
//   2. a confinement profile with ENDPOINT-SCOPED loopback networking and
//      bounded reads, verified enforced on this host (see
//      SANDBOX_ENDPOINT_SCOPING_VERIFIED);
//   3. a canonical session/message/part SQLite query verified against the
//      installed runtime schema (see CANONICAL_SQL_VERIFIED);
//   4. explicit user approval recorded in this file with date and evidence.
const RUNTIME_UNLOCKED = false;
const RUNTIME_BLOCKED_EXIT = 4;
const RUNTIME_UNRESOLVED = [
  "exclusive --server targeting: no verified API-token propagation mechanism for `opencode run --server`; an unauthenticated CLI invocation can silently fall back to the user's live background service (2026-09-30 incident)",
  "sandbox profile UNVERIFIED for endpoint scoping: SBPL network allow is localhost:* (ALL loopback ports) with default-allow reads; per-endpoint syntax is not verified on this host",
  "canonical stored-message SQLite query not verified against the installed runtime schema this round; persistence acceptance stays UNKNOWN (exit 3), never a broad table scan",
];
// Quarantined-runtime sub-gates (each independently fail-closed):
const SANDBOX_ENDPOINT_SCOPING_VERIFIED = false; // broad localhost:* profile cannot gate a run
const CLI_TOKEN_MECHANISM_VERIFIED = false; // CLI spawn refused without a verified token mechanism
const CANONICAL_SQL_VERIFIED = false; // canonical persistence checks yield explicit UNKNOWN

// ────────────────────────── pure validation helpers ─────────────────────────
// (used by the quarantined runtime AND by the --offline suite; no I/O)

/**
 * Normalize a URL to an `hostname:port` endpoint (port omitted when it is the
 * scheme default). Returns null for unparseable input. NOTE: this fixes the
 * old `new URL(u).host`-vs-hostname mismatch (host includes the port, so
 * allowlisting hostnames by `host` compared wrong for any URL with a port).
 */
function normalizeEndpoint(u) {
  try {
    const parsed = new URL(String(u));
    const port = parsed.port ? `:${parsed.port}` : "";
    return `${parsed.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}

/**
 * Allowed endpoints for config-containment URL scanning: the EXACT capture
 * server endpoints (loopback + exact port) and nothing else. Schema/doc
 * identifier hosts are NOT general endpoints (handoff-22 offline-oracle fix
 * #1): the old set let a provider baseURL of `https://opencode.ai/...` pass
 * containment. A schema host is allowed ONLY inside the `$schema` field,
 * which validateConsumedConfig checks separately against the EXACT expected
 * schema URL. Non-loopback providers, proxies, or any external endpoint fail.
 */
function allowedEndpointsFor(capturePort) {
  return new Set([`127.0.0.1:${capturePort}`, `localhost:${capturePort}`]);
}

/**
 * Key names whose presence in the CONSUMED effective config would indicate an
 * auth source the harness did not generate. The installed @opencode config
 * document schema declares no top-level auth field, so ANY of these is
 * unexpected (fail-closed).
 */
const AUTH_ISH_KEY_RE = /^(auth|authorization|api_?key|apikey|token|password|credential)s?$/i;

/**
 * Parse a URL into EXACT endpoint comparison parts. Returns null when
 * unparseable. Scheme/hostname comparison is done on URL-parsed (lowercased)
 * values — i.e. case-insensitively via URL, by construction (offline-oracle
 * fix #1: `HTTPS://EVIL` schemes must not slip past a case-sensitive scan).
 */
function endpointParts(u) {
  try {
    const p = new URL(String(u));
    return {
      protocol: p.protocol,
      hostname: p.hostname,
      port: p.port,
      pathname: p.pathname,
      search: p.search,
      hash: p.hash,
      username: p.username,
      password: p.password,
    };
  } catch {
    return null;
  }
}

/**
 * Fail-closed STRUCTURAL validation of the CONSUMED effective config (from
 * GET /api/config) against the harness's OWN generated capture profile
 * (buildConfig) — NOT a generic V2 config parser and NO invented schema
 * assumptions. Requires (handoff-22 offline-oracle fix #1):
 *   - failed/missing documents FAIL (fetchFailed / non-object);
 *   - exactly the expected provider set and plugin set;
 *   - the single capture provider in EXACTLY the generated field shape:
 *     exact `package`, exact `env` list, synthetic `settings.apiKey`, and a
 *     MANDATORY `settings.baseURL` equal to the expected loopback capture
 *     endpoint EXACTLY — scheme, hostname, port and path all compared, no
 *     query/hash drift, http(s) only, NO userinfo. A missing endpoint, an
 *     endpoint equal to a schema host, an uppercase-scheme external URL, a
 *     non-http scheme or an embedded credential all FAIL;
 *   - the single fixture plugin with exactly `{ package, options }` and
 *     options exactly `{ scenario }`;
 *   - `$schema` (when present) must equal the expected schema URL — schema
 *     hosts are allowed ONLY in that field, nowhere else;
 *   - no auth-ish key anywhere in providers/plugins EXCEPT the generated
 *     synthetic `settings.apiKey`; no unknown provider/plugin/settings
 *     fields; top-level auth-ish keys fail;
 *   - no other http(s) URL anywhere in the document (case-insensitive scheme
 *     detection), every URL confined to the EXACT capture endpoints.
 * Pure — offline-testable with fake documents.
 */
function validateConsumedConfig(
  consumed,
  {
    fetchFailed = false,
    expectedProviders,
    expectedPluginPackage,
    expectedScenario,
    expectedProviderPackage,
    expectedProviderEnv,
    expectedSyntheticApiKey,
    expectedCaptureEndpoint,
    expectedSchemaUrl,
    allowedEndpoints,
  },
) {
  const reasons = [];
  if (fetchFailed) reasons.push("config fetch failed (fail-closed: a missing effective config is not containment)");
  if (!consumed || typeof consumed !== "object") {
    reasons.push("consumed config is not an object");
    return { ok: false, reasons };
  }

  // $schema: the ONLY field allowed to reference a schema host, and only the
  // exact expected URL.
  if (consumed.$schema !== undefined && consumed.$schema !== expectedSchemaUrl) {
    reasons.push(
      `$schema must be exactly ${JSON.stringify(expectedSchemaUrl)}, got ${JSON.stringify(consumed.$schema)} (schema hosts are allowed ONLY in $schema)`,
    );
  }

  // ── providers: the EXACT generated capture profile ──────────────────────
  const providers = consumed.providers ?? {};
  const providerKeys = Object.keys(providers).sort();
  const expectedProviderKeys = [...(expectedProviders ?? [])].sort();
  if (JSON.stringify(providerKeys) !== JSON.stringify(expectedProviderKeys)) {
    reasons.push(`provider set mismatch: got [${providerKeys}] expected [${expectedProviderKeys}]`);
  }
  const captureKey = expectedProviderKeys[0];
  const prov = captureKey != null ? providers[captureKey] : null;
  if (!prov || typeof prov !== "object") {
    reasons.push(`capture provider ${JSON.stringify(captureKey)} missing or not an object (mandatory generated profile)`);
  } else {
    const allowedProviderFields = new Set(["name", "env", "package", "settings", "models"]);
    for (const k of Object.keys(prov)) {
      if (!allowedProviderFields.has(k)) {
        reasons.push(`provider field outside generated shape: ${captureKey}.${k}`);
      }
    }
    if (prov.package !== expectedProviderPackage) {
      reasons.push(`provider package mismatch: got ${JSON.stringify(prov.package)} expected ${JSON.stringify(expectedProviderPackage)}`);
    }
    const envGot = Array.isArray(prov.env) ? [...prov.env].sort() : null;
    const envWant = [...(expectedProviderEnv ?? [])].sort();
    if (JSON.stringify(envGot) !== JSON.stringify(envWant)) {
      reasons.push(`provider env mismatch: got ${JSON.stringify(prov.env)} expected ${JSON.stringify(expectedProviderEnv)}`);
    }
    const settings = prov.settings && typeof prov.settings === "object" && !Array.isArray(prov.settings) ? prov.settings : null;
    if (!settings) {
      reasons.push("provider settings object missing (mandatory generated shape)");
    } else {
      for (const k of Object.keys(settings)) {
        if (k !== "baseURL" && k !== "apiKey") {
          reasons.push(`provider settings field outside generated shape: ${captureKey}.settings.${k}`);
        }
      }
      if (settings.apiKey !== expectedSyntheticApiKey) {
        reasons.push("provider synthetic credential mismatch: settings.apiKey must be the harness-generated synthetic value (missing or non-synthetic credentials FAIL)");
      }
      // MANDATORY endpoint, EXACT match incl. scheme/hostname/port/path, no
      // userinfo, http(s) only (case-insensitive scheme via URL parsing).
      const want = endpointParts(expectedCaptureEndpoint);
      const got = typeof settings.baseURL === "string" ? endpointParts(settings.baseURL) : null;
      if (!want) throw new Error("internal: expectedCaptureEndpoint unparseable");
      if (!got) {
        reasons.push(`provider endpoint missing/unparseable (mandatory): ${JSON.stringify(settings.baseURL)}`);
      } else {
        if (got.protocol !== "http:" && got.protocol !== "https:") {
          reasons.push(`provider endpoint scheme must be http(s): got ${got.protocol}`);
        }
        if (got.username !== "" || got.password !== "") {
          reasons.push(`provider endpoint must not carry userinfo: got ${got.username ? "username" : ""}${got.password ? "password" : ""}`);
        }
        for (const part of ["protocol", "hostname", "port", "pathname", "search", "hash"]) {
          if (got[part] !== want[part]) {
            reasons.push(
              `provider endpoint ${part} mismatch: got ${JSON.stringify(got[part])} expected ${JSON.stringify(want[part])} (exact loopback capture endpoint required)`,
            );
          }
        }
      }
    }
    if (prov.models !== undefined && (typeof prov.models !== "object" || Array.isArray(prov.models) || prov.models === null)) {
      reasons.push("provider models must be a non-array object when present");
    }
  }

  // ── plugins: exactly the fixture plugin in the generated field shape ────
  const plugins = Array.isArray(consumed.plugins) ? consumed.plugins : [];
  const pluginObjs = plugins.filter((p) => p && typeof p === "object");
  if (plugins.length !== 1 || pluginObjs.length !== 1) {
    reasons.push(`plugin set mismatch: expected exactly the probe fixture plugin, got ${JSON.stringify(plugins)}`);
  } else {
    const p = pluginObjs[0];
    for (const k of Object.keys(p)) {
      if (k !== "package" && k !== "options") {
        reasons.push(`plugin field outside generated shape: plugins[0].${k}`);
      }
    }
    if (p.package !== expectedPluginPackage) {
      reasons.push(`plugin package mismatch: got ${p.package} expected ${expectedPluginPackage}`);
    }
    const opts = p.options && typeof p.options === "object" && !Array.isArray(p.options) ? p.options : null;
    if (!opts) {
      reasons.push("plugin options object missing (mandatory generated shape)");
    } else {
      for (const k of Object.keys(opts)) {
        if (k !== "scenario") {
          reasons.push(`plugin option outside generated shape: plugins[0].options.${k}`);
        }
      }
      if (String(opts.scenario ?? "") !== String(expectedScenario)) {
        reasons.push(`plugin scenario mismatch: got ${JSON.stringify(opts.scenario)} expected ${JSON.stringify(expectedScenario)}`);
      }
    }
  }

  // ── auth-ish keys: top level, plus NESTED anywhere in providers/plugins ──
  // The single carve-out is the generated synthetic credential at
  // `<captureKey>.settings.apiKey`. Nested credentials/authorization data the
  // harness did not generate FAIL (the old check saw only top-level keys).
  const topLevelAuth = Object.keys(consumed).filter((k) => AUTH_ISH_KEY_RE.test(k));
  if (topLevelAuth.length > 0) {
    reasons.push(`unknown auth source key(s) in consumed config: ${topLevelAuth.join(", ")}`);
  }
  const nestedAuthHits = [];
  const walkAuthish = (node, where) => {
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const at = `${where}.${k}`;
      if (AUTH_ISH_KEY_RE.test(k) && at !== `providers.${captureKey}.settings.apiKey`) {
        nestedAuthHits.push(at);
      }
      if (v && typeof v === "object") walkAuthish(v, at);
    }
  };
  walkAuthish(providers, "providers");
  walkAuthish(consumed.plugins ?? [], "plugins");
  if (nestedAuthHits.length > 0) {
    reasons.push(`auth-like key(s) outside the generated synthetic credential: ${nestedAuthHits.join(", ")}`);
  }

  // ── URL confinement scan over the WHOLE document except the $schema field ─
  // Case-INSENSITIVE scheme detection (`HTTPS://EVIL` must be caught; the
  // URL parser then normalizes case for the endpoint comparison). Schema
  // hosts were stripped with $schema, so a provider endpoint equal to a
  // schema host lands in the scan and FAILS.
  const scanDoc = { ...consumed };
  delete scanDoc.$schema;
  const urls = JSON.stringify(scanDoc).match(/https?:\/\/[^"\s]+/gi) ?? [];
  for (const u of urls) {
    const ep = normalizeEndpoint(u);
    if (ep === null || !allowedEndpoints.has(ep)) {
      reasons.push(`endpoint outside allowed set: ${u} (normalized ${ep})`);
    }
  }
  return { ok: reasons.length === 0, reasons, urls: [...new Set(urls)] };
}

/**
 * Parse the plugin event log. Malformed lines are COUNTED and RETURNED — never
 * silently discarded (the old reader demoted them to a sentinel event; the
 * runtime must fail on them instead).
 */
function parseEventLines(text) {
  const events = [];
  const malformed = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed.push(line.slice(0, 120));
    }
  }
  return { events, malformed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

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

class StopError extends Error {
  constructor(stage, reason, detail) {
    super(`${stage}: ${reason}`);
    this.stopInfo = { stage, reason, detail };
  }
}

// ---------------------------------------------------------------- path safety -
function assertRealOwnedChain(target, ownedBelowDir) {
  const real = realpathSync(target);
  const ownedBelow = ownedBelowDir ? realpathSync(ownedBelowDir) : null;
  const parts = real.split(path.sep).filter(Boolean);
  const chain = [];
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}${path.sep}${part}` : `${path.sep}${part}`;
    const st = lstatSync(cur);
    if (st.isSymbolicLink()) {
      throw new Error(`symlink component in containment chain: ${cur}`);
    }
    const below = ownedBelow && (cur === ownedBelow || cur.startsWith(ownedBelow + path.sep));
    if (below && st.uid !== process.getuid()) {
      throw new Error(`component below approved root not owned by current uid: ${cur} (uid=${st.uid})`);
    }
    chain.push({ path: cur, ownedSegment: Boolean(below) });
  }
  return { real, chain };
}

// ------------------------------------------------------------------- sqlite ---
/**
 * Canonical stored-message acceptance is EXPLICITLY UNKNOWN this round
 * (handoff-22 final oracle: the old path ran BROAD table scans over every
 * message|part|session-named table, set its instrumentation marker BEFORE the
 * scoped query succeeded, and could pass with marker-absence). A canonical
 * session/message/part/call-scoped query is NOT guessed from table names and
 * NOT derived by scanning: it must be verified against the installed runtime
 * schema first (installed-declarations analysis only; no DB/auth inspection
 * was authorized). Until then every persistence claim blocks with UNKNOWN
 * (nonzero exit 3) — raw DB/WAL byte material remains forensic-only.
 */
function canonicalStoredMessages(control, sessionID, needles) {
  return {
    control,
    sessionID,
    status: "UNKNOWN",
    reason:
      CANONICAL_SQL_VERIFIED
        ? null
        : "canonical session/message/part query not verified against installed schema this round — persistence acceptance blocked as UNKNOWN (no broad table scans, no table-name guesses; raw DB copies are forensic evidence only)",
    needles: needles ?? [],
  };
}

function findSqliteDbs(roots) {
  const dbs = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.(db|sqlite|sqlite3)$/i.test(e.name)) {
        try {
          dbs.push({ path: p, size: statSync(p).size });
        } catch {}
      }
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  return dbs;
}

// --------------------------------------------------------------- subprocess ---
const SPAWNED_COMMANDS = [];
function spawnTracked(cmd, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolve) => {
    const argv = [cmd, ...args];
    SPAWNED_COMMANDS.push({ label, argv });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ label, argv, pid: child.pid, exitCode: code, timedOut, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ label, argv, pid: child.pid, exitCode: -1, timedOut: false, stdout, stderr: stderr + String(err) });
    });
  });
}

async function killGroup(proc) {
  if (!proc || proc.exitCode !== null) return "already-exited";
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {}
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && proc.exitCode === null) await sleep(150);
  if (proc.exitCode === null) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && proc.exitCode === null) await sleep(100);
  }
  return proc.exitCode === null ? "kill-failed" : "killed";
}

// ------------------------------------------------------------------ sandbox ---
// ⚠️ UNVERIFIED / GATED OFF (handoff-22 final oracle): this profile's network
// allow is `localhost:*` — EVERY loopback port, leaving live local services
// reachable — and the `(allow default)` base permits unrestricted file reads.
// Endpoint-scoped SBPL syntax (a per-port/per-host network allow plus
// read-scope restriction) is NOT verified on this host, and the 2026-09-30
// unconfined-auth-discovery incident makes silent weakening unacceptable.
// SANDBOX_ENDPOINT_SCOPING_VERIFIED === false therefore hard-blocks the
// quarantined runtime: the profile below is retained for forensic reference
// only and must NOT gate any run until a verified endpoint-scoped profile
// replaces it and the flag above is flipped with recorded evidence.
function buildSandboxProfile(rootReal) {
  return `(version 1)
;; UNVERIFIED — forensic reference only, cannot gate a run (see gate note above)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(deny file-write*)
(allow file-write* (subpath "${rootReal}"))
`;
}

// Runs UNDER sandbox-exec; writes its result inside the root (the only place
// the confined process may write). 192.0.2.1 is TEST-NET-1 (RFC 5737): if the
// sandbox denies the connect, no packet leaves the machine.
const PREFLIGHT_SCRIPT = `import net from "node:net";
import fs from "node:fs";
const { spawnSync } = await import("node:child_process");
const [rootReal, portArg, outPath] = process.argv.slice(2);
const res = { pid: process.pid, steps: {} };
const step = (name, fn) => {
  try {
    res.steps[name] = { ok: true, detail: String(fn()) };
  } catch (e) {
    res.steps[name] = { ok: false, code: e?.code ?? null, error: String(e?.message ?? e) };
  }
};
step("write-inside-root", () => {
  fs.writeFileSync(rootReal + "/preflight-inside.txt", "ok");
  return "wrote";
});
step("write-outside-root-must-be-denied", () => {
  fs.writeFileSync("/private/tmp/sgp22-preflight-" + process.pid + ".txt", "x");
  return "UNEXPECTED-SUCCESS";
});
step("read-system-binary", () => {
  const b = fs.readFileSync("/usr/bin/sandbox-exec");
  return "read " + b.length + " bytes";
});
const connect = (host, port, ms) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    const finish = (outcome, err) => {
      try { s.destroy(); } catch {}
      resolve({ outcome, elapsedMs: Date.now() - t0, code: err?.code ?? null, error: err ? String(err?.message ?? err) : null });
    };
    const timer = setTimeout(() => finish("timeout"), ms);
    s.on("connect", () => { clearTimeout(timer); finish("connected"); });
    s.on("error", (e) => { clearTimeout(timer); finish("error", e); });
  });
res.loopback = await connect("127.0.0.1", Number(portArg), 3000);
res.external = await connect("192.0.2.1", 80, 1500);
const ex = spawnSync("/usr/bin/true", [], { timeout: 5000 });
res.exec = { status: ex.status, error: ex.error ? String(ex.error) : null };
fs.writeFileSync(outPath, JSON.stringify(res, null, 2));
`;

// ------------------------------------------------------------------- config ---
function buildConfig() {
  // Schema-verified v2 shape (providers/plugins from @opencode/schema config;
  // permissions are supplied per-session through the documented session API).
  return {
    $schema: "https://opencode.ai/config.json",
    providers: {
      capture: {
        name: "Capture",
        env: ["CAPTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "__CAPTURE_BASE_URL__", apiKey: "sg-e2e-capture" },
        models: { [MODEL_REF.split("/")[1]]: { name: "Capture 1" } },
      },
    },
    plugins: [{ package: FIXTURE_DIR, options: { scenario: "R" } }],
  };
}

function buildIsolatedEnv(rootReal, binDir, eventsFile, refuseDir) {
  // EMPTY allowlist: nothing inherited from the host session.
  return {
    CAPTURE_API_KEY: "sg-e2e-capture",
    HOME: path.join(rootReal, "home"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NO_COLOR: "1",
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    SGPROBE_EVENT_LOG: eventsFile,
    SGPROBE_REFUSE_DIR: refuseDir,
    TMPDIR: path.join(rootReal, "tmp"),
    TZ: "UTC",
    XDG_CACHE_HOME: path.join(rootReal, "xdg", "cache"),
    XDG_CONFIG_HOME: path.join(rootReal, "xdg", "config"),
    XDG_DATA_HOME: path.join(rootReal, "xdg", "data"),
    XDG_STATE_HOME: path.join(rootReal, "xdg", "state"),
  };
}

const ENV_ALLOWLIST_KEYS = [
  "CAPTURE_API_KEY",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "SGPROBE_EVENT_LOG",
  "SGPROBE_REFUSE_DIR",
  "TMPDIR",
  "TZ",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];

function readEvents(eventsFile) {
  if (!existsSync(eventsFile)) return { events: [], malformed: [] };
  // Malformed lines are counted and returned, never demoted to a sentinel
  // event or dropped — the runtime fails on them (evidence integrity).
  return parseEventLines(readFileSync(eventsFile, "utf8"));
}

// ------------------------------------------------------------------ controls --
const shellCmd = (ws, receipt) =>
  `printf '%s\n' '${receipt}' > '${ws}/receipt.txt' && printf '%s\n' ${PH_KEY} > '${ws}/result.txt'`;

const CONTROLS = [
  {
    id: "R1",
    description: "absolute-path read of nonce-bearing original succeeds after execute.before path restore",
    prompt: "R1: read the notes file",
    arm: (ws) => ({
      label: "R1-DONE",
      toolCallNext: true,
      toolName: "read",
      toolArgs: { path: `${ws}/${PH_PATH}` },
    }),
    files: () => ({ [R1_FILE]: `${R1_NONCE} exact original content\n` }),
    sessionPermissions: null,
    refuse: false,
    canonicalNeedles: [R1_NONCE],
    evaluate(ctx) {
      const before = ctx.events.find((e) => e.marker === "RESTORE-R1-PATH-MUTATED");
      const readAfter = ctx.events.find(
        (e) => e.hook === "tool.execute.after" && e.tool === "read" && e.status === "completed",
      );
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        sessionReadbackDirectoryExact: ctx.readbackDirectory === ctx.ws,
        beforeHookMutatedPath: Boolean(
          before && before.after?.includes(R1_FILE) && !before.after?.includes(PH_PATH),
        ),
        readToolCompleted: Boolean(readAfter),
        // Successful nonce CONTENT in the read result — an error echoing the
        // input path (the old A failure mode) must not satisfy this control.
        readResultCarriedNonce: Boolean(readAfter && String(readAfter.resultSample ?? "").includes(R1_NONCE)),
        readDidNotError: ctx.events.every(
          (e) => !(e.hook === "tool.execute.after" && e.tool === "read" && e.status === "error"),
        ),
        continuationCarriedExactNonce: ctx.requests.some((r) => r.main && r.bodyHas(R1_NONCE)),
        continuationCarriedRestoredPath: ctx.requests.some((r) => r.main && r.bodyHas(R1_FILE)),
        twoWayRequestExchange: ctx.requests.filter((r) => r.main).length >= 2,
      };
      return { checks, observed: { before: before ?? null, readAfter: readAfter ?? null } };
    },
  },
  {
    id: "R2",
    description: "restored shell writes body-entry receipt first, then exact restored value (quoted absolute operands)",
    prompt: "R2: run the armed command",
    arm: (ws) => ({
      label: "R2-DONE",
      toolCallNext: true,
      toolName: "shell",
      toolArgs: { command: shellCmd(ws, R2_RECEIPT) },
    }),
    files: () => ({}),
    sessionPermissions: [{ action: "shell", resource: "*", effect: "allow" }],
    refuse: false,
    canonicalNeedles: [ORIG_KEY],
    evaluate(ctx) {
      const before = ctx.events.find((e) => e.marker === "RESTORE-R2-COMMAND-MUTATED");
      const evaluates = ctx.events.filter((e) => e.hook === "permission.evaluate");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        sessionReadbackDirectoryExact: ctx.readbackDirectory === ctx.ws,
        beforeHookMutatedCommand: Boolean(
          before && before.after?.includes(ORIG_KEY) && !before.after?.includes(PH_KEY),
        ),
        permissionEvaluatedRestoredValue: evaluates.some(
          (e) => e.resourcesContainOriginal && !e.resourcesContainPlaceholder,
        ),
        shellToolCompleted: ctx.events.some(
          (e) => e.hook === "tool.execute.after" && e.tool === "shell" && e.status === "completed",
        ),
        receiptFileExact: ctx.receipt?.content === `${R2_RECEIPT}\n`,
        resultFileHasExactOriginal: ctx.result?.content === `${ORIG_KEY}\n`,
        receiptWrittenFirst: Boolean(ctx.receipt && ctx.result) && ctx.receipt.mtimeMs <= ctx.result.mtimeMs,
      };
      return { checks, observed: { before: before ?? null, evaluateFirings: evaluates.length } };
    },
  },
  {
    id: "R3",
    description: "same shell command refused by execute.before hook: refusal reported, neither receipt nor result",
    prompt: "R3: run the armed command",
    arm: (ws) => ({
      label: "R3-DONE",
      toolCallNext: true,
      toolName: "shell",
      toolArgs: { command: shellCmd(ws, "R3-RECEIPT-NONE") },
    }),
    files: () => ({}),
    sessionPermissions: [{ action: "shell", resource: "*", effect: "allow" }],
    refuse: true,
    canonicalNeedles: [R3_MARKER],
    evaluate(ctx) {
      const threw = ctx.events.find(
        (e) => e.hook === "tool.execute.before-throw" && e.marker === "SGPROBE-R3-THROW",
      );
      const refusalInCli = (ctx.runResult.stdout + ctx.runResult.stderr).includes(R3_MARKER);
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        sessionReadbackDirectoryExact: ctx.readbackDirectory === ctx.ws,
        beforeHookThrew: Boolean(threw),
        receiptAbsent: !ctx.receipt,
        resultAbsent: !ctx.result,
        shellNotCompleted: !ctx.events.some(
          (e) => e.hook === "tool.execute.after" && e.tool === "shell" && e.status === "completed",
        ),
        refusalReachedModelContext: ctx.requests.some((r) => r.main && r.bodyHas(R3_MARKER)),
      };
      return {
        checks,
        observed: { threw: threw ?? null, refusalInCli },
        limitations: [
          "the paired R2 control (identical command shape, no refusal marker) is the successful-body prerequisite: R3's absence-of-receipt/result is only meaningful because the same command demonstrably writes both files when not refused; R3 never runs before R2 in the sequence",
        ],
      };
    },
  },
  {
    id: "R4a",
    description: "deny-on-restored-original vs allow-on-placeholder: no execution, no side effects",
    prompt: "R4a: run the armed command",
    arm: (ws) => ({
      label: "R4A-DONE",
      toolCallNext: true,
      toolName: "shell",
      toolArgs: { command: shellCmd(ws, R4A_RECEIPT) },
    }),
    files: () => ({}),
    sessionPermissions: [
      { action: "shell", resource: `*${PH_KEY}*`, effect: "allow" },
      { action: "shell", resource: `*${ORIG_KEY}*`, effect: "deny" },
    ],
    refuse: false,
    canonicalNeedles: [],
    evaluate(ctx) {
      // ═══ EXACT SESSION + EXACT COMMAND ATTRIBUTION ═══ (fix #2 + final
      // bounded correction) Expected identity is NEVER derived from event
      // fields: the NONEMPTY session id and canonical armed/restored command
      // strings come from the ACTUAL prepared control via the evaluator
      // context (fake offline contexts supply them too). Missing/empty
      // session cannot compare equal vacuously; a DIFFERENT command sharing
      // key/receipt tokens cannot match (exact equality only). Identifier
      // shapes per @opencode/plugin 2.0.19 d.ts: tool events carry
      // id: Tool.CallID + messageID; permission source =
      // { type: "tool", messageID, id }.
      const sessionKnown = typeof ctx.sessionID === "string" && ctx.sessionID.length > 0;
      const expectedArmed =
        typeof ctx.expectedArmedCommand === "string" && ctx.expectedArmedCommand.length > 0
          ? ctx.expectedArmedCommand
          : null;
      const expectedRestored =
        typeof ctx.expectedRestoredCommand === "string" && ctx.expectedRestoredCommand.length > 0
          ? ctx.expectedRestoredCommand
          : null;
      const attributable = sessionKnown && expectedArmed !== null && expectedRestored !== null;
      const ownSession = (e) => attributable && e.sessionID === ctx.sessionID;
      const evaluates = ctx.events.filter((e) => e.hook === "permission.evaluate");
      // 1. Arming: THIS session's restore hook mutated the EXACT canonical
      //    armed command (placeholder form -> restored form), carrying the
      //    armed call's CallID + MessageID.
      const before = attributable
        ? ctx.events.find(
            (e) =>
              e.marker === "RESTORE-R2-COMMAND-MUTATED" &&
              ownSession(e) &&
              e.before === expectedArmed &&
              e.after === expectedRestored,
          )
        : null;
      // The armed call's identifiers must be FULLY present before any
      // correlation is attempted — `undefined === undefined` must never
      // count as a match (missing attribution is nonsuccess).
      const armedIds =
        before &&
        typeof before.callID === "string" &&
        before.callID.length > 0 &&
        typeof before.messageID === "string" &&
        before.messageID.length > 0
          ? { callID: before.callID, messageID: before.messageID }
          : null;
      // 2. Denial: action shell, effect deny, the EXACT restored armed
      //    command as the evaluated resource, and the permission SOURCE
      //    pointing at the EXACT armed tool call + message.
      const denial =
        attributable && armedIds
          ? evaluates.find(
              (e) =>
                ownSession(e) &&
                e.action === "shell" &&
                e.effect === "deny" &&
                Array.isArray(e.resources) &&
                e.resources.includes(expectedRestored) &&
                e.source?.type === "tool" &&
                e.source?.id === armedIds.callID &&
                e.source?.messageID === armedIds.messageID,
            )
          : null;
      // 3. Observable error on the SAME tool call (CallID + MessageID +
      //    session), nonempty message. CAUSALITY IS NOT INFERRED: the
      //    installed Tool.Error shape (plugin 2.0.19 d.ts execute.after)
      //    exposes only a generic message plus optional error/metadata —
      //    there is NO declared permission-specific wording, so error TEXT
      //    (including a generic "EACCES: permission denied" from an
      //    unrelated open) is never treated as proof the deny rule caused
      //    this error. See verdict below.
      const armedCallError = armedIds
        ? ctx.events.find(
            (e) =>
              e.hook === "tool.execute.after" &&
              e.tool === "shell" &&
              e.status === "error" &&
              ownSession(e) &&
              e.callID === armedIds.callID &&
              e.messageID === armedIds.messageID &&
              typeof e.errorText === "string" &&
              e.errorText.length > 0,
          )
        : null;
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        sessionReadbackDirectoryExact: ctx.readbackDirectory === ctx.ws,
        expectedSessionAndCommandsSupplied: attributable,
        beforeHookMutatedExactArmedCommand: Boolean(before),
        permissionSourceMatchesArmedCall: Boolean(
          armedIds &&
            evaluates.some(
              (e) =>
                ownSession(e) &&
                e.source?.type === "tool" &&
                e.source?.id === armedIds.callID &&
                e.source?.messageID === armedIds.messageID,
            ),
        ),
        denyEffectEvaluatedOnExactRestoredCommand: Boolean(denial),
        armedCallEndedInError: Boolean(armedCallError),
        receiptAbsent: !ctx.receipt,
        resultAbsent: !ctx.result,
        shellNotCompleted: !ctx.events.some(
          (e) =>
            e.hook === "tool.execute.after" &&
            e.tool === "shell" &&
            e.status === "completed" &&
            ownSession(e),
        ),
      };
      return {
        checks,
        // Conservative complete verdict: every observable check may pass, but
        // deny -> error CAUSALITY is unprovable this round (no independently
        // validated refusal-cause producer; installed Tool.Error has no
        // declared permission wording). UNKNOWN is a NONSUCCESS — no complete
        // PASS, no invented codes/tags/flags, until a producer exists.
        verdict: "UNKNOWN",
        observed: {
          armedCallID: before?.callID ?? null,
          armedMessageID: before?.messageID ?? null,
          expectedArmedCommand: expectedArmed,
          expectedRestoredCommand: expectedRestored,
          evaluateSources: evaluates.map((e) => e.source ?? null),
          evaluateEffects: evaluates.map((e) => e.effect),
          armedCallError: armedCallError ?? null,
          runExitCode: ctx.runResult.exitCode,
        },
        limitations: [
          "exact-session + exact-command attribution: the nonempty sessionID and canonical armed/restored commands are supplied explicitly by the prepared control context, never derived from event fields — missing identity cannot compare equal, and token-sharing commands cannot match",
          "installed Tool.Error guarantees only a generic message plus optional error/metadata (plugin 2.0.19 d.ts); error text is NOT causal proof — the complete R4a gate stays UNKNOWN even when every observable check passes (fail-closed, no text-based cause inference)",
        ],
      };
    },
  },
  {
    id: "R4b",
    description: "allow-on-restored-original vs deny-on-placeholder: execution with receipt+result (rule identity not observable)",
    prompt: "R4b: run the armed command",
    arm: (ws) => ({
      label: "R4B-DONE",
      toolCallNext: true,
      toolName: "shell",
      toolArgs: { command: shellCmd(ws, R4B_RECEIPT) },
    }),
    files: () => ({}),
    sessionPermissions: [
      { action: "shell", resource: `*${PH_KEY}*`, effect: "deny" },
      { action: "shell", resource: `*${ORIG_KEY}*`, effect: "allow" },
    ],
    refuse: false,
    canonicalNeedles: [ORIG_KEY],
    evaluate(ctx) {
      const evaluates = ctx.events.filter((e) => e.hook === "permission.evaluate");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        sessionReadbackDirectoryExact: ctx.readbackDirectory === ctx.ws,
        permissionEvaluatedRestoredValue: evaluates.some(
          (e) => e.resourcesContainOriginal && !e.resourcesContainPlaceholder,
        ),
        shellToolCompleted: ctx.events.some(
          (e) => e.hook === "tool.execute.after" && e.tool === "shell" && e.status === "completed",
        ),
        receiptFileExact: ctx.receipt?.content === `${R4B_RECEIPT}\n`,
        resultFileHasExactOriginal: ctx.result?.content === `${ORIG_KEY}\n`,
      };
      return {
        checks,
        observed: { evaluateEffects: evaluates.map((e) => e.effect), evaluateFirings: evaluates.length },
        limitations: [
          "allow-rule identity is NOT observable from the evaluate event (no matched-rule field); execution is consistent with both an explicit allow-rule match and default allow — the deny direction (R4a) carries the rule-matching evidence",
        ],
      };
    },
  },
];

// ----------------------------------------------------- legacy (NOT executed) --
/**
 * SOURCE-REPAIRED legacy case definitions from the pre-recovery probe.
 * Executing them is intentionally impossible here (the review forbids another
 * broad rerun); they are retained for inspection so the repairs are reviewable:
 *   - no OR-acceptance across evidence kinds (each independent claim required)
 *   - stored-message acceptance via canonical session-scoped SQLite queries
 *     (ctx.canonical), raw byte scans demoted to forensic observation
 *   - A must prove SUCCESSFUL use of the restored file, not error propagation
 *   - P2 no longer claims allowRuleMatched from execution alone
 * evaluate(ctx) expects: events, requests[{main, bodyHas}], stdout, stderr,
 * receipt/result file records, sideEffects, canonical (array of
 * canonicalStoredMessages results — status "UNKNOWN" this round — for this
 * case's needles), exitCode, timedOut.
 */
const LEGACY_CASES = [
  {
    id: "A",
    description: "execute.before path mutation reaches the actual tool (repaired: success, not error text)",
    evaluate(ctx) {
      const before = ctx.events.find((e) => e.marker === "RESTORE-A-INPUT-MUTATED");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        beforeHookFiredAndMutated: Boolean(before),
        actualToolReceivedRestoredPath: ctx.requests.some((r) => r.bodyHas("restored-notes.txt")),
        restoredFileContentReachedModelContext: ctx.requests.some((r) => r.bodyHas("RESTORE-A-OK")),
      };
      return { checks };
    },
  },
  {
    id: "B",
    description: "execute.before throw skips the tool; refusal surfaces (repaired: independent claims)",
    evaluate(ctx) {
      const threw = ctx.events.find((e) => e.hook === "tool.execute.before-throw");
      const victimAnywhere =
        ctx.requests.some((r) => r.bodyHas("VICTIM-B-SECRET")) || ctx.stdout.includes("VICTIM-B-SECRET");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        beforeHookThrew: Boolean(threw),
        noVictimContentAnywhere: !victimAnywhere,
        errorReachedModelContext: ctx.requests.some((r) => r.main && r.bodyHas(B_THROW)),
        errorReachedCliOutput: ctx.stdout.includes(B_THROW) || ctx.stderr.includes(B_THROW),
      };
      return {
        checks,
        limitations: [
          "refused-read body non-entry is not independently instrumented; absence of victim content is evidence, and a paired successful contained control (recovery R-controls) carries the body-entry proof",
        ],
      };
    },
  },
  {
    id: "C",
    description: "execute.after result mutation reaches model context, CLI stdout, and canonical stored messages",
    evaluate(ctx) {
      const mutated = ctx.events.find((e) => e.marker === "RESTORE-C-RESULT-MUTATED");
      // Canonical acceptance is fail-closed: only a VERIFIED canonical query
      // result can pass; UNKNOWN (this round's only possible state) must FAIL
      // the claim rather than pass vacuously.
      const canonicalVerified = ctx.canonical.some(
        (c) => c.status === "verified" && c.needles?.includes(C_MARKER),
      );
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        afterHookFiredAndMutated: Boolean(mutated),
        mutationReachedModelContext: ctx.requests.some((r) => r.bodyHas(C_MARKER)),
        mutationReachedCliStdout: ctx.stdout.includes(C_MARKER),
        mutationReachedCanonicalStorage: canonicalVerified,
      };
      return {
        checks,
        limitations: [
          "canonical storage acceptance requires a verified canonical session/message/part query — currently UNKNOWN by design, so this legacy case CANNOT pass until the canonical query gate is resolved (fail-closed, not false-PASS)",
        ],
      };
    },
  },
  {
    id: "D",
    description: "inbound http.response restore + OUTBOUND original->placeholder re-mask incl. resume replay (repaired directions, no OR acceptance)",
    evaluate(ctx) {
      const ev = ctx.events;
      const contextRemasked = ev.filter((e) => e.hook === "context" && (e.replacements ?? 0) > 0);
      // NOTE marker renamed to MASK-D-HTTPREQ-REMASKED: the outbound
      // http.request hook now masks original->placeholder (the old
      // placeholder->original usage there was restoration in an outbound
      // request — the handoff-22 final-oracle defect).
      const httpRequestRemasked = ev.filter((e) => e.hook === "http.request" && e.marker === "MASK-D-HTTPREQ-REMASKED");
      const httpReplaced = ev.filter((e) => e.hook === "http.response" && e.marker === "RESTORE-D-HTTP-REPLACED");
      const run2 = (r) => r.run === 2;
      const canonicalVerified = ctx.canonical.some(
        (c) => c.status === "verified" && c.needles?.includes(ORIG_EMAIL),
      );
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        httpResponseHookReplacedReply: httpReplaced.length > 0,
        contextLayerRemasked: contextRemasked.length > 0,
        httpTransportMaskedOutbound: httpRequestRemasked.length > 0,
        noOriginalsOutbound: !ctx.requests.some((r) => r.bodyHas(ORIG_EMAIL) || r.bodyHas(ORIG_KEY)),
        placeholdersOutbound: ctx.requests.some((r) => r.bodyHas("[SGPROBE-EMAIL-1]") || r.bodyHas(PH_KEY)),
        resumeReplayContextRemasked: ctx.requests.some(run2) && contextRemasked.some((e) => e.ts >= ctx.run2StartedAt),
        resumeReplayHttpMasked: ctx.requests.some(run2) && httpRequestRemasked.some((e) => e.ts >= ctx.run2StartedAt),
        restoredInCliStdout: ctx.stdout.includes(ORIG_EMAIL),
        restoredInCanonicalStorage: canonicalVerified,
      };
      return {
        checks,
        limitations: [
          "buffered full-body HTTP rewrite is a capability probe only — not a production streaming algorithm; no WebSocket/TUI/OpenChamber claim",
          "canonical storage acceptance requires a verified canonical query — currently UNKNOWN by design (fail-closed, not false-PASS)",
        ],
      };
    },
  },
  {
    id: "E",
    description: "context hook throw stops the primary request pre-dispatch (repaired: no exit-code OR)",
    evaluate(ctx) {
      const contextThrew = ctx.events.some((e) => e.hook === "context-throw");
      const mainRequests = ctx.requests.filter((r) => r.main);
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        contextHookThrew: contextThrew,
        primaryRequestNeverDispatched: mainRequests.length === 0,
        errorSurfacedInCliOutput: ctx.stdout.includes(E_THROW) || ctx.stderr.includes(E_THROW),
        auxCallDistinguishable: ctx.requests.some((r) => !r.main) || ctx.events.some((e) => e.hook === "title"),
      };
      return { checks, observed: { exitCode: ctx.exitCode } };
    },
  },
  {
    id: "P1",
    description: "permission ordering vs restored input — default permission config (observational)",
    evaluate(ctx) {
      const before = ctx.events.find((e) => e.marker === "RESTORE-P-INPUT-MUTATED");
      const firstEvaluate = ctx.events.find((e) => e.hook === "permission.evaluate");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        beforeHookFiredAndMutated: Boolean(before),
        orderingDetermined: Boolean(before && firstEvaluate),
      };
      return { checks };
    },
  },
  {
    id: "P2",
    description: "permission ordering vs restored input — allow rule (repaired: no rule-match claim from execution)",
    evaluate(ctx) {
      const before = ctx.events.find((e) => e.marker === "RESTORE-P-INPUT-MUTATED");
      const checks = {
        pluginLoaded: ctx.pluginLoaded,
        beforeHookFiredAndMutated: Boolean(before),
        permissionEvaluated: ctx.events.some((e) => e.hook === "permission.evaluate"),
        toolExecutedWithRestoredValue: ctx.result?.content === `${ORIG_KEY}\n`,
      };
      return {
        checks,
        limitations: [
          "allowRuleMatched is NOT claimed: execution alone cannot distinguish an explicit allow-rule match from default allow",
        ],
      };
    },
  },
];

// -------------------------------------------------------------- control run ---
async function runControl(def, runtime) {
  const ws = mkdtempSync(path.join(runtime.root, `ws-${def.id.toLowerCase()}-`));
  assertRealOwnedChain(ws, runtime.rootReal);
  for (const [name, content] of Object.entries(def.files(ws))) {
    writeFileSync(path.join(ws, name), content);
  }

  // Create an EMPTY session with an explicit location through the documented
  // V2 API, then read the canonical session back BEFORE arming any tool.
  const createPayload = { location: { directory: ws } };
  if (def.sessionPermissions) createPayload.permissions = def.sessionPermissions;
  const created = await runtime.api("POST", "/api/session", { body: JSON.stringify(createPayload) });
  if (!created.ok) {
    throw new StopError(def.id, "session create failed", {
      status: created.status,
      body: (await created.text()).slice(0, 500),
    });
  }
  const createdJson = await created.json();
  const sessionID = createdJson?.data?.id;
  // Final bounded correction: the evaluator's exact-session attribution
  // requires a NONEMPTY string — a non-string/truthy-non-string id must stop
  // here rather than flow into `e.sessionID === ctx.sessionID` comparisons.
  if (typeof sessionID !== "string" || sessionID.length === 0) {
    throw new StopError(def.id, "session create returned no nonempty string data.id", { body: createdJson });
  }
  const readback = await runtime.api("GET", `/api/session/${encodeURIComponent(sessionID)}`);
  if (!readback.ok) throw new StopError(def.id, "session readback failed", { status: readback.status });
  const readbackJson = await readback.json();
  const readbackDirectory = readbackJson?.data?.location?.directory ?? null;

  // ═══ CANONICAL LOCATION PREREQUISITE (handoff-22 final-oracle repair) ═══
  // The actual session directory must EQUAL the owned temporary workspace
  // BEFORE anything is armed or executed: no environment write, no refusal
  // marker, no capture-server control post, no CLI spawn. (The old code
  // compared only inside the post-run checks — a mismatched session could
  // already have executed tools elsewhere by then.) No session-directory
  // inference from spawn cwd; the canonical API readback is authoritative.
  if (readbackDirectory !== ws) {
    throw new StopError(def.id, "canonical session directory mismatch BEFORE arming", {
      readbackDirectory,
      expected: ws,
    });
  }

  // Documented environment API: REPLACE the session shell environment.
  const envPut = await runtime.api("PUT", `/api/session/${encodeURIComponent(sessionID)}/environment`, {
    body: JSON.stringify({ variables: { PATH: "/usr/bin:/bin", SGPROBE_SESSION: def.id } }),
  });
  if (!envPut.ok) {
    throw new StopError(def.id, "session environment PUT failed", {
      status: envPut.status,
      body: (await envPut.text()).slice(0, 300),
    });
  }

  // R3: drop the refusal marker keyed by sessionID before arming.
  if (def.refuse) writeFileSync(path.join(runtime.refuseDir, sessionID), "R3");

  // Final bounded correction: capture the ACTUAL prepared control so the
  // canonical armed command (placeholder form) and its restored form (the
  // fixture's plain PH_KEY -> ORIG_KEY replacement) are passed into the
  // evaluator context EXPLICITLY — evaluators never trust event fields as
  // the expected value.
  const armed = def.arm(ws);
  await runtime.postControl(armed);

  // ═══ CLI FALLBACK SURFACE GATE (handoff-22 final-oracle repair) ═══
  // `opencode run --server <url>` has NO VERIFIED API-token propagation
  // mechanism this round; the 2026-09-30 incident showed an unauthenticated
  // CLI invocation can silently fall back to the user's LIVE background
  // service and provider. Fail closed BEFORE spawning: when the serve API
  // required authentication, refusing to run is the only safe outcome. (No
  // weak flag asserts safety here; only a documented, verified mechanism may
  // ever set CLI_TOKEN_MECHANISM_VERIFIED.)
  if (runtime.authMode !== "none" && !CLI_TOKEN_MECHANISM_VERIFIED) {
    throw new StopError(def.id, "CLI invocation refused: no verified API-token mechanism for --server (fallback risk)", {
      authMode: runtime.authMode,
      unresolved: RUNTIME_UNRESOLVED[0],
    });
  }

  const startedAt = Date.now();
  const runResult = await spawnTracked(
    SANDBOX_EXEC,
    [
      "-f",
      runtime.profilePath,
      "--",
      runtime.bin,
      "run",
      "--server",
      runtime.serveUrl,
      "--session",
      sessionID,
      "--model",
      MODEL_REF,
      "--format",
      "json",
      def.prompt,
    ],
    { cwd: ws, env: runtime.env, timeoutMs: RUN_TIMEOUT_MS, label: `run-${def.id}` },
  );
  await sleep(SETTLE_MS);
  const windowEnd = Date.now();

  // Attribute captures by time window; main requests carry tools.
  // Malformed capture evidence FAILS — it is never silently discarded (the
  // old `catch { continue; }` dropped unparseable envelopes, hiding exactly
  // the corruption a containment check must surface).
  const requests = [];
  const malformedCaptures = [];
  for (const name of readdirSync(runtime.capturedDir)) {
    if (!name.startsWith("raw-")) continue;
    const p = path.join(runtime.capturedDir, name);
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      malformedCaptures.push({ file: name, reason: "unparseable envelope" });
      continue;
    }
    if (typeof envelope.receivedAt !== "number" || !Number.isFinite(envelope.receivedAt)) {
      malformedCaptures.push({ file: name, reason: `invalid receivedAt ${JSON.stringify(envelope.receivedAt)}` });
      continue;
    }
    if (envelope.receivedAt >= startedAt && envelope.receivedAt <= windowEnd) {
      const target = path.join(runtime.capturedDir, `${def.id}-${envelope.seq}.json`);
      envelope.control = def.id;
      writeFileSync(target, JSON.stringify(envelope, null, 2));
      if (p !== target) rmSync(p, { force: true });
      requests.push({
        seq: envelope.seq,
        raw: envelope.body,
        main: Array.isArray(envelope.body?.tools) && envelope.body.tools.length > 0,
        file: `captured/${def.id}-${envelope.seq}.json`,
        bodyHas(needle) {
          return JSON.stringify(this.raw ?? null).includes(needle);
        },
      });
    }
  }
  requests.sort((a, b) => a.seq - b.seq);
  if (malformedCaptures.length > 0) runtime.malformedCaptures.push(...malformedCaptures.map((m) => ({ control: def.id, ...m })));

  const readOutput = (name) => {
    const p = path.join(ws, name);
    if (!existsSync(p)) return null;
    return { path: p, content: readFileSync(p, "utf8"), mtimeMs: statSync(p).mtimeMs };
  };

  const parsedEvents = readEvents(runtime.eventsFile);
  const allEvents = parsedEvents.events;
  const events = allEvents.filter((e) => e.sessionID === sessionID);
  if (parsedEvents.malformed.length > 0) {
    runtime.malformedEvents.push(
      ...parsedEvents.malformed.map((m) => ({ control: def.id, line: m })),
    );
  }
  const evalCtx = {
    ws,
    sessionID,
    readbackDirectory,
    events,
    pluginLoaded: allEvents.some((e) => e.hook === "plugin-loaded"),
    requests,
    receipt: readOutput("receipt.txt"),
    result: readOutput("result.txt"),
    // Canonical expected commands derived from the ACTUAL prepared control
    // (final bounded correction): exact-match attribution inputs.
    expectedArmedCommand: typeof armed?.toolArgs?.command === "string" ? armed.toolArgs.command : null,
    expectedRestoredCommand:
      typeof armed?.toolArgs?.command === "string"
        ? armed.toolArgs.command.split(PH_KEY).join(ORIG_KEY)
        : null,
    runResult: { stdout: runResult.stdout, stderr: runResult.stderr, exitCode: runResult.exitCode },
  };
  const { checks, observed, limitations = [] } = def.evaluate(evalCtx);
  // Harness-integrity checks injected uniformly: malformed evidence of ANY
  // kind fails the control (missing required observation is never a pass).
  checks.evidenceWellFormed = parsedEvents.malformed.length === 0 && malformedCaptures.length === 0;
  return {
    control: def.id,
    description: def.description,
    sessionID,
    ws,
    readbackDirectory,
    permissionRules: def.sessionPermissions,
    runExitCode: runResult.exitCode,
    runTimedOut: runResult.timedOut,
    requestCount: requests.length,
    malformedCaptures: malformedCaptures.map((m) => ({ file: m.file, reason: m.reason })),
    requests: requests.map(({ seq, main, file }) => ({ seq, kind: main ? "main" : "aux", file })),
    receipt: evalCtx.receipt ? { content: evalCtx.receipt.content, mtimeMs: evalCtx.receipt.mtimeMs } : null,
    result: evalCtx.result ? { content: evalCtx.result.content, mtimeMs: evalCtx.result.mtimeMs } : null,
    checks,
    observed,
    limitations,
    stdoutExcerpt: runResult.stdout.slice(0, 600),
    stderrExcerpt: runResult.stderr.slice(0, 600),
    _rawLogs: { stdout: runResult.stdout, stderr: runResult.stderr },
  };
}

// ------------------------------------------------------------- offline suite --
/**
 * SELF-CONTAINED OFFLINE VALIDATION (handoff-22 "Current authorization").
 * Runs ONLY pure functions, mock contexts and synthetic in-memory
 * Request/Response objects. Constraints honored by construction:
 *   - no network (no fetch/URL loading; Request/Response are constructed
 *     objects, never dispatched),
 *   - no subprocess spawn, no OpenCode invocation,
 *   - no repository/user filesystem writes: the fixture plugin's evidence
 *     log is captured by an injected in-memory sink (offline-only
 *     offlineEventSink option) when its setup() is driven with a fake ctx;
 *     every assertion is on object state.
 * Validates: masking/restoration DIRECTION and idempotence, zero-change and
 * bodyless retention, stale-header removal, error propagation, config/
 * endpoint/event-line validators, and the plugin-specific control assertions
 * (including "an unrelated abort must NOT pass R4a" and "an outbound original
 * must fail legacy D"). Never attaches any execution success to provider
 * route claims — runtime controls are driven with FAKE evidence only.
 */
async function runOfflineSuite() {
  const results = [];
  const t = async (name, fn) => {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (err) {
      results.push({ name, pass: false, error: String(err?.message ?? err) });
    }
  };
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg ?? "assertion failed");
  };
  const eq = (actual, expected, msg) => {
    if (actual !== expected) {
      throw new Error(`${msg ?? "eq"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  // ── fixture import (side-effect-free by design; setup() never auto-runs) ──
  const fixture = await import(FIXTURE_INDEX);
  const P = fixture.__probeInternals;
  assert(P && typeof P.maskOriginals === "function" && typeof P.restorePlaceholders === "function",
    "fixture __probeInternals export missing — offline validation surface absent");
  assert(typeof fixture.default?.setup === "function", "fixture default.setup must be a function");
  eq(typeof fixture.default.id, "string", "fixture id");

  const ORIG_EMAIL = "alice.probe@example-test.invalid";
  const ORIG_KEY = "sk-PROBETEST1234567890abcdef";
  const PH_EMAIL = "[SGPROBE-EMAIL-1]";
  const PH_KEY = "[SGPROBE-KEY-1]";
  const PH_PATH = "[SGPROBE-PATH-1]";

  // ── 1. direction: mask is original -> placeholder ONLY ─────────────────────
  await t("mask-direction-original-to-placeholder", () => {
    const { out, touched } = P.maskOriginals(`user ${ORIG_EMAIL} key ${ORIG_KEY}`);
    eq(touched, 2, "touched");
    assert(out.includes(PH_EMAIL) && out.includes(PH_KEY), "placeholders present");
    assert(!out.includes(ORIG_EMAIL) && !out.includes(ORIG_KEY), "no originals remain after mask");
  });

  // ── 2. direction: restore is placeholder -> original ONLY ──────────────────
  await t("restore-direction-placeholder-to-original", () => {
    const { out, touched } = P.restorePlaceholders(`user ${PH_EMAIL} key ${PH_KEY} path ${PH_PATH}`);
    eq(touched, 3, "touched");
    assert(out.includes(ORIG_EMAIL) && out.includes(ORIG_KEY), "originals present");
    assert(!out.includes(PH_EMAIL) && !out.includes(PH_KEY) && !out.includes(PH_PATH), "no placeholders remain after restore");
  });

  // ── 3. round-trip stability both ways ──────────────────────────────────────
  //    (inputs must be single-alphabet: a mixed string cannot round-trip to
  //    itself because mask() also replaces pre-existing placeholders)
  await t("round-trip-mask-restore", () => {
    const s = `mixed ${ORIG_EMAIL} and ${ORIG_KEY} text`;
    eq(P.restorePlaceholders(P.maskOriginals(s).out).out, s, "restore(mask(s)) === s for original-only s");
    const r = `pre ${PH_EMAIL} mid ${PH_KEY} post`;
    eq(P.maskOriginals(P.restorePlaceholders(r).out).out, r, "mask(restore(s)) === s for placeholder-only s");
  });

  // ── 4. idempotence ─────────────────────────────────────────────────────────
  await t("idempotence-both-directions", () => {
    const once = P.maskOriginals(`a ${ORIG_KEY} b`).out;
    eq(P.maskOriginals(once).out, once, "mask(mask(x)) === mask(x)");
    const rOnce = P.restorePlaceholders(`a ${PH_KEY} b`).out;
    eq(P.restorePlaceholders(rOnce).out, rOnce, "restore(restore(x)) === restore(x)");
  });

  // ── 5. untouched strings are byte-identical, touched === 0 ─────────────────
  await t("untouched-strings-stable", () => {
    const s = "nothing probe-related here";
    const m = P.maskOriginals(s);
    eq(m.out, s, "mask identity");
    eq(m.touched, 0, "mask touched 0");
    const r = P.restorePlaceholders(s);
    eq(r.out, s, "restore identity");
    eq(r.touched, 0, "restore touched 0");
  });

  // ── 6. outbound Request: rebuilt MASKED, stale length/encoding dropped ─────
  await t("outbound-request-masked-and-stale-headers-dropped", async () => {
    const body = JSON.stringify({ messages: [{ content: `user ${ORIG_EMAIL} and ${ORIG_KEY}` }] });
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999", "content-encoding": "gzip" },
      body,
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "rebuilt", "action");
    assert(e.request !== req, "request replaced");
    const text = await e.request.text();
    assert(text.includes(PH_EMAIL) && text.includes(PH_KEY), "placeholders outbound");
    assert(!text.includes(ORIG_EMAIL) && !text.includes(ORIG_KEY), "NO originals outbound (regression: old code restored here)");
    eq(e.request.headers.get("content-length"), null, "stale content-length dropped");
    eq(e.request.headers.get("content-encoding"), null, "stale content-encoding dropped");
    eq(e.request.headers.get("content-type"), "application/json", "content-type preserved");
  });

  // ── 7. outbound Request: zero replacements retain ORIGINAL usable object ───
  await t("outbound-request-zero-replacements-retains-original", async () => {
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "11" },
      body: "hello world",
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "retained", "action");
    assert(e.request === req, "identity retained");
    eq(await e.request.text(), "hello world", "original body still readable (clone used)");
    eq(req.headers.get("content-length"), "11", "original headers intact");
  });

  // ── 8. outbound GET: retained (no body to mask, no invalid rebuild) ────────
  await t("outbound-get-request-retained", async () => {
    const req = new Request("http://127.0.0.1:9/v1/models", { method: "GET" });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "retained", "action");
    assert(e.request === req, "identity retained for bodyless method");
  });

  // ── 9. inbound Response: rebuilt RESTORED, stale headers dropped ───────────
  await t("inbound-response-restored-and-stale-headers-dropped", async () => {
    const text = JSON.stringify({ choices: [{ message: { content: `echo ${PH_EMAIL} ${PH_KEY}` } }] });
    const res0 = new Response(text, {
      status: 200,
      statusText: "OK",
      headers: { "content-length": "999", "content-encoding": "gzip", "content-type": "application/json" },
    });
    const e = { response: res0 };
    const res = await P.applyInboundResponseRestore(e);
    eq(res.action, "rebuilt", "action");
    assert(e.response !== res0, "response replaced");
    const body = await e.response.text();
    assert(body.includes(ORIG_EMAIL) && body.includes(ORIG_KEY), "originals restored inbound");
    assert(!body.includes(PH_EMAIL) && !body.includes(PH_KEY), "no placeholders remain inbound");
    eq(e.response.status, 200, "status preserved");
    eq(e.response.statusText, "OK", "statusText preserved");
    eq(e.response.headers.get("content-length"), null, "stale content-length dropped");
    eq(e.response.headers.get("content-encoding"), null, "stale content-encoding dropped");
  });

  // ── 10. inbound Response: zero replacements retain ORIGINAL usable object ──
  await t("inbound-response-zero-replacements-retains-original", async () => {
    const res0 = new Response("static", {
      status: 200,
      statusText: "OK",
      headers: { "content-length": "6", "content-type": "text/plain" },
    });
    const e = { response: res0 };
    const res = await P.applyInboundResponseRestore(e);
    eq(res.action, "retained", "action");
    assert(e.response === res0, "identity retained");
    eq(await e.response.text(), "static", "original body still readable (clone used, not consumed)");
    eq(res0.headers.get("content-length"), "6", "original headers intact");
  });

  // ── 11/12. bodyless 204/304 retained — no invalid body rebuild ─────────────
  for (const status of [204, 304]) {
    await t(`inbound-bodyless-${status}-retained`, async () => {
      const res0 = new Response(null, { status, headers: { "content-type": "text/plain" } });
      const e = { response: res0 };
      const res = await P.applyInboundResponseRestore(e);
      eq(res.action, "retained", "action");
      assert(e.response === res0, `identity retained for ${status}`);
      eq(e.response.status, status, "status intact");
      eq(await e.response.text(), "", "bodyless body readable as empty");
    });
  }

  // ── 13. rewrite errors PROPAGATE (request and response) ────────────────────
  await t("rewrite-errors-propagate", async () => {
    const badClone = () => ({ text: async () => { throw new Error("synthetic read failure"); } });
    const eReq = { request: { method: "POST", url: "http://127.0.0.1:9/x", headers: {}, clone: badClone, text: badClone().text } };
    let threw = false;
    try { await P.applyOutboundRequestMask(eReq); } catch { threw = true; }
    assert(threw, "outbound mask error must propagate");
    const eRes = { response: { status: 200, statusText: "", headers: { get: () => "" }, clone: badClone, text: badClone().text } };
    threw = false;
    try { await P.applyInboundResponseRestore(eRes); } catch { threw = true; }
    assert(threw, "inbound restore error must propagate");
  });

  // ── 14. fixture setup fail-loud: no SGPROBE_EVENT_LOG must THROW ───────────
  //    (guarded so an inherited env var can never turn this into a real write)
  await t("fixture-setup-fails-loud-without-event-log", async () => {
    if (process.env.SGPROBE_EVENT_LOG !== undefined) {
      throw new Error("test precondition: SGPROBE_EVENT_LOG unexpectedly set in offline environment");
    }
    let threw = false;
    try {
      await fixture.default.setup({ options: { scenario: "R" }, tool: { hook: async () => {} }, permission: { hook: async () => {} }, session: { hook: async () => {} }, app: null });
    } catch {
      threw = true;
    }
    assert(threw, "setup() must refuse to load without SGPROBE_EVENT_LOG");
  });

  // ── 15. fixture hooks via FAKE CTX (scenario D): registered handlers mask
  //        outbound / restore inbound at the HOOK level. The event log uses an
  //        IN-MEMORY sink injected through the fixture's offline-only
  //        offlineEventSink option (final bounded correction — replaces the
  //        old /dev/null byte sink; zero filesystem writes); every assertion
  //        is on the mutated event objects, not on logs. ────────────────────
  await t("fixture-hooks-fake-ctx-directions", async () => {
    const registrations = {};
    const sinkEvents = [];
    const fakeCtx = {
      options: { scenario: "D", offlineEventSink: (_p, s) => sinkEvents.push(String(s)) },
      app: null,
      tool: { hook: async (n, f) => { registrations[`tool:${n}`] = f; } },
      permission: { hook: async (n, f) => { registrations[`permission:${n}`] = f; } },
      session: { hook: async (n, f) => { registrations[`session:${n}`] = f; } },
    };
    const prevLog = process.env.SGPROBE_EVENT_LOG;
    const prevRefuse = process.env.SGPROBE_REFUSE_DIR;
    // Nonempty token so setup()'s fail-loud guard passes; NEVER opened — the
    // injected sink replaces appendFileSync before the first log line.
    process.env.SGPROBE_EVENT_LOG = "mock://offline-in-memory";
    delete process.env.SGPROBE_REFUSE_DIR;
    try {
      await fixture.default.setup(fakeCtx);
      assert(sinkEvents.length > 0, "in-memory sink captured the plugin-loaded event (zero filesystem writes)");
      assert(typeof registrations["session:http.request"] === "function", "http.request hook registered");
      assert(typeof registrations["session:http.response"] === "function", "http.response hook registered");

      const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"prompt":"secret ${ORIG_KEY}"}`,
      });
      const eOut = { request: req };
      await registrations["session:http.request"](eOut);
      const outBody = await eOut.request.text();
      assert(outBody.includes(PH_KEY) && !outBody.includes(ORIG_KEY),
        "http.request hook MASKS original->placeholder (the handoff-22 outbound regression)");

      const res0 = new Response(`echo ${PH_EMAIL}`, { status: 200, headers: { "content-type": "text/plain" } });
      const eIn = { response: res0 };
      await registrations["session:http.response"](eIn);
      const inBody = await eIn.response.text();
      assert(inBody.includes(ORIG_EMAIL) && !inBody.includes(PH_EMAIL),
        "http.response hook RESTORES placeholder->original");

      const resZero = new Response("plain", { status: 200 });
      const eZero = { response: resZero };
      await registrations["session:http.response"](eZero);
      assert(eZero.response === resZero, "zero-replacement response retained via hook");
    } finally {
      if (prevLog === undefined) delete process.env.SGPROBE_EVENT_LOG;
      else process.env.SGPROBE_EVENT_LOG = prevLog;
      if (prevRefuse !== undefined) process.env.SGPROBE_REFUSE_DIR = prevRefuse;
    }
  });

  // ── 16. endpoint normalization (hostname vs host-with-port fix) ────────────
  await t("normalize-endpoint-hostname-port", () => {
    eq(normalizeEndpoint("http://127.0.0.1:8080/v1"), "127.0.0.1:8080", "loopback with port");
    eq(normalizeEndpoint("https://opencode.ai/config.json"), "opencode.ai", "default https port omitted");
    eq(normalizeEndpoint("https://EXAMPLE.com:443/x"), "example.com", "default port omitted + case normalized");
    eq(normalizeEndpoint("not a url"), null, "invalid -> null (fails containment)");
  });

  // ── 17. allowed endpoints are PORT-SPECIFIC, capture-only ─────────────────
  await t("allowed-endpoints-port-specific", () => {
    const allowed = allowedEndpointsFor(4321);
    assert(allowed.has("127.0.0.1:4321") && allowed.has("localhost:4321"), "capture endpoint allowed");
    assert(!allowed.has("127.0.0.1:9999"), "different loopback port NOT allowed (old defect: all localhost allowed)");
    assert(!allowed.has("127.0.0.1"), "bare hostname does not authorize every port");
    // Schema hosts are NOT general endpoints anymore (offline-oracle fix #1):
    // a provider endpoint equal to a schema host must FAIL containment.
    assert(
      !allowed.has("opencode.ai") && !allowed.has("json.schemastore.org"),
      "schema hosts allowed ONLY inside the $schema field, nowhere else",
    );
  });

  // ── 18. validateConsumedConfig: exact generated capture profile ───────────
  //    positive + every oracle-reproduced negative class (fix #1) ────────────
  const goodDoc = {
    $schema: "https://opencode.ai/config.json",
    providers: {
      capture: {
        name: "Capture",
        env: ["CAPTURE_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: "http://127.0.0.1:4321/v1", apiKey: "sg-e2e-capture" },
        models: { "capture-1": { name: "Capture 1" } },
      },
    },
    plugins: [{ package: "/abs/fixtures/restoration-probe", options: { scenario: "R" } }],
  };
  const vcArgs = {
    expectedProviders: ["capture"],
    expectedPluginPackage: "/abs/fixtures/restoration-probe",
    expectedScenario: "R",
    expectedProviderPackage: "@opencode/ai/providers/openai-compatible",
    expectedProviderEnv: ["CAPTURE_API_KEY"],
    expectedSyntheticApiKey: "sg-e2e-capture",
    expectedCaptureEndpoint: "http://127.0.0.1:4321/v1",
    expectedSchemaUrl: "https://opencode.ai/config.json",
    allowedEndpoints: allowedEndpointsFor(4321),
  };
  const vreject = (doc, label, needle) => {
    const v = validateConsumedConfig(doc, vcArgs);
    assert(!v.ok, `${label} must be rejected`);
    assert(v.reasons.some((r) => r.includes(needle)), `${label}: expected a reason mentioning "${needle}", got: ${v.reasons.join("; ")}`);
    return v;
  };
  await t("consumed-config-positive", () => {
    const v = validateConsumedConfig(goodDoc, vcArgs);
    assert(v.ok, `unexpected reasons: ${v.reasons.join("; ")}`);
  });
  await t("consumed-config-negative-fetch-failed", () => {
    assert(!validateConsumedConfig(null, { ...vcArgs, fetchFailed: true }).ok, "failed fetch must FAIL (old code passed vacuously)");
  });
  await t("consumed-config-negative-extra-provider", () => {
    const v = validateConsumedConfig({ ...goodDoc, providers: { ...goodDoc.providers, openai: { name: "live" } } }, vcArgs);
    assert(!v.ok && v.reasons.some((r) => r.includes("provider set mismatch")), "exact provider set enforced");
  });
  await t("consumed-config-negative-plugin-set", () => {
    const v = validateConsumedConfig({ ...goodDoc, plugins: [] }, vcArgs);
    assert(!v.ok && v.reasons.some((r) => r.includes("plugin set mismatch")), "exact plugin set enforced");
    const v2 = validateConsumedConfig({ ...goodDoc, plugins: [{ package: "/abs/other", options: { scenario: "R" } }] }, vcArgs);
    assert(!v2.ok && v2.reasons.some((r) => r.includes("plugin package mismatch")), "plugin package enforced");
    const v3 = validateConsumedConfig({ ...goodDoc, plugins: [{ package: "/abs/fixtures/restoration-probe", options: { scenario: "A" } }] }, vcArgs);
    assert(!v3.ok && v3.reasons.some((r) => r.includes("scenario mismatch")), "plugin scenario enforced");
    // unknown plugin fields / options are rejected (offline-oracle fix #1)
    vreject(
      { ...goodDoc, plugins: [{ package: "/abs/fixtures/restoration-probe", options: { scenario: "R" }, auth: { token: "x" } }] },
      "unknown plugin field",
      "plugin field outside generated shape",
    );
    vreject(
      { ...goodDoc, plugins: [{ package: "/abs/fixtures/restoration-probe", options: { scenario: "R", apiKey: "x" } }] },
      "unknown plugin option",
      "plugin option outside generated shape",
    );
  });
  await t("consumed-config-negative-unknown-auth-source", () => {
    const v = validateConsumedConfig({ ...goodDoc, auth: { apiKey: "live-user-key" } }, vcArgs);
    assert(!v.ok && v.reasons.some((r) => r.includes("unknown auth source")), "unknown auth key rejected");
  });
  await t("consumed-config-negative-external-and-port-mismatch-urls", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "https://api.external.invalid/v1" } } } },
      "external endpoint",
      "endpoint outside allowed set",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "http://127.0.0.1:9999/v1" } } } },
      "wrong-port loopback endpoint",
      "port mismatch",
    );
  });
  // ── oracle-reproduced false passes, each now a negative case (fix #1) ─────
  await t("consumed-config-negative-missing-provider-endpoint", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { apiKey: "sg-e2e-capture" } } } },
      "missing provider endpoint",
      "provider endpoint missing",
    );
  });
  await t("consumed-config-negative-schema-host-as-provider-endpoint", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "https://opencode.ai/config.json" } } } },
      "provider endpoint equal to schema host",
      "endpoint outside allowed set",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "https://json.schemastore.org/opencode.json" } } } },
      "provider endpoint equal to schemastore host",
      "endpoint outside allowed set",
    );
  });
  await t("consumed-config-negative-uppercase-external-https", () => {
    // old scan regex was case-SENSITIVE: HTTPS:// never matched, slipped past
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "HTTPS://API.EXTERNAL.INVALID/v1" } } } },
      "uppercase external HTTPS endpoint",
      "endpoint outside allowed set",
    );
  });
  await t("consumed-config-negative-non-http-endpoint", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "file:///etc/passwd" } } } },
      "file:// endpoint",
      "scheme must be http(s)",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "ftp://127.0.0.1:4321/v1" } } } },
      "ftp endpoint",
      "scheme must be http(s)",
    );
  });
  await t("consumed-config-negative-endpoint-userinfo", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "http://user:secret@127.0.0.1:4321/v1" } } } },
      "userinfo in endpoint",
      "userinfo",
    );
  });
  await t("consumed-config-negative-endpoint-scheme-host-path-drift", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "https://127.0.0.1:4321/v1" } } } },
      "scheme drift (https vs http)",
      "protocol mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "http://127.0.0.1:4321/" } } } },
      "path drift",
      "pathname mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, baseURL: "http://localhost:4321/v1" } } } },
      "hostname drift",
      "hostname mismatch",
    );
  });
  await t("consumed-config-negative-provider-package-env-credential", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, package: "@opencode/ai/providers/other" } } },
      "wrong provider package",
      "provider package mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, env: ["CAPTURE_API_KEY", "OPENAI_API_KEY"] } } },
      "extra env credential source",
      "provider env mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, env: [] } } },
      "missing env",
      "provider env mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { ...goodDoc.providers.capture.settings, apiKey: "sk-live-user-real-key" } } } },
      "non-synthetic credential",
      "synthetic credential mismatch",
    );
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, settings: { baseURL: "http://127.0.0.1:4321/v1" } } } },
      "missing synthetic credential",
      "synthetic credential mismatch",
    );
  });
  await t("consumed-config-negative-unknown-provider-fields-nested-credentials", () => {
    vreject(
      { ...goodDoc, providers: { capture: { ...goodDoc.providers.capture, auth: { bearer: "live" } } } },
      "unknown provider field (auth)",
      "provider field outside generated shape",
    );
    vreject(
      {
        ...goodDoc,
        providers: {
          capture: {
            ...goodDoc.providers.capture,
            settings: { ...goodDoc.providers.capture.settings, credentials: { username: "u", password: "p" } },
          },
        },
      },
      "nested credentials object in settings",
      "auth-like key",
    );
    vreject(
      {
        ...goodDoc,
        providers: {
          capture: {
            ...goodDoc.providers.capture,
            settings: { ...goodDoc.providers.capture.settings, extra: true },
          },
        },
      },
      "unknown settings field",
      "provider settings field outside generated shape",
    );
  });
  await t("consumed-config-negative-schema-field-drift", () => {
    vreject(
      { ...goodDoc, $schema: "https://json.schemastore.org/opencode.json" },
      "non-expected $schema URL",
      "$schema must be exactly",
    );
  });
  await t("consumed-config-negative-url-in-nested-unknown-place", () => {
    vreject(
      {
        ...goodDoc,
        providers: {
          capture: {
            ...goodDoc.providers.capture,
            models: { "capture-1": { name: "Capture 1", docs: "see https://evil.example/x" } },
          },
        },
      },
      "external URL hidden in a nested model field",
      "endpoint outside allowed set",
    );
  });

  // ── 19. event-line parsing: malformed COUNTED, never discarded ─────────────
  await t("parse-event-lines-malformed-counted", () => {
    const p = parseEventLines('{"hook":"a"}\nnot-json\n\n{"hook":"b"}');
    eq(p.events.length, 2, "good events parsed");
    eq(p.malformed.length, 1, "malformed counted");
    eq(p.malformed[0], "not-json", "malformed content retained");
  });

  // ── 20. canonical persistence stub is UNKNOWN, never a scan ────────────────
  await t("canonical-persistence-explicit-unknown", () => {
    const out = canonicalStoredMessages("R1", "ses_x", ["NEEDLE"]);
    eq(out.status, "UNKNOWN", "status");
    assert(typeof out.reason === "string" && out.reason.length > 0, "blocking reason present");
    assert(!("tables" in out) && !("instrumented" in out), "no broad-scan surface (marker-before-query defect removed)");
  });

  // ── 21+. control evaluators with FAKE evidence (mock ctx) ─────────────────
  const mkReq = (raw, main = true) => ({
    main,
    raw,
    bodyHas(needle) {
      return JSON.stringify(this.raw ?? null).includes(needle);
    },
  });
  const fakeCtx = (over = {}) => ({
    ws: "/sgp/ws-x",
    sessionID: "ses_TEST",
    readbackDirectory: "/sgp/ws-x",
    events: [],
    pluginLoaded: true,
    requests: [],
    receipt: null,
    result: null,
    // Final bounded correction: fake contexts supply the SAME explicit
    // expected-identity inputs the runtime derives from the prepared control.
    expectedArmedCommand: null,
    expectedRestoredCommand: null,
    runResult: { stdout: "", stderr: "", exitCode: 0 },
    canonical: [],
    ...over,
  });
  const findControl = (id) => {
    const c = CONTROLS.find((x) => x.id === id);
    assert(c, `control ${id} missing`);
    return c;
  };
  // A control "complete-passes" only when every observable check passes AND
  // no conservative UNKNOWN verdict withholds the complete gate (R4a).
  const completePass = (out) => Object.values(out.checks).every(Boolean) && out?.verdict !== "UNKNOWN";

  await t("R1-positive-successful-nonce-result", () => {
    const ctx = fakeCtx({
      events: [
        { hook: "tool.execute.before", marker: "RESTORE-R1-PATH-MUTATED", before: `x ${PH_PATH}`, after: "/sgp/ws-x/nonce-r1-original.txt" },
        { hook: "tool.execute.after", tool: "read", status: "completed", resultSample: "R1-NONCE-7f3d9c21 exact original content" },
      ],
      requests: [mkReq({ tools: [{}], c: "R1-NONCE-7f3d9c21" }), mkReq({ tools: [{}], c: "nonce-r1-original.txt" })],
    });
    const { checks } = findControl("R1").evaluate(ctx);
    assert(Object.values(checks).every(Boolean), `R1 positive must pass, failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)}`);
    assert("readResultCarriedNonce" in checks, "R1 must require successful nonce content");
  });

  await t("R1-negative-error-echo-is-not-success", () => {
    const ctx = fakeCtx({
      events: [
        { hook: "tool.execute.before", marker: "RESTORE-R1-PATH-MUTATED", before: `x ${PH_PATH}`, after: "/sgp/ws-x/nonce-r1-original.txt" },
        // old failure mode: the ERROR echoes the input — nonce never in a SUCCESSFUL result
        { hook: "tool.execute.after", tool: "read", status: "completed", resultSample: "Error: cannot read nonce-r1-original.txt" },
      ],
      requests: [mkReq({ tools: [{}], c: "R1-NONCE-7f3d9c21" }), mkReq({ tools: [{}], c: "nonce-r1-original.txt" })],
    });
    const { checks } = findControl("R1").evaluate(ctx);
    eq(checks.readResultCarriedNonce, false, "error echo must NOT satisfy R1");
  });

  await t("R2-positive-receipt-and-result", () => {
    const ctx = fakeCtx({
      events: [
        { hook: "tool.execute.before", marker: "RESTORE-R2-COMMAND-MUTATED", after: `printf ... ${ORIG_KEY}` },
        { hook: "permission.evaluate", resourcesContainOriginal: true, resourcesContainPlaceholder: false, effect: "allow" },
        { hook: "tool.execute.after", tool: "shell", status: "completed" },
      ],
      receipt: { content: "R2-RECEIPT-4b81\n", mtimeMs: 1000 },
      result: { content: `${ORIG_KEY}\n`, mtimeMs: 1001 },
    });
    const { checks } = findControl("R2").evaluate(ctx);
    assert(Object.values(checks).every(Boolean), `R2 positive must pass, failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)}`);
  });

  await t("R2-negative-missing-result-file", () => {
    const ctx = fakeCtx({
      events: [{ hook: "tool.execute.before", marker: "RESTORE-R2-COMMAND-MUTATED", after: `x ${ORIG_KEY}` }],
      receipt: { content: "R2-RECEIPT-4b81\n", mtimeMs: 1000 },
      result: null,
    });
    const { checks } = findControl("R2").evaluate(ctx);
    eq(checks.resultFileHasExactOriginal, false, "missing observation is a FAIL, never a pass");
  });

  await t("R3-positive-refusal", () => {
    const ctx = fakeCtx({
      events: [{ hook: "tool.execute.before-throw", marker: "SGPROBE-R3-THROW" }],
      requests: [mkReq({ tools: [{}], c: "SGPROBE-R3-REFUSED" })],
      runResult: { stdout: "SGPROBE-R3-REFUSED", stderr: "", exitCode: 1 },
    });
    const { checks } = findControl("R3").evaluate(ctx);
    assert(Object.values(checks).every(Boolean), `R3 positive must pass, failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)}`);
  });

  // ── 22. R4a EXACT correlation (offline-oracle fix #2 + final bounded
  //        correction: exact session, exact expected command, UNKNOWN
  //        complete verdict while deny->error causality is unproven) ────────
  //    Identifiers per installed declarations: tool events carry
  //    id (CallID) + messageID; permission source = {type:"tool",id,messageID}.
  const r4aCmd = (secret) =>
    `printf '%s\\n' 'R4A-RECEIPT-5d07' > '/sgp/ws-x/receipt.txt' && printf '%s\\n' ${secret} > '/sgp/ws-x/result.txt'`;
  const r4aIds = { callID: "call_r4a", messageID: "msg_r4a" };
  const r4aArmed = (secret, ids = r4aIds, over = {}) => ({
    hook: "tool.execute.before",
    marker: "RESTORE-R2-COMMAND-MUTATED",
    sessionID: "ses_TEST",
    callID: ids.callID,
    messageID: ids.messageID,
    before: r4aCmd(PH_KEY),
    after: r4aCmd(secret),
    ...over,
  });
  const r4aDeny = (over = {}) => ({
    hook: "permission.evaluate",
    sessionID: "ses_TEST",
    action: "shell",
    effect: "deny",
    resources: [r4aCmd(ORIG_KEY)],
    source: { type: "tool", messageID: "msg_r4a", id: "call_r4a" },
    ...over,
  });
  const r4aErr = (errorText, ids = r4aIds, over = {}) => ({
    hook: "tool.execute.after",
    sessionID: "ses_TEST",
    tool: "shell",
    status: "error",
    callID: ids.callID,
    messageID: ids.messageID,
    errorText,
    ...over,
  });
  // Positive-shaped ctx: the fake "prepared control" supplies the SAME
  // explicit expected-identity inputs the runtime passes from the real one.
  const r4aPosCtx = (over = {}) =>
    fakeCtx({
      expectedArmedCommand: r4aCmd(PH_KEY),
      expectedRestoredCommand: r4aCmd(ORIG_KEY),
      events: [r4aArmed(ORIG_KEY), r4aDeny(), r4aErr("permission denied: shell command blocked by deny rule")],
      ...over,
    });

  await t("R4a-positive-observable-subchecks-complete-verdict-UNKNOWN", () => {
    const out = findControl("R4a").evaluate(r4aPosCtx());
    assert(
      Object.values(out.checks).every(Boolean),
      `R4a observable subchecks must pass, failed: ${Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k)}`,
    );
    eq(out.verdict, "UNKNOWN", "complete verdict stays UNKNOWN — deny->error causality unproven");
    eq(completePass(out), false, "UNKNOWN is a nonsuccess: no complete PASS this round");
  });

  await t("R4a-negative-unrelated-read-denial-plus-shell-error", () => {
    // EXACT oracle reproducer (old false pass): an unrelated READ denial
    // whose resource merely CONTAINS the original, plus an unrelated shell
    // error with arbitrary nonempty errorText.
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [
          r4aArmed(ORIG_KEY),
          {
            hook: "permission.evaluate",
            sessionID: "ses_TEST",
            action: "read",
            effect: "deny",
            resources: [`/sgp/ws-x/${ORIG_KEY}.txt`],
            resourcesContainOriginal: true,
            resourcesContainPlaceholder: false, // the old evaluator passed on THESE
            source: { type: "tool", messageID: "msg_unrelated", id: "call_unrelated" },
          },
          r4aErr("command not found: totally-unrelated", { callID: "call_other", messageID: "msg_other" }),
        ],
      }),
    );
    eq(out.checks.beforeHookMutatedExactArmedCommand, true, "the armed mutation itself is correlated and real");
    eq(out.checks.permissionSourceMatchesArmedCall, false, "an unrelated call/message source must NOT match");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "an unrelated READ denial must NOT satisfy the armed-SHELL deny control");
    eq(out.checks.armedCallEndedInError, false, "an unrelated call's error must NOT count as the refusal");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-missing-attribution-metadata", () => {
    // Old-shape evidence without call/message ids or permission source:
    // attribution is MISSING -> nonsuccess, never a vacuous pass.
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [
          { hook: "tool.execute.before", marker: "RESTORE-R2-COMMAND-MUTATED", sessionID: "ses_TEST", before: r4aCmd(PH_KEY), after: r4aCmd(ORIG_KEY) }, // no callID/messageID recorded
          { hook: "permission.evaluate", sessionID: "ses_TEST", action: "shell", effect: "deny", resources: [r4aCmd(ORIG_KEY)], source: null },
          { hook: "tool.execute.after", sessionID: "ses_TEST", tool: "shell", status: "error", errorText: "permission denied" }, // ids missing
        ],
      }),
    );
    eq(out.checks.permissionSourceMatchesArmedCall, false, "missing source ids must fail attribution");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "uncorrelated denial must fail");
    eq(out.checks.armedCallEndedInError, false, "uncorrelated error must fail");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-wrong-call-source", () => {
    // action/effect/resource all correct but the permission SOURCE points at
    // a DIFFERENT tool call -> not this armed call's denial.
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [r4aArmed(ORIG_KEY), r4aDeny({ source: { type: "tool", messageID: "msg_r4a", id: "call_DIFFERENT" } })],
      }),
    );
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "wrong source call id must fail the denial correlation");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-allow-effect-is-not-denial", () => {
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [r4aArmed(ORIG_KEY), r4aDeny({ effect: "allow" })],
      }),
    );
    eq(out.checks.permissionSourceMatchesArmedCall, true, "source correlation alone is not denial evidence");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "an allow effect must not satisfy the deny control");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-generic-eacces-is-not-causal-proof", () => {
    // EXACT second-oracle reproducer: the SAME call errors with a GENERIC
    // "EACCES: permission denied, open /unrelated". The old text regex
    // treated this as permission attribution; installed Tool.Error has no
    // declared permission wording, so text is never causal proof — the
    // observable error correlates but the complete gate stays UNKNOWN.
    const out = findControl("R4a").evaluate(
      r4aPosCtx({ events: [r4aArmed(ORIG_KEY), r4aDeny(), r4aErr("EACCES: permission denied, open /unrelated")] }),
    );
    eq(out.checks.armedCallEndedInError, true, "the observable same-call error still correlates");
    eq(out.verdict, "UNKNOWN", "generic error text is NOT denial-causality proof");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-missing-session-id-vacuous-match-closed", () => {
    // Second-oracle reproducer: ctx.sessionID undefined AND events without
    // sessionID — the old `e.sessionID === ctx.sessionID` matched vacuously.
    const strip = ({ sessionID, ...ev }) => ev;
    const out = findControl("R4a").evaluate(
      fakeCtx({
        sessionID: undefined,
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [strip(r4aArmed(ORIG_KEY)), strip(r4aDeny()), strip(r4aErr("permission denied"))],
      }),
    );
    eq(out.checks.expectedSessionAndCommandsSupplied, false, "missing session id is not attributable");
    eq(out.checks.beforeHookMutatedExactArmedCommand, false, "no vacuous undefined===undefined arming match");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "no vacuous denial match");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-empty-session-id", () => {
    const out = findControl("R4a").evaluate(
      fakeCtx({
        sessionID: "",
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [r4aArmed(ORIG_KEY, r4aIds, { sessionID: "" }), r4aDeny({ sessionID: "" }), r4aErr("permission denied", r4aIds, { sessionID: "" })],
      }),
    );
    eq(out.checks.expectedSessionAndCommandsSupplied, false, "empty session id is not attributable");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "empty session cannot match");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-wrong-session-id", () => {
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [
          r4aArmed(ORIG_KEY, r4aIds, { sessionID: "ses_OTHER" }),
          r4aDeny({ sessionID: "ses_OTHER" }),
          r4aErr("permission denied", r4aIds, { sessionID: "ses_OTHER" }),
        ],
      }),
    );
    eq(out.checks.beforeHookMutatedExactArmedCommand, false, "another session's arming must not match");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "another session's denial must not match");
    eq(out.checks.armedCallEndedInError, false, "another session's error must not match");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-different-command-sharing-tokens", () => {
    // Second-oracle reproducer: a DIFFERENT command containing the same
    // key+receipt tokens. Exact expected-command equality must reject it
    // (the old contains/token test passed).
    const imposter = `echo ${ORIG_KEY} R4A-RECEIPT-5d07 > /unrelated`;
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [r4aArmed(ORIG_KEY, r4aIds, { after: imposter }), r4aDeny({ resources: [imposter] }), r4aErr("permission denied")],
      }),
    );
    eq(out.checks.beforeHookMutatedExactArmedCommand, false, "token-sharing after is NOT the exact restored command");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "token-sharing resource is NOT the exact restored command");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-missing-expected-command-is-unknown-nonsuccess", () => {
    const out = findControl("R4a").evaluate(r4aPosCtx({ expectedRestoredCommand: null }));
    eq(out.checks.expectedSessionAndCommandsSupplied, false, "missing canonical expected command is not attributable");
    eq(out.checks.beforeHookMutatedExactArmedCommand, false, "no expected command -> no exact match");
    eq(out.verdict, "UNKNOWN", "missing expected identity/command => UNKNOWN/nonsuccess");
    eq(completePass(out), false, "no complete pass");
  });

  await t("R4a-negative-unrelated-abort-must-fail", () => {
    // unrelated abort: nothing armed, nothing evaluated, no error provenance
    const out = findControl("R4a").evaluate(
      fakeCtx({
        expectedArmedCommand: r4aCmd(PH_KEY),
        expectedRestoredCommand: r4aCmd(ORIG_KEY),
        events: [{ hook: "plugin-loaded" }],
      }),
    );
    eq(out.checks.beforeHookMutatedExactArmedCommand, false, "abort has no arming evidence");
    eq(out.checks.denyEffectEvaluatedOnExactRestoredCommand, false, "abort has no evaluated deny effect");
    eq(out.checks.armedCallEndedInError, false, "abort has no correlated error");
    eq(completePass(out), false, "no complete pass");
  });

  // ── 23. outbound rebuild PRESERVES transport controls (fix #3) ────────────
  await t("outbound-rebuild-preserves-signal-redirect-credentials", async () => {
    const ctl = new AbortController();
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `secret ${ORIG_KEY}`,
      redirect: "error",
      credentials: "omit",
      signal: ctl.signal,
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "rebuilt", "action");
    assert(e.request !== req, "request replaced");
    eq(e.request.redirect, "error", "redirect preserved (old rebuild reset it to follow)");
    // NOTE: a prior fixer observed a CONSTANT credentials getter ("include"
    // even for a fresh credentials:"omit" Request) on their Node v24.3.0
    // host; the oracle did NOT reproduce that on Node v26.0.0 (this suite's
    // host — process.version). Getter-equality with the original stays the
    // runtime-neutral assertion; the rebuild passes credentials explicitly
    // so spec-compliant runtimes preserve "omit".
    eq(e.request.credentials, req.credentials, "credentials carried over (explicit init, getter-consistent)");
    const text = await e.request.text();
    assert(text.includes(PH_KEY) && !text.includes(ORIG_KEY), "changed body is masked");
    eq(await req.text(), `secret ${ORIG_KEY}`, "zero-loss: ORIGINAL body still usable after rebuild (clone used)");
    ctl.abort("probe-abort");
    eq(e.request.signal.aborted, true, "aborting the ORIGINAL signal aborts the rebuilt request (shared signal preserved)");
  });

  await t("outbound-rebuild-preserves-pre-aborted-signal", async () => {
    // oracle reproducer: a PRE-aborted original signal must stay aborted —
    // the old rebuild minted a live replacement signal.
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      body: `secret ${ORIG_EMAIL}`,
      signal: AbortSignal.abort("already-aborted"),
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "rebuilt", "action (body still masked on an aborted request)");
    eq(e.request.signal.aborted, true, "pre-aborted signal stays aborted (old rebuild made it live)");
    const text = await e.request.text();
    assert(text.includes(PH_EMAIL) && !text.includes(ORIG_EMAIL), "masked body readable on the rebuilt request");
  });

  await t("outbound-rebuild-preserves-referrer-policy-and-other-controls", async () => {
    // Final-bounded-correction finding 2 (oracle reproduced on Node v26.0.0):
    // the rebuild dropped referrer/referrerPolicy. Verified HERE only on this
    // host's process.version — not a general runtime claim.
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: `secret ${ORIG_KEY}`,
      referrer: "http://127.0.0.9:9/originating/page", // non-default
      referrerPolicy: "no-referrer",
      mode: "same-origin",
      integrity: "sha256-BAAYEAwEAewEAAw=",
      keepalive: true,
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "rebuilt", "action");
    eq(e.request.referrer, req.referrer, "referrer preserved (old rebuild reset it to about:client)");
    eq(e.request.referrerPolicy, "no-referrer", "referrerPolicy preserved (old rebuild reset it to the default)");
    eq(e.request.mode, req.mode, "mode preserved");
    eq(e.request.integrity, req.integrity, "integrity preserved");
    eq(e.request.keepalive, req.keepalive, "keepalive preserved");
    const text = await e.request.text();
    assert(text.includes(PH_KEY) && !text.includes(ORIG_KEY), "body still masked");
    eq(e.request.headers.get("content-encoding"), null, "stale content-encoding still dropped");
  });

  await t("outbound-rebuild-zero-change-retains-original-request", async () => {
    const req = new Request("http://127.0.0.1:9/v1/chat/completions", {
      method: "POST",
      body: "nothing to mask here",
      referrer: "http://127.0.0.9:9/page",
      referrerPolicy: "no-referrer",
    });
    const e = { request: req };
    const res = await P.applyOutboundRequestMask(e);
    eq(res.action, "retained", "zero replacements retain");
    assert(e.request === req, "the ORIGINAL request object is retained untouched");
    eq(await req.text(), "nothing to mask here", "original body still readable (clone-based read)");
  });

  await t("R4b-positive-and-no-rule-match-claim", () => {
    const ctx = fakeCtx({
      events: [
        { hook: "tool.execute.before", marker: "RESTORE-R2-COMMAND-MUTATED", after: `x ${ORIG_KEY}` },
        { hook: "permission.evaluate", effect: "allow", resourcesContainOriginal: true, resourcesContainPlaceholder: false },
        { hook: "tool.execute.after", tool: "shell", status: "completed" },
      ],
      receipt: { content: "R4B-RECEIPT-2e94\n", mtimeMs: 1000 },
      result: { content: `${ORIG_KEY}\n`, mtimeMs: 1001 },
    });
    const out = findControl("R4b").evaluate(ctx);
    assert(Object.values(out.checks).every(Boolean), `R4b positive must pass, failed: ${Object.entries(out.checks).filter(([, v]) => !v).map(([k]) => k)}`);
    assert(!("allowRuleMatched" in out.checks), "R4b must not claim rule matching from execution");
    assert((out.limitations ?? []).some((l) => l.includes("default allow")), "default-allow ambiguity must be recorded");
  });

  await t("legacy-D-negative-outbound-original-leak-fails", () => {
    const legacyD = LEGACY_CASES.find((c) => c.id === "D");
    assert(legacyD, "legacy D retained");
    const ctx = fakeCtx({
      events: [
        { hook: "http.request", marker: "MASK-D-HTTPREQ-REMASKED" },
        { hook: "http.response", marker: "RESTORE-D-HTTP-REPLACED" },
        { hook: "context", replacements: 2 },
      ],
      requests: [mkReq({ tools: [{}], leaked: ORIG_EMAIL })], // original leaked outbound
      stdout: `restored ${ORIG_EMAIL}`,
      canonical: [{ control: "D", status: "UNKNOWN", needles: [ORIG_EMAIL] }],
    });
    const { checks } = legacyD.evaluate(ctx);
    eq(checks.noOriginalsOutbound, false, "outbound original leak must fail legacy D");
    eq(checks.restoredInCanonicalStorage, false, "UNKNOWN canonical status must not pass");
  });

  // ── 24. runner entrypoint guard: importing the runner runs NOTHING ────────
  await t("runner-entrypoint-guard-import-effect-free", async () => {
    const selfUrl = pathToFileURL(RUNNER_SELF).href;
    eq(computeIsCliMain(RUNNER_SELF, selfUrl), true, "direct CLI invocation of this file must run main");
    eq(computeIsCliMain("/some/other-entry.mjs", selfUrl), false, "a different entry module must not run this main");
    eq(computeIsCliMain(undefined, selfUrl), false, "importers (no argv[1] match) must not run main");
    // Re-import under a DISTINCT module URL (query suffix forces a fresh
    // top-level evaluation in-process — no subprocess, no tempfile). With the
    // OLD unconditional main() this import printed the RUNTIME BLOCKED notice
    // and set process.exitCode=4; both effects are observable here.
    const prevExit = process.exitCode;
    let printed = false;
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (...args) => {
      printed = true;
      return origWrite(...args);
    };
    try {
      const mod = await import(`${selfUrl}?effect-free-guard-probe`);
      eq(printed, false, "importing the runner must not print (main did not run)");
      eq(process.exitCode ?? 0, prevExit ?? 0, "importing the runner must not mutate process.exitCode");
      assert(
        mod.__probeRunnerInternals && typeof mod.__probeRunnerInternals.validateConsumedConfig === "function",
        "pure validators must be exported for importers",
      );
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = prevExit;
    }
  });

  // ── summary ────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.pass);
  console.log(`offline validation suite — ${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.error}`);
  console.log(
    "offline scope: pure functions + fake contexts + synthetic in-memory Request/Response only — no network, no subprocess, no OpenCode, no filesystem writes (plugin event log captured by an injected in-memory sink during the fake-ctx test)",
  );
  process.exitCode = failed.length > 0 ? 1 : 0;
}

// --------------------------------------------------------------------- main ---
async function main() {
  if (process.argv.includes("--dump-legacy-cases")) {
    console.log(
      JSON.stringify(
        LEGACY_CASES.map((c) => ({ id: c.id, description: c.description, repaired: true, executedByRecovery: false })),
        null,
        2,
      ),
    );
    return;
  }
  if (process.argv.includes("--offline")) {
    await runOfflineSuite();
    return;
  }

  // ══════════════════ RUNTIME GATE — FAIL CLOSED, NO FLAG ══════════════════
  // Any invocation that is not --offline/--dump-legacy-cases is a runtime
  // request and is REFUSED here, before a single filesystem write, subprocess
  // spawn, or network call. There is no CLI flag that re-enables the runtime:
  // see the RUNTIME_UNLOCKED documentation above. This notice is the entire
  // default-mode behavior.
  if (!RUNTIME_UNLOCKED) {
    const matrix = {};
    for (const c of CONTROLS) matrix[c.id] = "not-run";
    console.log("issue #22 recovery probe — RUNTIME BLOCKED (offline-authorization round, handoff-22)");
    console.log("");
    for (const u of RUNTIME_UNRESOLVED) console.log(`  UNRESOLVED: ${u}`);
    console.log("");
    for (const [k, v] of Object.entries(matrix)) console.log(`  ${k}: ${String(v).toUpperCase()}`);
    console.log("");
    console.log("  legacy A–E/P historical results are NOT success evidence (source-repaired, not re-run).");
    console.log("  authorized offline validation: node scripts/e2e/run-restoration-probe.mjs --offline");
    console.log(`exit: ${RUNTIME_BLOCKED_EXIT} (runtime blocked by default — fail closed)`);
    process.exitCode = RUNTIME_BLOCKED_EXIT;
    return;
  }

  // Defense in depth: the gate above is the primary block; this second guard
  // inside the runtime body ensures no future refactor of main() can reach
  // side-effectful code while the gate constant is false.
  if (!RUNTIME_UNLOCKED) {
    throw new Error("runtime body reached with RUNTIME_UNLOCKED === false — refuse");
  }

  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice(7).split(",").map((s) => s.trim()) : null;
  const controls = only ? CONTROLS.filter((c) => only.includes(c.id)) : CONTROLS;
  if (controls.length === 0) throw new Error(`no controls selected: ${onlyArg}`);

  if (!existsSync(SERVER_SCRIPT)) throw new Error(`missing ${SERVER_SCRIPT}`);
  if (!existsSync(FIXTURE_INDEX)) throw new Error(`missing ${FIXTURE_INDEX}`);
  // Hard sub-gates that must hold before ANY precondition even starts:
  if (!SANDBOX_ENDPOINT_SCOPING_VERIFIED) {
    throw new StopError("gate", "sandbox profile endpoint scoping UNVERIFIED — runtime cannot start", {
      unresolved: RUNTIME_UNRESOLVED[1],
    });
  }

  const bin = realpathSync(opencodeBin());
  const binDir = path.dirname(bin);
  // NOTE (handoff-22 repair): the old `execFileSync(bin, ["--version"])` ran
  // OUTSIDE the isolated environment (inherited host env/config) as a prelim
  // step. The version is now discovered ONLY under the isolated environment
  // (p3b below, via spawnTracked with the empty-allowlist env).
  let opencodeVersion = "unknown";
  let sdkVersion = "unknown";
  try {
    sdkVersion = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "node_modules", "@opencode", "plugin", "package.json"), "utf8"),
    ).version;
  } catch {}

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = path.join(OUT_ROOT, `probe-${stamp}-${process.pid}`);
  mkdirSync(path.join(evidenceDir, "captured"), { recursive: true });
  mkdirSync(path.join(evidenceDir, "logs"), { recursive: true });
  mkdirSync(path.join(evidenceDir, "runtime"), { recursive: true });
  mkdirSync(path.join(evidenceDir, "db"), { recursive: true });

  const preconditions = [];
  const controlResults = [];
  const unknownClaims = [];
  const limitations = [
    "probe sources are git-ignored and therefore NOT indexed by any symbol-graph impact tooling (GitNexus or equivalent): graph coverage of these edits cannot be inferred and was not attempted",
    "plugin-harness acceptance only — not scanner CLI/CI acceptance",
    "local history/evidence may contain synthetic originals by design",
    "refused-operation body non-entry is never inferred from missing returned content; R3 is proven by direct side-effect (receipt/result) absence plus the hook's refusal record, with R2 as the successful-body prerequisite",
    "CLI/process exit success is NEVER treated as plugin-semantics success: every control check is event/file/request-scoped evidence, and exit codes carry only harness disposition",
    "process cleanup proves direct children only; descendant termination is not claimed",
  ];
  let stopped = null;
  let harnessError = null;
  const cleanupStatus = [];
  let frozenManifest = null;
  let frozenVerified = null;
  let root = null;
  let rootReal = null;
  let serveProc = null;
  let captureProc = null;
  let serveLog = [];
  let captureLog = [];
  let authMode = "none";
  let apiToken = null;
  let runtime = null;
  let envKeysOk = null;
  let eventsFile = null;
  let canonical = [];
  let strayFiles = [];
  let dbCopies = [];
  let malformedEvidence = [];

  const stop = (stage, reason, detail) => {
    stopped = stopped ?? { stage, reason, detail };
    preconditions.push({ stage, pass: false, reason, detail: detail ?? null });
  };

  try {
    // p1 — tooling.
    try {
      if (!existsSync(SANDBOX_EXEC)) throw new Error(`sandbox-exec missing at ${SANDBOX_EXEC}`);
      const sq = execFileSync(SQLITE3, ["-readonly", "-json", ":memory:", "SELECT 1 AS ok"], { encoding: "utf8" });
      if (!JSON.parse(sq)[0]?.ok) throw new Error("sqlite3 -readonly -json unusable");
      preconditions.push({ stage: "p1-tooling", pass: true, opencodeVersion });
    } catch (err) {
      stop("p1-tooling", String(err?.message ?? err));
      throw new StopError("p1-tooling", "tooling preflight failed", String(err?.message ?? err));
    }

    // p2 — fresh owned workspace root.
    try {
      root = mkdtempSync(path.join(TMP_ROOT, "sgp22-"));
      rootReal = realpathSync(root);
      const chain = assertRealOwnedChain(root, TMP_ROOT);
      for (const sub of [
        "home",
        "tmp",
        "events",
        "refuse",
        path.join("xdg", "data"),
        path.join("xdg", "state"),
        path.join("xdg", "cache"),
        path.join("xdg", "config", "opencode"),
      ]) {
        mkdirSync(path.join(rootReal, sub), { recursive: true });
      }
      eventsFile = path.join(rootReal, "events", "events.jsonl");
      preconditions.push({
        stage: "p2-workspace",
        pass: true,
        root: rootReal,
        chain: chain.chain.map((c) => ({ path: c.path, ownedSegment: c.ownedSegment })),
      });
    } catch (err) {
      stop("p2-workspace", String(err?.message ?? err));
      throw new StopError("p2-workspace", "workspace containment failed", String(err?.message ?? err));
    }

    const capturePort = await freePort();
    const servePort = await freePort();
    const refuseDir = path.join(rootReal, "refuse");

    // p3 — frozen sources + empty-allowlist environment.
    const configDoc = buildConfig();
    configDoc.providers.capture.settings.baseURL = `http://127.0.0.1:${capturePort}/v1`;
    const configPath = path.join(rootReal, "xdg", "config", "opencode", "opencode.json");
    writeFileSync(configPath, JSON.stringify(configDoc, null, 2));
    const evidenceConfig = path.join(evidenceDir, "runtime", "opencode.json");
    copyFileSync(configPath, evidenceConfig);
    const consumedConfigCanonical = realpathSync(configPath); // authoritative provenance target
    const profilePath = path.join(evidenceDir, "confine.sb");
    writeFileSync(profilePath, buildSandboxProfile(rootReal));
    const preflightPath = path.join(evidenceDir, "confinement-preflight.mjs");
    writeFileSync(preflightPath, PREFLIGHT_SCRIPT);
    frozenManifest = {};
    for (const [name, p] of Object.entries({
      runner: RUNNER_SELF,
      "fixture-index": FIXTURE_INDEX,
      "fixture-package": path.join(FIXTURE_DIR, "package.json"),
      "capture-server": SERVER_SCRIPT,
      "opencode-bin": bin,
      "node-bin": process.execPath,
      sqlite3: SQLITE3,
      "sandbox-exec": SANDBOX_EXEC,
      // handoff-22 repair: hash the CONSUMED config file at its canonical
      // path (the old entry hashed the evidence COPY, which would not detect
      // the runtime consuming a different document); the copy is hashed too,
      // but only as secondary evidence.
      "consumed-config": consumedConfigCanonical,
      "runtime-config-copy": evidenceConfig,
      "sandbox-profile": profilePath,
      "preflight-script": preflightPath,
    })) {
      frozenManifest[name] = { path: p, sha256: sha256(p) };
    }
    writeFileSync(path.join(evidenceDir, "manifest-frozen.json"), JSON.stringify(frozenManifest, null, 2));

    const env = buildIsolatedEnv(rootReal, binDir, eventsFile, refuseDir);
    envKeysOk =
      JSON.stringify(Object.keys(env).sort()) === JSON.stringify([...ENV_ALLOWLIST_KEYS].sort());
    preconditions.push({
      stage: "p3-frozen-sources",
      pass: envKeysOk,
      envKeys: Object.keys(env).sort(),
      filesHashed: Object.keys(frozenManifest).length,
      consumedConfigCanonical,
    });
    if (!envKeysOk) {
      throw new StopError("p3-frozen-sources", "environment allowlist mismatch", {
        got: Object.keys(env).sort(),
      });
    }

    // p3b — ISOLATED version discovery (handoff-22 repair: the old
    // `execFileSync(bin, ["--version"])` prelim ran with the FULL inherited
    // host environment before any isolation existed — an unisolated OpenCode
    // invocation. It now runs under the empty-allowlist env only, and a
    // failure stops the run).
    const versionRun = await spawnTracked(bin, ["--version"], {
      cwd: rootReal,
      env,
      timeoutMs: 15000,
      label: "opencode-version-isolated",
    });
    if (versionRun.exitCode === 0 && versionRun.stdout.trim()) {
      opencodeVersion = versionRun.stdout.trim();
      preconditions.push({ stage: "p3b-version-isolated", pass: true, opencodeVersion });
    } else {
      stop("p3b-version-isolated", `isolated --version failed (exit ${versionRun.exitCode})`, {
        stderr: versionRun.stderr.slice(0, 300),
      });
      throw new StopError("p3b-version-isolated", "isolated version discovery failed", {
        exitCode: versionRun.exitCode,
        stderr: versionRun.stderr.slice(0, 300),
      });
    }

    // p4 — confinement preflight (independently enforced, empirically validated).
    // Unconfined contrast first: without the sandbox the SAME TEST-NET-1 probe
    // must time out (proven for this host). If the network itself fast-refuses
    // or connects, the contrast cannot demonstrate enforcement -> STOP.
    const unconfinedProbe = await (async () => {
      const t0 = Date.now();
      return await new Promise((resolve) => {
        const s = net.connect({ host: "192.0.2.1", port: 80 });
        const finish = (outcome, err) => {
          try {
            s.destroy();
          } catch {}
          resolve({ outcome, elapsedMs: Date.now() - t0, code: err?.code ?? null });
        };
        const timer = setTimeout(() => finish("timeout"), 1500);
        s.on("connect", () => {
          clearTimeout(timer);
          finish("connected");
        });
        s.on("error", (e) => {
          clearTimeout(timer);
          finish("error", e);
        });
      });
    })();
    const loopListener = net.createServer();
    const loopPort = await new Promise((resolve) => {
      loopListener.listen(0, "127.0.0.1", () => resolve(loopListener.address().port));
    });
    const preflightOut = path.join(rootReal, "preflight-result.json");
    const preflightRun = await spawnTracked(
      SANDBOX_EXEC,
      ["-f", profilePath, "--", process.execPath, preflightPath, rootReal, String(loopPort), preflightOut],
      { cwd: rootReal, env, timeoutMs: 20000, label: "confinement-preflight" },
    );
    loopListener.close();
    let preflight = null;
    try {
      preflight = JSON.parse(readFileSync(preflightOut, "utf8"));
      copyFileSync(preflightOut, path.join(evidenceDir, "preflight-result.json"));
    } catch {
      preflight = null;
    }
    const pfReasons = [];
    if (!preflight) pfReasons.push("no preflight result (sandbox-exec failed?)");
    else {
      if (!preflight.steps?.["write-inside-root"]?.ok) pfReasons.push("write inside root failed");
      if (preflight.steps?.["write-outside-root-must-be-denied"]?.ok) pfReasons.push("write OUTSIDE root NOT denied");
      if (!preflight.steps?.["read-system-binary"]?.ok) pfReasons.push("system read denied");
      if (preflight.loopback?.outcome !== "connected") pfReasons.push("loopback connect blocked");
      const ext = preflight.external ?? {};
      // Unconfined contrast must be a timeout; otherwise the confined result
      // below proves nothing about enforcement on this network.
      if (unconfinedProbe.outcome !== "timeout") {
        pfReasons.push(
          `unconfined contrast not a timeout (outcome=${unconfinedProbe.outcome}, code=${unconfinedProbe.code}) — enforcement not demonstrable`,
        );
      }
      if (ext.outcome === "connected") pfReasons.push("NON-LOOPBACK CONNECT SUCCEEDED (containment escape)");
      if (ext.outcome === "timeout") pfReasons.push("non-loopback connect not denied fast (profile unenforced)");
      // On this host seatbelt maps the network deny to a fast ECONNREFUSED
      // (unconfined timeout vs confined ~4 ms refuse, verified above).
      if (
        ext.outcome === "error" &&
        !(
          ext.elapsedMs < 1000 &&
          ["EPERM", "EACCES", "ECONNREFUSED"].includes(ext.code) &&
          unconfinedProbe.outcome === "timeout"
        )
      ) {
        pfReasons.push(`non-loopback denial not a contrastive fast sandbox deny (code=${ext.code}, elapsed=${ext.elapsedMs}ms)`);
      }
      if (preflight.exec?.status !== 0) pfReasons.push("exec under sandbox failed");
    }
    preconditions.push({
      stage: "p4-confinement",
      pass: pfReasons.length === 0,
      reasons: pfReasons,
      unconfinedContrast: unconfinedProbe,
      preflightExitCode: preflightRun.exitCode,
      preflightStderr: preflightRun.stderr.slice(0, 500),
      preflight,
    });
    if (pfReasons.length > 0) {
      throw new StopError("p4-confinement", "loopback-only confinement NOT enforceable", pfReasons);
    }

    // p5 — capture server (existing script, unmodified).
    // handoff-22 repair: the old spawn inherited the FULL host environment
    // (`{ ...process.env, CAPTURE_DIR }`) — an unisolated prelim process.
    // It now receives an explicit minimal environment (capture-server.mjs
    // reads only CAPTURE_DIR and argv; node itself needs no host vars).
    const captureEnv = {
      CAPTURE_DIR: path.join(evidenceDir, "captured"),
      HOME: path.join(rootReal, "home"),
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: path.join(rootReal, "tmp"),
      TZ: "UTC",
    };
    captureProc = spawn(process.execPath, [SERVER_SCRIPT, String(capturePort)], {
      env: captureEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    SPAWNED_COMMANDS.push({
      label: "capture-server",
      argv: [process.execPath, SERVER_SCRIPT, String(capturePort)],
    });
    captureProc.stdout.on("data", (d) => captureLog.push(d.toString()));
    captureProc.stderr.on("data", (d) => captureLog.push(d.toString()));
    const captureHealthy = await (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${capturePort}/health`);
          if (res.ok) return true;
        } catch {}
        await sleep(200);
      }
      return false;
    })();
    preconditions.push({ stage: "p5-capture-server", pass: captureHealthy, port: capturePort });
    if (!captureHealthy) {
      throw new StopError("p5-capture-server", "capture server not healthy", captureLog.join("").slice(0, 500));
    }

    // p6 — isolated sandboxed serve + API reachability.
    serveProc = spawn(
      SANDBOX_EXEC,
      ["-f", profilePath, "--", bin, "serve", "--hostname", "127.0.0.1", "--port", String(servePort)],
      { cwd: rootReal, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    SPAWNED_COMMANDS.push({
      label: "opencode-serve",
      argv: [
        SANDBOX_EXEC,
        "-f",
        profilePath,
        "--",
        bin,
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(servePort),
      ],
    });
    serveProc.stdout.on("data", (d) => serveLog.push(d.toString()));
    serveProc.stderr.on("data", (d) => serveLog.push(d.toString()));
    const serveUrl = `http://127.0.0.1:${servePort}`;
    const api = async (method, apiPath, init = {}) => {
      const headers = { "content-type": "application/json", ...(init.headers ?? {}) };
      if (apiToken) headers.authorization = `Bearer ${apiToken}`;
      return fetch(`${serveUrl}${apiPath}`, { ...init, method, headers, signal: AbortSignal.timeout(20000) });
    };
    let infoStatus = 0;
    let infoOk = false;
    let infoMode = "unreachable";
    {
      const deadline = Date.now() + SERVE_HEALTH_MS;
      while (Date.now() < deadline) {
        try {
          const res = await api("GET", "/api/info");
          infoStatus = res.status;
          if (res.ok) {
            infoOk = true;
            infoMode = "no-auth";
            break;
          }
          if (res.status === 401) {
            infoMode = "auth-required";
            break;
          }
        } catch {}
        await sleep(400);
      }
    }
    if (!infoOk && infoMode === "auth-required") {
      // Documented pairing flow (server group schema), used verbatim.
      try {
        const pair = await api("POST", "/api/pair", { body: "{}" });
        const pairJson = await pair.json().catch(() => null);
        const code = pairJson?.code ?? pairJson?.data?.code;
        if (code) {
          const conn = await fetch(`${serveUrl}/auth/connect/${code}`, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(10000),
          });
          const connJson = await conn.json().catch(() => null);
          apiToken = connJson?.token ?? null;
          if (apiToken) {
            authMode = "pairing-bearer";
            const retry = await api("GET", "/api/info");
            infoOk = retry.ok;
          }
        }
      } catch {}
    }
    preconditions.push({
      stage: "p6-serve",
      pass: infoOk,
      serveUrl,
      authMode,
      infoStatus,
      serveLogHead: serveLog.join("").slice(0, 800),
    });
    if (!infoOk) {
      throw new StopError("p6-serve", "isolated serve API not reachable under confinement", {
        mode: infoMode,
        serveLog: serveLog.join("").slice(0, 1200),
      });
    }

    // p7 — configuration containment (SOURCE-REPAIRED, quarantined runtime).
    const ancestryFindings = [];
    {
      let cur = rootReal;
      while (true) {
        for (const name of ["opencode.json", "opencode.jsonc", "AGENTS.md", "CLAUDE.md", "CONTEXT.md"]) {
          if (existsSync(path.join(cur, name))) {
            ancestryFindings.push({ dir: cur, file: name, outsideRoot: cur !== rootReal });
          }
        }
        if (cur === path.sep) break;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    // handoff-22 repair #1: the old check compared RELATIVE paths
    // (`path.relative(rootReal, p)` vs a joined relative literal) — fragile
    // and blind to symlink resolution. The unexpected-file filter now
    // compares CANONICAL (realpath) paths against the ACTUAL CONSUMED config
    // file's canonical path.
    const configTreeFiles = [];
    const walkCfg = (d) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkCfg(p);
        else configTreeFiles.push(realpathSync(p));
      }
    };
    walkCfg(path.join(rootReal, "xdg", "config"));
    walkCfg(path.join(rootReal, "home"));
    const homeTreeFiles = [];
    {
      const walkHome = (d) => {
        let entries;
        try {
          entries = readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walkHome(p);
          else homeTreeFiles.push(realpathSync(p));
        }
      };
      walkHome(path.join(rootReal, "home"));
    }
    const unexpectedConfigTree = configTreeFiles.filter((f) => f !== consumedConfigCanonical);
    const unexpectedHomeFiles = homeTreeFiles; // generated home tree must be EMPTY
    // handoff-22 repair #2: a FAILED config fetch now FAILS p7 (the old code
    // left configUrls empty on failure and passed vacuously).
    let configApi = null;
    let configFetchFailed = false;
    let configFetchError = null;
    let configUrls = [];
    try {
      const probeWs = mkdtempSync(path.join(root, "ws-cfgprobe-"));
      const res = await api("GET", `/api/config?location[directory]=${encodeURIComponent(probeWs)}`);
      if (!res.ok) {
        configFetchFailed = true;
        configFetchError = `GET /api/config -> HTTP ${res.status}`;
      } else {
        const json = await res.json();
        configApi = json?.data ?? json ?? null;
        configUrls = [...new Set(JSON.stringify(configApi).match(/https?:\/\/[^"\s]+/g) ?? [])];
      }
    } catch (err) {
      configFetchFailed = true;
      configFetchError = String(err?.message ?? err);
    }
    // handoff-22 repair #3: endpoints normalized as hostname:port (the old
    // `new URL(u).host` check compared host-with-port against a
    // hostname-only allowlist — wrong in BOTH directions for any URL with an
    // explicit port, which is precisely the loopback case that matters), and
    // the allowed set is the EXACT capture endpoint instead of "all
    // localhost". Plus exact provider/plugin/auth validation of the CONSUMED
    // effective document.
    const allowedEndpoints = allowedEndpointsFor(capturePort);
    const configValidation = configFetchFailed
      ? { ok: false, reasons: [`config fetch failed: ${configFetchError}`], urls: [] }
      : validateConsumedConfig(configApi, {
          expectedProviders: ["capture"],
          expectedPluginPackage: FIXTURE_DIR,
          expectedScenario: "R",
          // Exact generated capture profile (handoff-22 offline-oracle fix #1)
          expectedProviderPackage: "@opencode/ai/providers/openai-compatible",
          expectedProviderEnv: ["CAPTURE_API_KEY"],
          expectedSyntheticApiKey: "sg-e2e-capture",
          expectedCaptureEndpoint: `http://127.0.0.1:${capturePort}/v1`,
          expectedSchemaUrl: "https://opencode.ai/config.json",
          allowedEndpoints,
        });
    const badAncestry = ancestryFindings.filter((f) => f.outsideRoot);
    const p7Reasons = [
      ...badAncestry.map((f) => `config ancestry file outside root: ${f.dir}/${f.file}`),
      ...unexpectedConfigTree.map((f) => `unexpected config-tree file: ${f}`),
      ...unexpectedHomeFiles.map((f) => `unexpected file in generated home tree: ${f}`),
      ...configValidation.reasons.map((r) => `consumed-config: ${r}`),
    ];
    const p7Pass = p7Reasons.length === 0;
    preconditions.push({
      stage: "p7-config-containment",
      pass: p7Pass,
      ancestryFindings,
      configTreeFiles,
      consumedConfigCanonical,
      configApiUrls: configUrls,
      configEndpointsNormalized: configUrls.map((u) => `${u} -> ${normalizeEndpoint(u)}`),
      allowedEndpoints: [...allowedEndpoints].sort(),
      configValidation,
      reasons: p7Reasons,
      configApi,
    });
    if (!p7Pass) {
      throw new StopError("p7-config-containment", "unexpected configuration, provider/plugin set, auth source, or external endpoint", {
        reasons: p7Reasons,
      });
    }

    runtime = {
      root,
      rootReal,
      bin,
      env,
      profilePath,
      serveUrl,
      eventsFile,
      refuseDir,
      capturedDir: path.join(evidenceDir, "captured"),
      api,
      authMode,
      malformedCaptures: [],
      malformedEvents: [],
      postControl: async (payload) => {
        const res = await fetch(`http://127.0.0.1:${capturePort}/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`capture control ${res.status}`);
      },
    };

    // Bounded control sequence — stop on the first failed check.
    for (const def of controls) {
      process.stderr.write(`[probe] control ${def.id} …\n`);
      const result = await runControl(def, runtime);
      writeFileSync(path.join(evidenceDir, "logs", `${def.id}.stdout.txt`), result._rawLogs.stdout);
      writeFileSync(path.join(evidenceDir, "logs", `${def.id}.stderr.txt`), result._rawLogs.stderr);
      delete result._rawLogs;
      controlResults.push(result);
      const failed = Object.entries(result.checks).filter(([, v]) => !v).map(([k]) => k);
      // Final bounded correction: an explicit UNKNOWN verdict (R4a's withheld
      // complete gate) is NOT a pass — stop as unknown, never "all checks passed".
      const unknownVerdict = result.verdict === "UNKNOWN";
      process.stderr.write(
        `[probe] control ${def.id} -> ${
          failed.length
            ? "FAIL: " + failed.join(", ")
            : unknownVerdict
              ? "UNKNOWN (not a pass): complete verdict withheld — unproven denial provenance"
              : "all checks passed"
        }\n`,
      );
      if (failed.length > 0 || unknownVerdict || result.runTimedOut) {
        stopped = stopped ?? {
          stage: def.id,
          reason: failed.length
            ? `failed checks: ${failed.join(", ")}`
            : unknownVerdict
              ? "UNKNOWN verdict: complete gate withheld (deny->error causality not independently verifiable this round) — not a pass"
              : "invocation timed out",
        };
        break;
      }
    }
  } catch (err) {
    if (err?.stopInfo) {
      stopped = stopped ?? err.stopInfo;
    } else {
      harnessError = String(err?.stack ?? err);
    }
  } finally {
    // Bounded process-group cleanup with deadlines. TRUTH ONLY: killGroup
    // reports the direct child's outcome; descendant termination is NOT
    // claimed (no process-tree walk proves grandchildren died — recorded as a
    // limitation in the evidence, never asserted as success).
    if (serveProc) cleanupStatus.push({ target: "opencode-serve", result: await killGroup(serveProc) });
    if (captureProc) cleanupStatus.push({ target: "capture-server", result: await killGroup(captureProc) });
    cleanupStatus.push({
      target: "descendants",
      result: "not-claimable",
      note: "direct-children-only kills; descendant termination not independently proven and not claimed",
    });

    // Post-run analysis while the workspace still exists.
    if (root && existsSync(root)) {
      try {
        const dbs = findSqliteDbs([path.join(rootReal, "xdg", "data"), path.join(rootReal, "xdg", "state")]);
        for (const db of dbs.slice(0, 4)) {
          try {
            copyFileSync(db.path, path.join(evidenceDir, "db", path.basename(db.path)));
            dbCopies.push({ path: path.relative(rootReal, db.path), size: db.size });
          } catch {}
        }
        // Canonical stored-message acceptance: explicit UNKNOWN stub (see
        // canonicalStoredMessages). DB copies remain FORENSIC-ONLY evidence.
        for (const result of controlResults) {
          const def = CONTROLS.find((c) => c.id === result.control);
          if (!def?.canonicalNeedles?.length) continue;
          canonical.push(canonicalStoredMessages(result.control, result.sessionID, def.canonicalNeedles));
          unknownClaims.push(
            `${result.control}: canonical stored-message persistence is UNKNOWN — no canonical query verified against the installed schema this round (broad table scans removed; DB copies are forensic evidence only, never acceptance)`,
          );
        }
        // Containment double-check: receipt/result files only where expected.
        const expected = new Set(
          controlResults
            .filter((r) => ["R2", "R4b"].includes(r.control) && !r.runTimedOut)
            .map((r) => realpathSync(r.ws)),
        );
        const walkStray = (d) => {
          let entries;
          try {
            entries = readdirSync(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walkStray(p);
            else if (e.name === "receipt.txt" || e.name === "result.txt") {
              if (!expected.has(realpathSync(path.dirname(p)))) strayFiles.push(path.relative(rootReal, p));
            }
          }
        };
        walkStray(root);
      } catch (err) {
        cleanupStatus.push({ target: "post-analysis", result: `error: ${String(err?.message ?? err)}` });
      }
      try {
        if (eventsFile && existsSync(eventsFile)) {
          copyFileSync(eventsFile, path.join(evidenceDir, "events.jsonl"));
        }
      } catch {}
    }
    try {
      writeFileSync(path.join(evidenceDir, "serve.log.txt"), serveLog.join(""));
      writeFileSync(path.join(evidenceDir, "capture-server.log"), captureLog.join(""));
    } catch {}

    // Frozen-source verification (after the sequence).
    if (frozenManifest) {
      frozenVerified = { verified: true, mismatches: [] };
      for (const [name, entry] of Object.entries(frozenManifest)) {
        try {
          if (sha256(entry.path) !== entry.sha256) frozenVerified.mismatches.push(name);
        } catch {
          frozenVerified.mismatches.push(`${name} (unreadable)`);
        }
      }
      frozenVerified.verified = frozenVerified.mismatches.length === 0;
    }

    // Malformed evidence of any kind is a harness-integrity FAILURE (exit 1),
    // never discarded and never merely "unknown".
    if (runtime && (runtime.malformedCaptures.length > 0 || runtime.malformedEvents.length > 0)) {
      malformedEvidence.push(
        ...runtime.malformedCaptures.map((m) => `capture ${m.control}/${m.file}: ${m.reason}`),
        ...runtime.malformedEvents.map((m) => `event-log ${m.control}: unparseable line ${JSON.stringify(m.line)}`),
      );
    }

    // Remove the workspace root (bounded; failure is recorded, not ignored).
    if (root && existsSync(root)) {
      try {
        rmSync(root, { recursive: true, force: true });
        cleanupStatus.push({ target: "workspace-root", result: "removed" });
      } catch (err) {
        cleanupStatus.push({ target: "workspace-root", result: `rm-failed: ${String(err?.message ?? err)}` });
      }
    }
  }

  // ---------------------------------------------------------------- evidence --
  const matrix = {};
  for (const r of controlResults) {
    const failed = Object.values(r.checks).some((v) => !v);
    matrix[r.control] = r.runTimedOut ? "unknown" : failed ? "fail" : "pass";
  }
  for (const def of controls) {
    if (!(def.id in matrix)) matrix[def.id] = "not-run";
  }
  const cleanupFailed = cleanupStatus.some(
    (c) => !["removed", "already-exited", "killed", "not-claimable"].includes(c.result),
  );
  const hardFail =
    Object.values(matrix).includes("fail") || Boolean(stopped) || malformedEvidence.length > 0;
  const hasUnknown =
    Object.values(matrix).includes("unknown") || Object.values(matrix).includes("not-run") || unknownClaims.length > 0;
  const exitCode = harnessError
    ? 2
    : hardFail
      ? 1
      : !frozenVerified?.verified || cleanupFailed
        ? 1
        : hasUnknown
          ? 3
          : 0;

  const evidence = {
    generatedAt: new Date().toISOString(),
    probe: "issue #22 bounded recovery sequence (handoff-22 oracle plan)",
    runtimeGate: {
      RUNTIME_UNLOCKED,
      blockedByDefault: true,
      unresolved: RUNTIME_UNRESOLVED,
      note: "runtime is blocked by default with no re-enable flag; this evidence can only exist if the source gate was deliberately unlocked with documented prerequisites and recorded user approval",
    },
    opencodeVersion,
    pluginSdkVersionInstalled: sdkVersion,
    nodeVersion: process.version,
    evidenceDir,
    syntheticOnly: true,
    preconditions,
    stopped,
    harnessError,
    authMode,
    envAllowlistKeys: ENV_ALLOWLIST_KEYS,
    envKeysMatchAllowlist: envKeysOk,
    commandsExecuted: SPAWNED_COMMANDS,
    frozenManifest,
    frozenManifestVerified: frozenVerified,
    controls: controlResults,
    canonicalStoredMessages: canonical,
    unknownClaims,
    limitations: [
      ...limitations,
      ...controlResults.flatMap((r) => (r.limitations ?? []).map((l) => `${r.control}: ${l}`)),
    ],
    straySideEffectFiles: strayFiles,
    dbCopies: dbCopies.map((d) => ({ ...d, forensicOnly: true })),
    malformedEvidence,
    legacyNote:
      "legacy A–E/P case definitions retained source-repaired in this file for inspection (--dump-legacy-cases); NOT executed by this recovery and NO legacy pass is claimed",
    cleanup: { status: cleanupStatus, failed: cleanupFailed },
    matrix,
    exitCode,
    pendingGates: [
      "real UI (TUI/OpenChamber) rendering of restored values",
      "compaction/generate auxiliary request protection",
      "WebSocket/production streaming transports and ordering",
      "production streaming-safe response rewriting",
      "plugin ordering interaction",
      "shell/typed-argument semantics beyond this bounded sequence",
      "session/mapping failure integrity beyond the R3 refusal shape",
    ],
  };
  writeFileSync(path.join(evidenceDir, "evidence.json"), JSON.stringify(evidence, null, 2));

  console.log(`\nissue #22 recovery probe — ${opencodeVersion} / @opencode/plugin ${sdkVersion}`);
  for (const [k, v] of Object.entries(matrix)) console.log(`  ${k}: ${String(v).toUpperCase()}`);
  if (stopped) console.log(`STOPPED at ${stopped.stage}: ${stopped.reason}`);
  for (const u of unknownClaims) console.log(`UNKNOWN: ${u}`);
  if (!frozenVerified?.verified) console.log(`FROZEN-SOURCE MISMATCH: ${frozenVerified?.mismatches}`);
  if (cleanupFailed) console.log(`CLEANUP FAILURE: ${JSON.stringify(cleanupStatus)}`);
  console.log(`evidence: ${evidenceDir}`);
  console.log(`exit: ${exitCode}`);
  process.exitCode = exitCode;
}

// ─────────────────────── ESM entrypoint guard (oracle fix) ───────────────────
// The old unconditional `main().catch(...)` ran main() for ANY importer,
// printing the blocked notice and mutating process.exitCode according to the
// IMPORTING process's argv. Known ESM main check: this module is the CLI
// entry only when the resolved argv[1] file URL equals this module's own
// import.meta.url. Importers (different argv[1], or none) execute NOTHING.
function computeIsCliMain(argv1, moduleUrl) {
  if (!argv1 || typeof argv1 !== "string") return false;
  try {
    return pathToFileURL(path.resolve(argv1)).href === moduleUrl;
  } catch {
    return false;
  }
}

// Pure-validation surface for importers (mirrors the fixture's
// __probeInternals pattern). Importing this module is side-effect free.
const __probeRunnerInternals = {
  normalizeEndpoint,
  allowedEndpointsFor,
  validateConsumedConfig,
  parseEventLines,
  canonicalStoredMessages,
  computeIsCliMain,
  CONTROLS,
  LEGACY_CASES,
};
export { __probeRunnerInternals };

if (computeIsCliMain(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(`probe harness error: ${err?.stack ?? err}`);
    process.exit(2);
  });
}

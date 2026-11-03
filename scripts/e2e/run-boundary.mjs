#!/usr/bin/env node
/**
 * Boundary-evidence orchestrator for GitHub issue #19 (leakshield).
 *
 * Runs real `opencode run --standalone` sessions against a local capture
 * server that stands in for the model provider, and records — per case —
 * whether synthetic canary values reach:
 *   1. provider request bodies (out/captured/<case>-<seq>.json),
 *   2. session storage / logs under the isolated XDG dirs,
 *   3. the run's own stdout.
 *
 * Cases:
 *   C1 block        leakshield {mode:"block"}    + canary prompt
 *   C2 redact       leakshield {mode:"redact"}   + canary prompt
 *   C3 tool-output  leakshield {mode:"redact"}   + notes.txt canaries
 *                  (capture server forces a read tool_call on reply #1)
 *   C4a order1      [leakshield(redact), canary-injector] "Say hi."
 *   C4b order2      [canary-injector, leakshield(redact)] "Say hi."
 *   C5 invalid      leakshield {mode:"bogus"}    + canary prompt (fail-closed)
 *   C6 absent       no plugins                        + canary prompt (expected leak;
 *                  documents the deployment boundary, NOT a product failure)
 *   C7 deidentify   leakshield {mode:"redact",
 *                  deidentify:true} + email-twice prompt (issue #20 trial:
 *                  stable per-session [SG-EMAIL-… placeholders, no canary)
 *   C8 ignore       leakshield {mode:"redact"} + canary prompt carrying
 *                  '// sg-ignore' on the same line (in-text ignore directives
 *                  must not bypass the model boundary)
 *   C9 resume       leakshield {mode:"redact",deidentify:true}, TWO
 *                  standalone invocations (run 2 uses --continue in the same
 *                  workdir): replayed history + new prompt stay canary-free;
 *                  documents placeholder rotation across server restarts
 *                  (new process = new master key; placeholder stability is
 *                  scoped to one live session/server)
 *   C10 transparent leakshield {mode:"transparent"} + canary prompt
 *                  (issue #22): canaries replaced by [SGP…] tokens at the
 *                  provider boundary; none reach it raw
 *   C11 transparent-tool
 *                  {mode:"transparent"} + notes.txt canaries (capture server
 *                  forces a read tool_call): tool result re-masked before the
 *                  follow-up provider request
 *   C12 transparent-resume
 *                  {mode:"transparent"}, TWO standalone invocations (run 2 uses
 *                  --continue): locally stored originals replayed from history
 *                  must be re-masked; no canary may cross the provider boundary
 *   C13 transparent-restore
 *                  {mode:"transparent"} + single-secret prompt; the capture
 *                  server echoes the [SGP…] token back as a tool_call so the
 *                  plugin's pre-execution restoration is proved by the file the
 *                  tool writes (provider never sees the plaintext)
 *   C14 context-file
 *                  {mode:"transparent"} + AGENTS.md carrying canaries in the
 *                  workdir; v2 loads instruction files into model context —
 *                  no canary may cross the boundary in title or main requests
 *   C15 retry-cut-stream
 *                  {mode:"transparent"}; server cuts the SSE stream mid-reply
 *                  on the first main request — any retry attempt must carry
 *                  the same masking, no canary may leak on any attempt
 *   C16 tool-error
 *                  {mode:"transparent"}; forced read of a canary-named MISSING
 *                  file embeds the canary in the tool error text; the
 *                  follow-up request must carry the masked error, not the raw one
 *   C17 reply-restore
 *                  {mode:"transparent"}; the provider's text reply references
 *                  the [SGP…] token; the user-facing assistant output must
 *                  show the RESTORED original, never a raw token
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
import { resultExitCode } from "./result-status.mjs";
import { hasTransparentToken, TRANSPARENT_TOKEN } from "./transparent-token.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(E2E_DIR, "..", "..");
const OUT_DIR = path.join(E2E_DIR, "out");
const CAPTURED_DIR = path.join(OUT_DIR, "captured");
// Case workdirs live OUTSIDE the repo: OpenCode's config discovery walks up from
// cwd, and a repo-internal workdir would pick up this repo's own `.opencode/`
// directory (plugins, worktree state), contaminating or stalling the runs.
const WORK_ROOT = path.join(os.tmpdir(), "leakshield-e2e-work");
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
  blockedNotice: "[LeakShield blocked",
  redacted: "[REDACTED_",
  deidentified: "[SG-EMAIL-",
  transparentToken: TRANSPARENT_TOKEN.source,
  secondPluginMarker: "SECOND-PLUGIN-MARKER",
};
const CANARY_PROMPT =
  "Contact alice.canary@example-test.invalid and bob.canary@example-test.invalid about sk-CANARYTEST1234567890abcdef rotation.";
const LITERAL_MARKER_FIXTURES = [
  { id: "foreign-valid", value: `[SGP1:${"deadbeef".repeat(4)}-00000001]` },
  { id: "foreign-valid-v2", value: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]" },
  { id: "malformed-example", value: "[SGP1:…]" },
  { id: "malformed-example-v2", value: "[SGP2:…]" },
];

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
    description: "plugin order [leakshield(redact), canary-injector]: does injected canary reach provider?",
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
    description: "plugin order [canary-injector, leakshield(redact)]: does injected canary reach provider?",
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
  {
    id: "C9-resume",
    description:
      "session resume: run 2 (`--continue`, same workdir/XDG dirs → same session storage, NEW server process) replays history + adds a new canary prompt; neither run may leak canaries; documents placeholder rotation across server restarts (per-process master key — stability scope is one live session/server)",
    plugins: [{ package: DIST_DIR, options: { mode: "redact", deidentify: true } }],
    prompt:
      "Team contacts: alice.canary@example-test.invalid and bob.canary@example-test.invalid. Reach alice.canary@example-test.invalid first.",
    followUp: {
      args: [
        "run",
        "--standalone",
        "--format",
        "json",
        "--model",
        "capture/capture-1",
        "--continue",
        "Follow up with alice.canary@example-test.invalid again please.",
      ],
    },

    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider across session resume (replayed history or new prompt unscrubbed)" };
      if (r.requests.length === 0)
        return { verdict: "observe", reason: "no provider request observed; inspect out/logs" };
      // Distinct [SG-EMAIL-<16 hex>] placeholders per invocation (requests
      // already carry placeholderCounts keyed by the 16-hex digest).
      const run1Ph = new Set();
      const run2Ph = new Set();
      for (const q of r.requests)
        for (const ph of Object.keys(q.placeholderCounts ?? {})) (q.run === 2 ? run2Ph : run1Ph).add(ph);
      const distinct = new Set([...run1Ph, ...run2Ph]);
      if (distinct.size === 0)
        return {
          verdict: "observe",
          reason: "no canary but also no [SG-EMAIL-… placeholder in any provider request — replayed history did not carry protected text; inspect out/logs",
        };
      // alice.canary appears in BOTH prompts: a run-2 placeholder absent from
      // run 1 means the same address mapped to a different digest after the
      // server restart (expected per-process behavior, NOT a failure).
      const rotated = [...run2Ph].some((ph) => !run1Ph.has(ph));
      return {
        verdict: "pass",
        reason:
          `no canary in any provider request across both runs; ${distinct.size} distinct [SG-EMAIL-… placeholder(s) present` +
          (rotated
            ? "; placeholder rotation across server restarts observed (expected)"
            : "; no placeholder rotation observed (run 2 reproduced run 1 placeholders)"),
      };
    },
  },
  {
    id: "C10-transparent",
    description:
      "transparent pseudonymization (issue #22): {mode:\"transparent\"}; canaries must be replaced with [SGP…] tokens at the provider boundary, none reach it raw",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider despite transparent pseudonymization" };
      if (r.requests.length === 0)
        return {
          verdict: "observe",
          reason:
            "no provider request observed — transparent mode may have refused the route/hook, or the run failed; inspect out/logs",
        };
      const tokenRequests = r.requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return {
          verdict: "fail",
          reason: "no [SGP…] token in any provider request — content was neither blocked nor pseudonymized (check mode/options)",
        };
      if (r.timedOut || r.exitCode !== 0)
        return {
          verdict: "observe",
          reason: `no canary and [SGP…] tokens present, but the run did not exit cleanly (exit=${r.exitCode}, timedOut=${r.timedOut}); inspect out/logs`,
        };
      return {
        verdict: "pass",
        reason: `no canary in any provider request; [SGP…] tokens present in ${tokenRequests} request(s)`,
      };
    },
  },
  {
    id: "C11-transparent-tool",
    description:
      "transparent + tool replay: forced read of notes.txt (canaries); the tool result must be re-masked before the follow-up provider request, no canary escapes",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: "Read the file notes.txt and summarize it.",
    notesFile: true,
    control: { label: "C11-transparent-tool", toolCallNext: true, toolName: "read", toolArgs: { path: "notes.txt" } },
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider in the transparent tool round-trip" };
      const mainReqs = r.requests.filter((q) => q.hasTools);
      if (mainReqs.length === 0)
        return { verdict: "observe", reason: "no tools-bearing request observed; inspect out/logs" };
      if (mainReqs.length < 2)
        return {
          verdict: "observe",
          reason: "tool round-trip did not complete (no follow-up tools-bearing request); inspect tool name/args in out/logs",
        };
      const tokenRequests = r.requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return { verdict: "fail", reason: "no [SGP…] token in any provider request — tool output was neither blocked nor pseudonymized" };
      return {
        verdict: "pass",
        reason: `no canary across the tool round-trip; [SGP…] tokens present in ${tokenRequests} request(s)`,
      };
    },
  },
  {
    id: "C12-transparent-resume",
    description:
      "transparent + session resume: run 2 (`--continue`, same workdir/XDG dirs, NEW server process) replays locally stored originals and must re-mask them; no canary may reach the provider across either run",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt:
      `Team contacts: alice.canary@example-test.invalid and bob.canary@example-test.invalid. Reach alice.canary@example-test.invalid first. Explain these literal strings: ${LITERAL_MARKER_FIXTURES.map((marker) => marker.value).join(" and ")}.`,
    literalMarkers: LITERAL_MARKER_FIXTURES,
    followUp: {
      args: [
        "run",
        "--standalone",
        "--format",
        "json",
        "--model",
        "capture/capture-1",
        "--continue",
        "Continue using the contacts from prior context; do not ask me to repeat them.",
      ],
    },
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider across transparent session resume" };
      if (r.followUpCanaries.length > 0)
        return { verdict: "fail", reason: "C12 follow-up prompt must be canary-free to attribute run-2 tokens to replay" };
      const run1Requests = r.requests.filter((q) => q.run === 1);
      const run2Requests = r.requests.filter((q) => q.run === 2);
      if (run1Requests.length === 0 || run2Requests.length === 0 || r.runs?.some((run) => run.exitCode !== 0 || run.timedOut))
        return {
          verdict: "observe",
          reason: "both runs must complete cleanly and reach the provider; inspect out/logs",
        };
      const run1TokenRequests = run1Requests.filter((q) => q.markers.includes("transparentToken")).length;
      const run2TokenRequests = run2Requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (run1TokenRequests === 0 || run2TokenRequests === 0)
        return {
          verdict: "observe",
          reason: "run 2 must carry a protected replay token; run 1 alone does not prove replay protection",
        };
      const expectedLiteralIds = LITERAL_MARKER_FIXTURES.map((marker) => marker.id);
      const markersSurvived = (requests) =>
        requests.some((request) => expectedLiteralIds.every((id) => request.literalMarkerIds.includes(id)));
      if (!markersSurvived(run1Requests) || !markersSurvived(run2Requests))
        return {
          verdict: "fail",
          reason: "unknown and malformed marker examples must remain literal in both the original and replayed history",
        };
      return {
        verdict: "pass",
        reason: `no canary in any provider request; protected tokens and all literal marker examples observed in run 1 and run 2 after a canary-free follow-up prompt`,
      };
    },
  },
  {
    id: "C13-transparent-restore",
    description:
      "transparent + tool restoration (issue #22): the provider returns a [SGP…] token as a read path; the tool must read a local fixture whose filename is the original key, while the provider never sees the plaintext",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: "Read the deployment key file sk-CANARYTEST1234567890abcdef.",
    control: { label: "C13-transparent-restore", echoTokenNext: true },
    restoreSource: "high-key",
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider in the transparent restore case" };
      const tokenRequests = r.requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return { verdict: "fail", reason: "no [SGP…] token in any provider request — content was not pseudonymized" };
      if (r.timedOut || r.exitCode !== 0)
        return {
          verdict: "observe",
          reason: `run did not exit cleanly (exit=${r.exitCode}, timedOut=${r.timedOut}); inspect out/logs`,
        };
      if (r.restoredExactPathRead)
        return {
          verdict: "pass",
          reason: "provider never saw the plaintext; the local read tool successfully opened the exact ORIGINAL key path after token restoration",
        };
      return {
        verdict: "observe",
        reason: "the read tool did not successfully open the original-key path; inspect out/logs",
      };
    },
  },
  {
    id: "C14-context-file",
    description:
      "transparent + instruction context: AGENTS.md in the workdir carries canaries; v2 loads instruction files into model context — neither title nor main requests may leak them",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: "Summarize the workspace policy in one sentence.",
    agentsFile: true,
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary from AGENTS.md leaked to the provider" };
      const tokenRequests = r.requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return {
          verdict: "observe",
          reason: "no [SGP…] token in any request — this host version may not load AGENTS.md as context in standalone runs; inspect out/captured",
        };
      return {
        verdict: "pass",
        reason: "instruction-file canaries replaced by [SGP…] tokens at the provider boundary",
      };
    },
  },
  {
    id: "C15-retry-cut-stream",
    description:
      "transparent + transport retry: the capture server cuts the SSE stream mid-reply on the first main request; any retry attempt must carry the same masking — no canary may leak on any attempt",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    control: { label: "C15-retry-cut-stream", cutStreamNext: true },
    expectation: (r) => {
      const mains = r.requests.filter((q) => q.hasTools);
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked on some request attempt" };
      if (mains.length >= 2)
        return {
          verdict: "pass",
          reason: `stream cut + retry: ${mains.length} main attempts, all canary-free (each retry re-masked at the wire)`,
        };
      if (mains.length === 1)
        return {
          verdict: "observe",
          reason: "host did not retry the cut stream (surfaced the failure instead); the single attempt was canary-free",
        };
      return { verdict: "observe", reason: "no main request observed; inspect out/logs" };
    },
  },
  {
    id: "C16-tool-error",
    description:
      "transparent + tool error text: a forced read of a canary-named missing file embeds the canary in the tool error message; the follow-up request must carry a masked error, not the original",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: "Read the deployment notes.",
    control: {
      label: "C16-tool-error",
      toolCallNext: true,
      toolName: "read",
      toolArgs: { path: "notes-alice.canary@example-test.invalid.txt" },
    },
    expectation: (r) => {
      const mains = r.requests.filter((q) => q.hasTools);
      const later = mains.slice(1);
      if (later.length === 0)
        return {
          verdict: "observe",
          reason: "tool-error round-trip did not complete (no follow-up main request); inspect out/logs",
        };
      if (later.some((q) => q.canaries.length > 0))
        return { verdict: "fail", reason: "canary from the tool error message reached the provider" };
      if (later.some((q) => q.markers.includes("transparentToken")))
        return {
          verdict: "pass",
          reason: "canary-bearing tool error re-masked ([SGP…] present) before the follow-up request",
        };
      return { verdict: "observe", reason: "follow-up clean but no token evidence; inspect out/captured" };
    },
  },
  {
    id: "C17-reply-restore",
    description:
      "transparent + normal conversation: the provider's text reply references the [SGP…] token; the user-facing assistant output must show the RESTORED original, never a raw token",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    control: { label: "C17-reply-restore", echoTokenInTextNext: true },
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to provider" };
      // Scope to assistant-role parts when role info exists, so the user's
      // own prompt echo cannot fake a "restored" signal.
      const parts = r.assistantParts ?? [];
      const assistantRole = parts.filter((p) => p.role === "assistant");
      const scoped =
        assistantRole.length > 0 ? assistantRole.map((p) => p.text).join("\n") : (r.assistantText ?? "");
      if (scoped.trim().length === 0)
        return {
          verdict: "observe",
          reason: "no assistant text observed; rerun with E2E_DUMP_STDOUT=1 and inspect out/logs/C17-reply-restore.stdout.txt",
        };
      const rawTokenVisible = TRANSPARENT_TOKEN.test(scoped);
      const restoredVisible = scoped.includes("alice.canary@example-test.invalid");
      if (rawTokenVisible && !restoredVisible)
        return { verdict: "fail", reason: "user-facing assistant output shows a raw [SGP…] token — display restoration missing" };
      if (rawTokenVisible && restoredVisible)
        return { verdict: "fail", reason: "restored original AND raw token both visible in user-facing output" };
      if (restoredVisible)
        return { verdict: "pass", reason: "provider replied with a token; user-facing output shows the restored original (normal-conversation UX)" };
      return { verdict: "observe", reason: "assistant text observed but neither token nor restored original found — arming may have missed; inspect out/logs dump" };
    },
  },
  {
    id: "C18-anthropic-transparent",
    description:
      "Phase 3 / Anthropic Messages native protocol: {mode:'transparent'} over an Anthropic-native provider — canaries must arrive as [SGP…] tokens on /v1/messages, and the token-bearing reply must display restored originals",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    anthropicProvider: true,
    control: { label: "C18-anthropic-transparent", echoTokenInTextNext: true },
    expectation: (r) => {
      const requests = r.requests;
      const onMessages = requests; // captured bodies from /v1/messages (canary scan is path-agnostic)
      if (onMessages.length === 0)
        return { verdict: "observe", reason: "no provider request captured; inspect out/logs (anthropic provider may have failed to load)" };
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to the Anthropic-native provider" };
      const tokenRequests = requests.filter((q) => q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return { verdict: "fail", reason: "no [SGP…] token in any /v1/messages request — body was not pseudonymized" };
      // Display restore: the reply embeds a token; user-facing output shows originals
      const parts = r.assistantParts ?? [];
      const assistantRole = parts.filter((p) => p.role === "assistant");
      const scoped = assistantRole.length > 0 ? assistantRole.map((p) => p.text).join("\n") : (r.assistantText ?? "");
      const rawTokenVisible = TRANSPARENT_TOKEN.test(scoped);
      const restoredVisible = scoped.includes("alice.canary@example-test.invalid");
      if (rawTokenVisible)
        return { verdict: "fail", reason: "user-facing output shows a raw [SGP…] token over the Anthropic route" };
      if (restoredVisible)
        return { verdict: "pass", reason: "Anthropic-native round-trip: tokens on the wire, originals in display" };
      return { verdict: "observe", reason: "wire masking proven; display-restore signal missing (reply arming may have missed); inspect out/logs" };
    },
  },
  {
    id: "C19-responses-transparent",
    description:
      "Phase 3 / OpenAI Responses native protocol: {mode:'transparent'} over the OpenAI Responses provider — canaries must arrive as [SGP…] tokens on /v1/responses, and the token-bearing reply must display restored originals",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    responsesProvider: true,
    control: { label: "C19-responses-transparent", echoTokenInTextNext: true },
    expectation: (r) => {
      if (r.exitCode !== 0 || r.timedOut)
        return { verdict: "fail", reason: "Responses primary invocation failed or timed out; title capture is not a successful round-trip" };
      if (r.requests.length === 0)
        return { verdict: "fail", reason: "no provider request captured; inspect out/logs" };
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to the Responses-native provider" };
      const tokenRequests = r.requests.filter((q) => q.hasTools && q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return { verdict: "fail", reason: "no token-bearing primary Responses request; title-only capture is insufficient" };
      const parts = r.assistantParts ?? [];
      const assistantRole = parts.filter((p) => p.role === "assistant");
      const scoped = assistantRole.length > 0 ? assistantRole.map((p) => p.text).join("\n") : (r.assistantText ?? "");
      if (TRANSPARENT_TOKEN.test(scoped))
        return { verdict: "fail", reason: "user-facing output shows a raw [SGP…] token over the Responses route" };
      if (scoped.includes("alice.canary@example-test.invalid"))
        return { verdict: "pass", reason: "Responses-native round-trip: tokens on the wire, originals in display" };
      return { verdict: "fail", reason: "primary display-restore signal missing; inspect out/logs" };
    },
  },
  {
    id: "C19-ws-http-fallback",
    description:
      "Explicit WebSocket transport on the Responses provider against an HTTP-only capture server: the host's WS connect fails and falls back to HTTP, and the protected HTTP primary carries tokens with no canary",
    plugins: [{ package: DIST_DIR, options: { mode: "transparent" } }],
    prompt: CANARY_PROMPT,
    responsesProvider: true,
    responsesTransport: "websocket",
    printLogs: true,
    control: { label: "C19-ws-http-fallback" },
    expectation: (r) => {
      if (r.canariesInProviderRequests.length > 0)
        return { verdict: "fail", reason: "canary leaked to the provider during the WebSocket fallback" };
      if (r.timedOut || r.exitCode !== 0)
        return { verdict: "fail", reason: "primary run failed or timed out; the HTTP fallback is not proven" };
      if (!r.wsHttpFallbackLogged)
        return { verdict: "fail", reason: "host did not log 'session websocket connect failed; using http': host behaviour changed or a real WebSocket connection was made; inspect out/logs" };
      const tokenRequests = r.requests.filter((q) => q.hasTools && q.markers.includes("transparentToken")).length;
      if (tokenRequests === 0)
        return { verdict: "fail", reason: "no token-bearing primary request reached the HTTP capture after the fallback" };
      return { verdict: "pass", reason: "WebSocket connect failed and the host fell back to protected HTTP: tokens on the wire, no canary" };
    },
  },
];

// ------------------------------------------------------------- utilities --
// Exercise built-in OpenAI's default transport/auth setup as well as the
// custom native-package provider. Both use only the local capture endpoint.
const responsesCase = CASES.find((caseDef) => caseDef.id === "C19-responses-transparent");
CASES.push({
  ...responsesCase,
  id: "C19-native-openai",
  description: "Built-in OpenAI identity with no explicit transport: protected HTTP Responses round-trip",
  responsesProviderID: "openai",
  control: { ...responsesCase.control, label: "C19-native-openai" },
});

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

/**
 * Spawn ONE `opencode` invocation and resolve when it exits (or is killed on
 * timeout). stdin is 'ignore': a piped-open stdin makes `opencode run` wait
 * for EOF and hang.
 */
function runOpencodeOnce(args, cwd, env) {
  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(opencodeBin(), args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
  });
}

function readToolOpenedExactPath(stdout, expectedPath) {
  return stdout.split(/\r?\n/).some((line) => {
    try {
      const event = JSON.parse(line);
      const state = event?.part?.state;
      return (
        event?.type === "tool_use" &&
        event.part.tool === "read" &&
        state?.status === "completed" &&
        typeof state.output === "string" &&
        state.output.startsWith(`Read file ${expectedPath}, lines `)
      );
    } catch {
      return false;
    }
  });
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
  const providers = {
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
  };
  // Phase 3 (C18): an Anthropic-native provider pointed at the same capture
  // server; the Anthropic SDK posts to {baseURL}/messages.
  if (caseDef.anthropicProvider) {
    providers["capture-anthropic"] = {
      name: "Capture Anthropic",
      env: ["CAPTURE_API_KEY"],
      package: "@opencode/ai/providers/anthropic",
      settings: {
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sg-e2e-capture",
      },
      models: { "capture-anthropic-1": { name: "Capture Anthropic 1" } },
    };
  }
  // Phase 3 (C19): an OpenAI Responses-native provider pointed at the same
  // capture server. Explicit transport config has higher precedence than
  // plugin provider transforms; test that refusal separately from HTTP.
  if (caseDef.responsesProvider) {
    providers[caseDef.responsesProviderID ?? "capture-responses"] = {
      name: "Capture Responses",
      env: ["CAPTURE_API_KEY"],
      package: "@opencode/ai/providers/openai",
      settings: {
        ...(caseDef.responsesTransport ? { transport: caseDef.responsesTransport } : {}),
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKey: "sg-e2e-capture",
      },
      models: { "capture-responses-1": { name: "Capture Responses 1" } },
    };
  }
  return {
    $schema: "https://opencode.ai/config.json",
    providers,
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
  if (caseDef.agentsFile) {
    // C14: instruction file loaded by the host as model context
    writeFileSync(
      path.join(workdir, "AGENTS.md"),
      `# Workspace policy (synthetic test data)\n\n- Escalate rotation requests to alice.canary@example-test.invalid\n- Rotation key until Friday: sk-CANARYTEST1234567890abcdef\n`,
    );
  }
  let restoreFixturePath;
  let restoreExpectedPath;
  if (caseDef.restoreSource) {
    const source = CANARIES.find((canary) => canary.key === caseDef.restoreSource);
    if (!source) throw new Error(`unknown restoration source ${caseDef.restoreSource}`);
    // The fixture lives inside the case workdir and the armed tool path is
    // workdir-relative; the spawn env pins PWD to the workdir (see env setup)
    // so relative tool paths resolve there deterministically.
    restoreFixturePath = path.join(workdir, "c13-fixtures", source.value);
    mkdirSync(path.dirname(restoreFixturePath), { recursive: true });
    writeFileSync(restoreFixturePath, "C13 path restoration fixture\n");
    restoreExpectedPath = `c13-fixtures/${source.value}`;
  }
  if (caseDef.control) {
    const control = restoreFixturePath
      ? {
          ...caseDef.control,
          restorePathPrefix: "c13-fixtures/",
        }
      : caseDef.control;
    await postControl(port, control);
  }

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
  // Anchor relative tool paths at the workdir: the host's read tool resolves
  // relative paths against the inherited PWD (not the spawn cwd), so without
  // this the resolution base is whatever directory launched the harness.
  // Deterministic regardless of how the harness itself was started.
  env.PWD = workdir;
  env.XDG_DATA_HOME = path.join(workdir, "data");
  env.XDG_STATE_HOME = path.join(workdir, "state");
  env.XDG_CACHE_HOME = path.join(workdir, "cache");
  env.XDG_CONFIG_HOME = path.join(workdir, "config");

  const args = [
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    caseDef.anthropicProvider
      ? "capture-anthropic/capture-anthropic-1"
      : caseDef.responsesProvider
        ? `${caseDef.responsesProviderID ?? "capture-responses"}/capture-responses-1`
        : "capture/capture-1",
  ];
  if (process.env.E2E_PRINT_LOGS === "1" || caseDef.printLogs) args.push("--print-logs");
  args.push(caseDef.prompt);

  const startedAt = Date.now();
  const run1 = await runOpencodeOnce(args, workdir, env);
  // Optional second invocation in the SAME workdir with the SAME env (same XDG
  // dirs → same session storage): `--continue` resumes run 1's session. Each
  // `--standalone` call is a NEW server process (new master key), so run 2
  // exercises session-resume replay, not in-process state reuse.
  let run2 = null;
  let run2StartedAt = 0;
  if (caseDef.followUp) {
    await sleep(SETTLE_MS); // let run 1's trailing requests land before run 2
    const followArgs = [...caseDef.followUp.args];
    if (process.env.E2E_PRINT_LOGS === "1" && !followArgs.includes("--print-logs"))
      followArgs.splice(1, 0, "--print-logs");
    run2StartedAt = Date.now();
    run2 = await runOpencodeOnce(followArgs, workdir, env);
  }
  await sleep(SETTLE_MS); // let trailing requests land inside the window
  // Attribution window covers BOTH runs when a followUp is set.
  const windowEnd = Date.now();
  const exitCode = run2 ? run2.exitCode : run1.exitCode;
  const timedOut = run1.timedOut || (run2?.timedOut ?? false);
  const stdout = run2 ? `${run1.stdout}\n${run2.stdout}` : run1.stdout;
  const restoreSource = CANARIES.find((canary) => canary.key === caseDef.restoreSource);
  const restoredExactPathRead =
    restoreExpectedPath !== undefined && readToolOpenedExactPath(stdout, restoreExpectedPath);
  const redactRestoredPath = (text) =>
    restoreSource ? text.replaceAll(restoreSource.value, "[C13-ORIGINAL]") : text;

  mkdirSync(LOGS_DIR, { recursive: true });
  if (run2) {
    for (const [label, run] of [
      ["run1", run1],
      ["run2", run2],
    ]) {
      writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.${label}.stdout.txt`), redactRestoredPath(run.stdout));
      writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.${label}.stderr.txt`), redactRestoredPath(run.stderr));
    }
  } else {
    writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.stdout.txt`), redactRestoredPath(run1.stdout));
    writeFileSync(path.join(LOGS_DIR, `${caseDef.id}.stderr.txt`), redactRestoredPath(run1.stderr));
  }

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
    const literalValues = (caseDef.literalMarkers ?? []).map((marker) => marker.value);
    const placeholderCounts = {};
    let m;
    const placeholderRe = /\[SG-EMAIL-([0-9a-f]{16})\]/g;
    while ((m = placeholderRe.exec(s)) !== null) {
      placeholderCounts[m[1]] = (placeholderCounts[m[1]] ?? 0) + 1;
    }
    return {
      seq: e.seq,
      // With a followUp invocation, tag which run captured this request
      // (split at run 2's spawn timestamp) — needed for rotation analysis.
      ...(run2 ? { run: e.receivedAt >= run2StartedAt ? 2 : 1 } : {}),
      hasTools: Array.isArray(e.body?.tools) && e.body.tools.length > 0,
      file: path.basename(CAPTURED_DIR) + "/" + `${caseDef.id}-${e.seq}.json`,
      canaries: CANARIES.filter((c) => s.includes(c.value)).map((c) => c.key),
      markers: Object.entries(MARKERS)
        .filter(([k, v]) => (k === "transparentToken" ? hasTransparentToken(s, literalValues) : s.includes(v)))
        .map(([k]) => k),
      literalMarkerIds: (caseDef.literalMarkers ?? [])
        .filter((marker) => s.includes(marker.value))
        .map((marker) => marker.id),
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

  const stdoutCanaries = CANARIES.filter((c) => stdout.includes(c.value)).map((c) => c.key);

  // Assistant-facing text (C17): `opencode run` prints JSON events; collect
  // the text of assistant message parts so display restoration can be
  // verified without the user's own prompt echo polluting the signal.
  const assistantParts = [];
  for (const line of stdout.split(/\r?\n/)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const part = event?.part;
    if (event?.type === "message" && part && typeof part.text === "string") {
      assistantParts.push({ role: part.role ?? null, text: part.text });
    } else if (event?.type === "text" && part && typeof part.text === "string") {
      // `opencode run` emits assistant output as type:"text" events
      assistantParts.push({ role: "assistant", text: part.text });
    }
  }
  const assistantText = assistantParts.map((p) => p.text).join("\n");
  if (process.env.E2E_DUMP_STDOUT) {
    mkdirSync(path.join(OUT_DIR, "logs"), { recursive: true });
    writeFileSync(path.join(OUT_DIR, "logs", `${caseDef.id}.stdout.txt`), stdout);
  }

  const followUpCanaries = caseDef.followUp
    ? CANARIES.filter((canary) => caseDef.followUp.args.some((argument) => argument.includes(canary.value))).map((canary) => canary.key)
    : [];
  const result = {
    case: caseDef.id,
    followUpCanaries,
    description: caseDef.description,
    exitCode,
    timedOut,
    // Per-invocation exit records when a followUp run happened (C9-resume).
    ...(run2
      ? {
          runs: [
            { invocation: 1, exitCode: run1.exitCode, timedOut: run1.timedOut },
            { invocation: 2, exitCode: run2.exitCode, timedOut: run2.timedOut },
          ],
        }
      : {}),
    requestCount: requests.length,
    requests,
    canariesInProviderRequests,
    markersInProviderRequests,
    injectedCanaryReachedProvider: canariesInProviderRequests.some((h) => h.canary === "email-carol"),
    sessionStorageHits,
    logHits,
    cacheHits,
    stdoutCanaries,
    assistantParts,
    assistantText,
    refusedHooks: [...new Set((run1.stderr.match(/\[hook=([a-z.]+)\]/g) ?? []).map((value) => value.slice(6, -1)))],
    wsHttpFallbackLogged: run1.stderr.includes("session websocket connect failed; using http"),
    restoredExactPathRead,
    workdir,
  };
  const { verdict, reason } = caseDef.expectation(result);
  result.verdict = verdict;
  result.expectation = reason;
  result.notes = [
    ...(run2
      ? [
          run1.timedOut ? "run 1 timed out and was killed" : null,
          run1.exitCode !== 0 ? `run 1 exited ${run1.exitCode}; see out/logs/${caseDef.id}.run1.stderr.txt` : null,
          run2.timedOut ? "run 2 timed out and was killed" : null,
          run2.exitCode !== 0 ? `run 2 exited ${run2.exitCode}; see out/logs/${caseDef.id}.run2.stderr.txt` : null,
        ]
      : [
          timedOut ? "run timed out and was killed" : null,
          exitCode !== 0 ? `opencode exited ${exitCode}; see out/logs/${caseDef.id}.stderr.txt` : null,
        ]),
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
  process.exit(resultExitCode(results)); // do not hide failed acceptance gates or runner errors
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

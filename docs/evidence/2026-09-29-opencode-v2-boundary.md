# OpenCode v2 boundary verification — evidence report (issue #19)

Date: 2026-09-29 · OpenCode v2.0.19 · sensitive-guard @ git 5d5e449729 ·
Harness: `scripts/e2e/` (capture-server + orchestrator, committed with this report)

## Method

Real `opencode run --standalone` sessions (real binary, real hook pipeline, real
provider-bound HTTP requests) against a local OpenAI-compatible capture server
(127.0.0.1). Every `/v1/chat/completions` body is recorded and scanned for
synthetic canaries (two emails, one `sk-` HIGH key, one injector-plugin email).
Isolation: per-case `XDG_DATA/STATE/CACHE/CONFIG_HOME`, scrubbed
`OPENCODE_*`/`OPENCHAMBER_*` env, case workdirs outside the repo. Both request
kinds per session — title generation (no `tools`) and the main agent request
(with `tools`) — are scanned.

## Results

| Case | Setup | Requests | Canary leaks to provider | Verdict |
|---|---|---|---|---|
| C1-block | plugin `mode:"block"`, canary prompt | 2 | **0** — user message replaced by `[Sensitive Guard blocked message text: 3 sensitive item(s)…]` | PASS |
| C2-redact | plugin `mode:"redact"`, canary prompt | 2 | **0** — `[REDACTED_…]` markers present in both requests | PASS |
| C3-tool-output | `mode:"redact"`, forced `read notes.txt` tool round-trip (file contains all canaries) | 3 | **0** — tool result scrubbed in the follow-up request, scrub marker present | PASS |
| C4a-order1 | plugins `[sensitive-guard(redact), canary-injector]` | 2 | **0** — injector-appended email scrubbed before the model | PASS (observe) |
| C4b-order2 | plugins `[canary-injector, sensitive-guard(redact)]` | 2 | **0** — scrubbed in reverse order too | PASS (observe) |
| C5-invalid-options | plugin `mode:"bogus"` (invalid), canary prompt | **0** | **0** — run errored (fail-closed), no provider request at all | PASS |
| C6-absent | no plugins, canary prompt | 2 | 6 (all three canaries in both requests) | EXPECTED LEAK |

Sanity cross-check: C6 leaking while C1–C5 are clean proves the isolation works
(no global plugins contaminated the runs).

## Boundary dimensions (issue #19 checklist)

1. **Prompt admission, primary/generate, title, tool-output continuation** —
   exercised and clean (C1–C3). The title request carries the same prompt text
   and was scrubbed identically (blocked notice / markers ×2 per case).
2. **Compaction** — NOT exercised: one-shot sessions do not compact. The plugin
   registers the same `protectRequestEvent` on the `compaction` hook
   (src/opencode-v2.ts) and unit tests cover it; real-session compaction remains
   an explicit gap.
3. **Session persistence / logs (separate from model egress)** — with the plugin
   active and its prompt hook first (C1/C2/C3), no canary was found in session
   storage, logs, or cache. However:
   - C4a: the *injector plugin's* appended email was stored **raw in
     `opencode.db`** (session DB) even though the guard scrubbed it from the
     model request — content added by another plugin between admission hooks and
     persistence can land in local storage.
   - C6 (no plugin): all canaries stored raw in `opencode.db`.
   - Conclusion: OpenCode v2 persists prompt/session text in a local plaintext
     SQLite DB; protection at the model boundary does not remove it from local
     storage when it was persisted before scrubbing or without the plugin.
4. **Invalid config / setup failure** — C5: invalid plugin options make the
   plugin register fail-closed hooks; the run errors out and **zero** provider
   requests are made. No plaintext egress.
5. **Plugin absence** — C6: without the plugin, canaries reach the provider.
   Documented deployment boundary: protection exists only where the plugin is
   installed and loaded; do not claim otherwise.
6. **Other plugin interaction / hook ordering** — C4a/C4b: a second plugin that
   appends content to the prompt was scrubbed by sensitive-guard in **both**
   load orders. No reintroduction of canaries observed.

## Go / no-go

**GO for the email de-identification trial (#20).** No model-bound plaintext
leak on any exercised path; fail-closed behavior verified; plugin-ordering
attack did not reintroduce content.

Conditions carried into #20 (per approved decisions, 2026-09-29):

- Local plaintext persistence (OpenCode session DB) is an accepted, documented
  risk; the trial adds **no new persistence** (no mapping files; per-session
  in-memory key only).
- Placeholder stability is **per-session**; placeholders change after restart.
- Trial scope: MEDIUM `PII_EMAIL` rule only, opt-in per rule; default remains
  `block`; HIGH and unverifiable content stay blocked.

## Gaps

- Real-session compaction path unobserved (see §2).
- Attachments/media are blocked by policy (never forwarded) — unit-tested, not
  exercised in this real-session run.
- Title-generation coverage relies on the same hooks as the main request;
  observed clean here, but only in `run`-style sessions.

## Addendum (same day, post-implementation): #20 de-identify trial verification

After implementing the email de-identification trial (opt-in `deidentify: true`
with `mode:"redact"`, MEDIUM `PII_EMAIL` only, per-session HMAC keys derived
per sessionID), the suite gained **C7-deidentify** and **C8-ignore-bypass** and
was re-run in full (9 cases):

- C7-deidentify: **PASS** — prompt containing email A twice, email B once, and a
  mixed HIGH `sk-` key produced **zero** raw canaries in any provider request;
  A received one stable placeholder (`[SG-EMAIL-…` ×4 across the title + main
  requests, twice per request), B a different one (×2). Exactly the trial
  acceptance from the spec.
- C8-ignore-bypass: **PASS** — an in-text `// sg-ignore` directive (previously a
  verified fail-open bypass of the whole scanner at the model boundary, in every
  mode) no longer suppresses scanning on the plugin path; the canary + HIGH key
  on the directive line were scrubbed. CLI/CI/Web keep honoring directives by
  contract (their scan calls use the default).
- C9-resume: **PASS** — a second `opencode run --continue` invocation replaying
  the session history through the resume path produced **zero** raw canaries in
  all three requests across both runs; replayed history carries protected text,
  and placeholder rotation across server restarts was observed and documented
  (each `--standalone` process mints a new master key — expected per-process
  semantics; same-server resume keeps placeholders stable).
- C1–C6: unchanged verdicts, zero unexpected leaks — no regression.
- Lower-level coverage: 307 unit tests green (27 new across de-identify,
  strict-scan, object-key sanitization, per-session isolation, entry options).

Boundary hardening shipped with the trial (verified by module-level probes and
the suite): model-boundary scans no longer honor in-text ignore directives;
object keys in tool-result metadata are scanned; placeholder keys are derived
per sessionID so sessions in one server process are unlinkable; v1 plugin path
rejects the `deidentify` option (fail-closed).

Suite is now 10 cases (C1–C9); all green except C6's intentional leak.

Trial verdict: **safe to ship behind the opt-in flag**; default installs are
unaffected (`block` default, opt-in requires explicit `deidentify: true`).



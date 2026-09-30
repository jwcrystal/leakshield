# Boundary Evidence Harness (issue #19)

Real-session evidence for the sensitive-guard OpenCode plugin: runs `opencode
run --standalone` against a local capture server that pretends to be the model
provider, and records whether synthetic canary values cross the trust boundary
(provider request bodies, session storage, logs).

Everything here is **verification tooling only** — no product code is touched.

## Files

| Path | Purpose |
|---|---|
| `capture-server.mjs` | Node-stdlib OpenAI-compatible mock provider. Records every `/v1/chat/completions` body to `out/captured/`, answers with a minimal completion (plain or SSE stream). `POST /control` lets the orchestrator arm a one-shot `read` tool_call (case C3) and set the reply label. |
| `run-boundary.mjs` | Orchestrator. Boots the capture server, runs each case in a fresh isolated workdir, attributes captures to cases by time window, scans storage/logs, writes `out/evidence.json` + prints a summary table. |
| `fixtures/second-plugin/` | `canary-injector` — a second OpenCode v2 plugin whose `session.prompt` hook appends `SECOND-PLUGIN-MARKER contact carol.injector@example-test.invalid` to the prompt (mutated in place, same duck-typed style as sensitive-guard). Used for the plugin-ordering cases C4a/C4b. |
| `out/` | Generated artifacts: `captured/` request envelopes, `work/<case>/` isolated run dirs, `logs/` per-case stdout/stderr, `evidence.json`. Safe to delete anytime. |

## Run

```bash
npm run build                 # ensure dist/ is current (tsc)
node scripts/e2e/run-boundary.mjs            # all cases
node scripts/e2e/run-boundary.mjs --only=C1-block,C2-redact
```

Requires: Node ≥ 18, OpenCode v2 (`~/.opencode/bin/opencode` or `OPENCODE_BIN`).
No network access needed — the provider package is bundled with OpenCode.

Env knobs: `OPENCODE_BIN`, `E2E_TIMEOUT_MS` (default 240000), `E2E_PRINT_LOGS=1`
(adds `--print-logs` to the opencode invocation).

## Cases

| Case | Config | Expectation |
|---|---|---|
| C1-block | `{mode:"block"}` + canary prompt | no canary in any provider request; `[Sensitive Guard blocked …]` present |
| C2-redact | `{mode:"redact"}` + canary prompt | no canary; `[REDACTED_…]` present |
| C3-tool-output | `{mode:"redact"}` + `notes.txt` with canaries; server forces a `read {path:"notes.txt"}` tool_call on the first main-agent reply | tool output scrubbed in the follow-up request (no canary, scrub marker present) |
| C4a-order1 | plugins `[sensitive-guard(redact), canary-injector]`, prompt "Say hi." | **observe**: does the second plugin's injected canary reach the provider? |
| C4b-order2 | plugins `[canary-injector, sensitive-guard(redact)]`, same | **observe**: same question with reversed order |
| C5-invalid-options | `{mode:"bogus"}` + canary prompt | fail-closed: no canary reaches provider (ideally no request at all) |
| C6-absent | no plugins + canary prompt | **expected leak** — documents the deployment boundary: without the plugin, canaries reach the provider. This is not a product failure. |
| C7-deidentify | `{mode:"redact",deidentify:true}` + prompt with alice×2 / bob×1 / HIGH key (issue #20 trial) | no canary in any provider request; ≥2 distinct `[SG-EMAIL-…]` placeholders with alice's two occurrences mapping to one stable placeholder |
| C8-ignore-bypass | `{mode:"redact"}` + canary prompt carrying `// sg-ignore` on the same line | no canary in any provider request — in-text ignore directives must not bypass the model boundary (regression guard for the fail-open fix) |
| C9-resume | `{mode:"redact",deidentify:true}`; run 2 = second `opencode run --standalone … --continue` in the same workdir (same XDG dirs → same session storage, NEW server process) | no canary in ANY provider request across both runs; ≥1 `[SG-EMAIL-…]` placeholder present (replayed history carries protected text). Run 2's placeholder for the re-mentioned alice address is expected to DIFFER from run 1's — each `--standalone` invocation is a new server process with a new master key, so placeholders from a previous process are not reproduced (stability scope = one live session/server). Rotation is noted in the reason string, not failed on. |

C6 doubles as a harness sanity check: if the canary does *not* leak there,
global (user-level) plugins probably contaminated the run — the orchestrator
isolates `XDG_CONFIG_HOME` to prevent exactly that.

## How attribution works

OpenCode cannot be made to send a custom header, so the capture server stamps
every request with `receivedAt` (ms) and a sequence number (`raw-<ts>-<seq>.json`).
The orchestrator records each case's start/end wall-clock window (process exit +
2.5 s settle for trailing requests) and renames matching envelopes to
`<case>-<seq>.json`, embedding the case name into the envelope.

C9-resume spans two invocations inside one case window: the window runs from
run 1's spawn to run 2's exit + settle (with a 2.5 s settle between runs), and
every attributed request is tagged with the invocation it belongs to
(`run: 1|2`, split at run 2's spawn timestamp).

Note that OpenCode fires **two kinds** of provider requests per `run`: a
title-generation request (no `tools` array in the body) and the main agent
request (with `tools`). Both carry the prompt text, so both are leak channels —
the harness scans all captured requests. The C3 forced tool_call only triggers
on a tools-bearing request so the title request cannot consume it.

## Discovered host facts (OpenCode v2.0.19)

Verified against the v2.0.19 source (`packages/schema/src/config/*.ts`) and live
boot probes:

- Custom provider: `{"providers": {"<id>": {"name", "env": ["CAPTURE_API_KEY"],
  "package": "@opencode/ai/providers/openai-compatible", "settings": {"baseURL",
  "apiKey"}, "models": {"<name>": {"name": …}}}}}` (plural `providers`, `package` +
  `settings` — the v1-era `provider`/`npm`/`options` shape is silently ignored),
  model ref `<id>/<name>`. The openai-compatible provider package is bundled —
  no download.
- **Config must sit at the global path** `$XDG_CONFIG_HOME/opencode/opencode.json`.
  A bare `<cwd>/opencode.json` was never picked up by `opencode run --standalone`
  in probes; the harness relies on the per-case `XDG_CONFIG_HOME` for isolation.
- Plugins: `"plugins": [{"package": "<abs dir>", "options": {…}}]` — v2 accepts
  plugin **directories** (resolves `index.js`) or package names only; `file://`
  URLs to single `.js` files are rejected.
- The built-in `read` tool takes `{"path": "notes.txt"}` (not `filePath`/`relative`).
- Requests stream (`"stream": true`, SSE) by default; a title-generation request
  fires alongside the main agent request.

### Hard-won isolation gotchas (all handled by the orchestrator)

- **Scrub `OPENCODE_*` / `OPENCHAMBER_*` env vars** — a host OpenCode desktop
  session exports `OPENCODE_CONFIG` pointing at a managed config with global
  plugins; inherited, it contaminates every child run.
- **Prepend the opencode bin dir to `PATH`** — `opencode run --standalone`
  re-spawns `opencode serve --stdio` via PATH.
- **Spawn with `stdio: ["ignore", …]`** — a piped-open stdin makes `opencode run`
  wait for EOF and hang forever with zero output.
- **Case workdirs live outside the repo** (`$(TMPDIR)/sensitive-guard-e2e-work`)
  — OpenCode's config discovery walks up from cwd and would otherwise load this
  repo's own `.opencode/` directory (plugins, worktree state).

## Expected output shape

```
opencode v2.0.19 @ 5d5e449…  model=capture/capture-1  cases=9
case                exit  reqs  leaks verdict      finding
----------------------------------------------------------------------------------------------------
C1-block            0     2     0     pass         no canary in any provider request; block notice present
...
evidence: <repo>/scripts/e2e/out/evidence.json
```

Per-case record in `evidence.json`: exit code, per-request canary/marker
findings, canaries found in session storage / logs / cache under the isolated
XDG dirs, and the verdict (`pass` / `fail` / `observe` / `expected-leak` /
`unexpected` / `error`).

## Safety notes

- **Synthetic canaries only** — `*@example-test.invalid` addresses and
  `sk-CANARYTEST…`. Never substitute real secrets; C6 intentionally leaks
  whatever it is given to the local capture server.
- **Full XDG isolation** — every case runs with `XDG_DATA_HOME`,
  `XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `XDG_CONFIG_HOME` pointed inside its
  own `out/work/<case>/` dir. Real OpenCode data, credentials, and global
  plugin config are never read or written.
- The capture server binds `127.0.0.1` only.
- `out/` is generated output; it is not gitignored (no `.gitignore` changes
  were allowed) — delete it or avoid committing it.

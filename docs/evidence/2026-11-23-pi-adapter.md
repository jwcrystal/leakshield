# Production pi adapter: managed launch, tools and sessions

Date: 2026-11-23
Ticket: [#98](https://github.com/jwcrystal/leakshield/issues/98)
Predecessor: PR [#100](https://github.com/jwcrystal/leakshield/pull/100) (research fixtures)

This record covers the step from the verified research flows to a product adapter:

- `leakshield pi` / `leakshield --pi` managed launcher
- loopback provider boundary for Chat Completions, Anthropic Messages and Responses
- pi extension for session identity, tool restoration and display
- user settings, install entry, session reuse, persistence, doctor

## Environment

| Item | Value |
|---|---|
| Node.js | 24.22.3 |
| pi | `@earendil-works/pi-coding-agent@1.6.0` from npm |
| LeakShield | this branch, `npm ci && npm run build` |
| Upstream in runtime test | recording loopback stub, synthetic values only |
| Real provider credentials | none available |

Credential readiness recorded with pi's own check (no values read):

```jsonl
{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}
{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}
{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}
```

A real-service run is therefore **not executed**. The managed route and the
masking path are exercised against a recording stub; provider wire formats are
covered by unit tests.

## Reproduce

```sh
npm ci
npm run build
runtime="$(mktemp -d)"
npm install --prefix "$runtime" --save-exact @earendil-works/pi-coding-agent@1.6.0
node scripts/e2e/run-pi-adapter.mjs "$runtime/node_modules/.bin/pi"
node scripts/e2e/run-pi-adapter.mjs "$runtime/node_modules/.bin/pi" --persist
npx vitest run
npx tsc --noEmit
npm pack --dry-run
```

The harness creates an isolated HOME, pi agent directory and work directory, a
recording stub provider and a scripted tool sequence (read → write → edit →
bash). It then resumes the same session with `--continue` and, with `--persist`,
checks the encrypted mapping store.

## Actual pi 1.6.0 results

Two runs, the second with `--persist`:

| Check | Result |
|---|---|
| `leakshield pi` launches real pi and exits 0 | pass |
| Scripted read/write/edit/bash sequence executed | pass (5 provider requests) |
| Provider never received an original value | pass |
| Every provider request carried placeholders | pass |
| Tool results masked before the next request | pass |
| `write` and `edit` used restored values locally | pass (`out.txt` held the edited original) |
| Session stored in the user's session directory | pass |
| Saved assistant entries and tool-call arguments contain no original | pass |
| `--continue` resumes the session | pass |
| Resumed history stays masked, prior placeholders still present | pass |
| `--persist` writes the encrypted store; resumed run exits 0 | pass |
| Encrypted store contains no original value | pass |

Defect found by this run and fixed: the HTTP server treated Node's normal
`IncomingMessage` `close` event as a client abort, which cancelled the upstream
fetch after the body was read (HTTP 502). The server now aborts only on an early
response close or request abort (`src/pi/proxy.ts`).

## Test coverage added

| File | Covers |
|---|---|
| `tests/pi-proxy.test.ts` | three provider routes, base-path joining, credential separation, session binding, model/route/malformed-body refusal, masking failure, redirect refusal, upstream failure, incremental streaming, display and tool control endpoints, cross-session isolation, health |
| `tests/pi-tool-policy.test.ts` | read/write/edit/shell restoration, unsafe shell positions, metacharacter originals, missing mappings, degraded read, unknown tools |
| `tests/pi-extension.test.ts` | loopback config validation, unmanaged fail-closed behavior, session header, real control round-trips, display transformer, resumed-session seeding |
| `tests/pi-settings.test.ts` | pi settings/models parsing, provider resolution, credential order, unsupported APIs, `$ENV`/`!command`, session directory |
| `tests/pi-launcher.test.ts` | argument ownership, version gate, generated agent directory, credential scrubbing, session reuse, persistence options, cleanup on failure |
| `tests/pi-doctor.test.ts` | version/extension/settings/provider/credential/launch/route checks and exit-code integration |

Full suite: **68 files, 1,829 tests passed**. `tsc --noEmit`, `npm run build`
and `npm pack --dry-run` pass; the tarball contains `dist/pi/*` and the `pi`
manifest.

## Coverage vs gaps

Protected and exercised:

- managed launch, generated config, child credential scrubbing
- provider request masking on all three wire formats (unit) and Chat Completions through a real pi process
- compaction/summarization-shaped requests on the same route (unit)
- read/write/edit/bash/powershell restoration and refusals
- streaming pass-through with placeholders preserved in model-facing history
- assistant display restoration, including resumed sessions
- `--continue` session reuse; encrypted mapping reload with `--persist`
- unknown routes/models, missing auth/session, failed masking, redirects

Not exercised or not supported:

- a real authenticated provider service (no credentials in this environment)
- real manual compaction / branch summarization in a pi process with the production launcher (research PR #100 verified the same Core path with the prototype proxy; this pass covers the request shape by test only)
- interactive TUI rendering (print mode was used)
- OAuth-only accounts, Google/Bedrock/Vertex/Codex wire formats
- direct-provider bypass by a user who runs plain `pi` without the launcher; the extension refuses input/tools, but this is a local guard, not an egress firewall
- MCP, codemode and tool-search built-ins are disabled by the launcher

The #98 release gate remains open for a real provider run and an enforced egress
policy. This change closes the application-level gaps that blocked normal coding
work: tool restoration, formal install/start entry points, user settings,
session reuse and the provider/background request paths.

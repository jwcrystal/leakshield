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
| Real provider run | CommandCode `deepseek/deepseek-v4.1-flash`, one request |

Credential readiness recorded with pi's own check (no values read):

```jsonl
{"status":"not_ready","provider":"anthropic","reason":"credentials_not_configured"}
{"status":"not_ready","provider":"openai","reason":"credentials_not_configured"}
{"status":"not_ready","provider":"openrouter","reason":"credentials_not_configured"}
```

Anthropic, OpenAI and OpenRouter were not run. One real CommandCode request
was executed through a custom `models.json` provider; see
[Real provider run](#real-provider-run-commandcode).

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

## Real provider run (CommandCode)

One real request was executed to close the gap the stub cannot close: a real
upstream accepted the managed route and never saw the synthetic value.

| Item | Value |
|---|---|
| Date | 2026-11-23 |
| Provider | CommandCode, custom `models.json` entry |
| API base | `https://api.commandcode.ai/provider/v1` |
| API | `openai-completions` (`POST /chat/completions`) |
| Model | `deepseek/deepseek-v4.1-flash` |
| Auth | `COMMANDCODE_API_KEY` resolved by the launcher; child env scrubbed |
| Guard config | temporary YAML with `nda_keywords: [PI_REAL_CANARY]` |
| Prompt | “Reply with only its character count: `"PI_REAL_CANARY"`” |

Observed:

```text
pi-real-check: starting
33
pi-real-check: exit=0

[leakshield] refused tool bash: LeakShield blocked this tool call because the
shell command's quoting is not supported.
```

Interpretation:

- `PI_REAL_CANARY` is 14 characters. The model answered **33**, the length of
  the placeholder token it received, so the provider did not receive the
  original value.
- The run exited 0, so provider authentication, the custom-provider path, the
  managed launch and streaming all worked against a real service.
- The model also attempted a `bash` call while working. The tool boundary
  refused it because the placeholder sat in an unsupported shell quoting
  position; the run still completed.
- The key existed only in the one-off command's environment. It was not written
  to `auth.json`, `models.json`, the session, or the mapping store.

Not covered by this run, and not required for the adapter's gate: Anthropic,
OpenAI and OpenRouter real-service runs. The adapter does not implement provider
clients; pi owns those integrations, and the three wire formats are covered by
unit tests. The one live header path not exercised is Anthropic's `x-api-key`
injection (versus Bearer), also covered by unit tests.

OAuth-only accounts are not supported by the managed route; API keys and
provider keys declared in `models.json` are. Automatic compaction and
interactive TUI rendering are pi host behaviors: the adapter masks their
provider requests and supplies display text, but does not test pi's compaction
policy or terminal rendering.

## Test coverage added

| File | Covers |
|---|---|
| `tests/pi-proxy.test.ts` | three provider routes, base-path joining, credential separation, session binding, model/route/malformed-body refusal, masking failure, redirect refusal, upstream failure, incremental streaming, display and tool control endpoints, cross-session isolation, health |
| `tests/pi-tool-policy.test.ts` | read/write/edit/shell restoration, unsafe shell positions, metacharacter originals, missing mappings, degraded read, unknown tools |
| `tests/pi-extension.test.ts` | loopback config validation, unmanaged fail-closed behavior, session header, real control round-trips, display transformer, resumed-session seeding |
| `tests/pi-settings.test.ts` | pi settings/models parsing, provider resolution, credential order, unsupported APIs, `$ENV`/`!command`, session directory |
| `tests/pi-launcher.test.ts` | argument ownership, version gate, generated agent directory, credential scrubbing, session reuse, persistence options, cleanup on failure |
| `tests/pi-doctor.test.ts` | version/extension/settings/provider/credential/launch/route checks and exit-code integration |

Full suite: **68 files, 1,830 tests passed**. `tsc --noEmit`, `npm run build`
and `npm pack --dry-run` pass; the tarball contains `dist/pi/*` and the `pi`
manifest.

## Coverage vs gaps

Protected and exercised:

- managed launch, generated config, child credential scrubbing
- provider request masking on all three wire formats (unit) and Chat Completions through a real pi process
- one real CommandCode provider request with a length oracle: the model saw a 33-character placeholder, not the 14-character original
- custom provider via `models.json` + `--upstream`/`--api` (CommandCode)
- compaction/summarization-shaped requests on the same route (unit)
- read/write/edit/bash/powershell restoration and refusals
- streaming pass-through with placeholders preserved in model-facing history
- assistant display restoration, including resumed sessions
- `--continue` session reuse; encrypted mapping reload with `--persist`
- unknown routes/models, missing auth/session, failed masking, redirects

Not exercised, or outside the adapter's scope:

- Anthropic, OpenAI and OpenRouter real-service runs: pi owns provider clients; the adapter verifies the three wire formats by unit test and one live smoke. Anthropic's `x-api-key` header path is unit-tested only.
- automatic compaction, branch summarization and interactive TUI rendering are pi host behaviors; the adapter masks the shared provider route and supplies display text, but does not test pi's compaction policy or terminal rendering. Research PR #100 covered manual compaction and a PTY render.
- OAuth-only accounts (pi's credential feature, not implemented by this adapter); Google/Bedrock/Vertex/Codex wire formats are not supported
- direct-provider bypass by a user who runs plain `pi` without the launcher; the extension refuses input/tools, but this is a local guard, not an egress firewall
- MCP, codemode and tool-search built-ins are disabled by the launcher

The #98 release gate remains open for an enforced egress policy. OAuth-only
accounts remain unsupported and are documented, not a gate. Provider-by-provider
live coverage is pi's integration surface, not this adapter's. This change closes
the application-level gaps that blocked normal coding work: tool restoration,
formal install/start entry points, user settings, session reuse and the
provider/background request paths.

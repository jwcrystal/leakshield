# Production readiness: host E2E on the 0.5.x candidate

Date: 2026-11-27. macOS (arm64), Node 24.22.3. Branch
`release/production-readiness`, cut from `main` at `0d67011`.

- `3fc1868` adds the [cross-adapter protection matrix](../../tests/adapter-protection-matrix.test.ts),
  the [readiness checklist](adapter-production-readiness.md) and the release-workflow
  step that runs the matrix.
- `b6b7a41` adds [`scripts/e2e/run-pi-lifecycle.mjs`](../../scripts/e2e/run-pi-lifecycle.mjs).

Neither commit touches `src/`. The built `dist/` therefore matches `0d67011`
for every run below.

Host versions: pi 1.6.0 (`@earendil-works/pi-coding-agent`, npm-installed into
a scratch prefix), OpenCode 2.4.1, Claude Code 2.1.330.

Every run used a recording stub on `127.0.0.1`, isolated host config and agent
directories, a synthetic API key and synthetic canaries. No real provider and
no user account were involved. Request bodies were kept in a local scratch
directory, which is not guaranteed to persist. This record reports counts only.

## Automated checks

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `npx vitest run` (74 files, 1984 tests, matrix included) | pass |

The matrix passes on `main` as is. It does not depend on any uncommitted `src/` change.

## Pi 1.6.0: default compaction, branch summary, automatic retry

`run-pi-lifecycle.mjs` drives the pi SDK (`createAgentSession`). It loads the
shipped `dist/adapters/pi/extension.js` through pi's own `DefaultResourceLoader`
(`additionalExtensionPaths`), not through a hand-built guard. If the extension
reports load errors, the case fails.

`settings.json` sets only `defaultProvider` and `defaultModel`, so pi's
defaults apply. The harness read these from `settings-defaults.js` and printed
them:

- compaction: enabled, `reserveTokens` 16384, `keepRecentTokens` 20000
- retry: enabled, `maxRetries` 3, `baseDelayMs` 2000
- branchSummary: `reserveTokens` 16384

The model uses `openai-completions` with `contextWindow` 200000. The canary is
the NDA keyword in an isolated `LEAKSHIELD_CONFIG`, the variable
`extension.ts` reads.

| Case | What happened | Requests (kind: canary / placeholders) | Result |
|---|---|---|---|
| Default auto compaction | The stub reported 190000 prompt tokens on the fourth turn. pi emitted `compaction_start` with reason `threshold`, then `compaction_end` with a non-empty summary (`tokensBefore` 190005). pi's own threshold path triggered compaction. It was not called manually and was not an overflow. | 4 model turns before compaction at 0 canary; the summarizer at 0 / 3; 2 model requests after compaction at 0 / 12 and 0 / 13 | pass |
| Branch summary | `session.navigateTree(firstUserEntry, { summarize: true })` after three canary-bearing turns. A summary entry was created and pi sent its branch-summary prompt to the stub. One more prompt followed. | 3 model turns at 0 canary; the branch summary at 0 / 6; the post-navigation prompt at 0 / 1 | pass |
| Automatic retry | The first model request got HTTP 503 `overloaded`. pi emitted `auto_retry_start` (attempt 1) and `auto_retry_end` (success). The turn ended with `stopReason: stop`. The retry came from pi's agent loop, not from the provider SDK. | 2 model attempts, both at 0 / 3 | pass |

An independent check found the canary in none of the 14 raw request bodies.

TUI navigation was not exercised: branch summary was driven through the SDK
method that the TUI's tree navigation calls. Pi's hook-only mode was not
re-measured. The supported interception mode stays the fetch boundary, so the
checklist's "Pi interception mode" row is **not applicable** to this candidate.

### Other Pi harnesses on the same build and host

| Harness | Result |
|---|---|
| `run-pi-wire.mjs` (openai-completions, anthropic-messages, openai-responses) | pass (5 / 5 each) |
| `run-pi-extension.mjs` (read, write, edit, bash, `--continue`) | pass (14 / 14) |
| `run-pi-compaction-refusal.mjs` (Bedrock switch: manual compaction refused, zero dispatch) | pass (6 / 6) |
| `run-pi-config-refusal.mjs` | pass (3 / 3) |
| `run-pi-codemode.mjs` | pass (8 / 8) |

## OpenCode 2.4.1

`scripts/e2e/run-boundary.mjs` ran at `3fc1868` with
`--only=C6-absent,C10-transparent,C11-transparent-tool,C12-transparent-resume,C13-transparent-restore,C19-ws-http-fallback`.

| Case | Result |
|---|---|
| C6-absent (no plugin: control) | expected leak: 6 canary hits at the provider, which confirms the harness detects leaks |
| C10-transparent | pass: no canary; placeholders in 2 requests |
| C11-transparent-tool | pass: tool result re-masked |
| C12-transparent-resume | pass: `--continue` in a new server process, no canary in either run |
| C13-transparent-restore | pass: the provider never saw the original; the local `read` opened the restored path |
| C19-ws-http-fallback | pass: WebSocket connect failed, protected HTTP fallback |

The harness also found canaries in OpenCode's local session store, for C6 and
C10 only. That store is the host's own record of the user's prompt and stays
outside the provider boundary. It had no log hits and no unattributed captures.

The first attempt failed in every case with zero requests, before reaching
OpenCode. `OPENCODE_BIN` pointed at `/opt/homebrew/bin/opencode`, a link to a
`mise` shim that cannot resolve inside the harness's isolated environment. The
recorded run uses the resolved binary.

## Claude Code 2.1.330

`scripts/e2e/claude-code/run.mjs` ran at `3fc1868`.

| Scenario | Result |
|---|---|
| `mask` | pass: 3 Messages requests, no canary, a placeholder in every request, thinking and `tool_result` history forwarded, output restored |
| `refuse` | pass: no Messages request reached the upstream; Claude Code showed the LeakShield 400 within 1 to 6 attempts (6 refusals logged) |

## Checklist rows

| Candidate SHA | Adapter and host version | Transport and interception mode | Case | Result | Capture or run link |
|---|---|---|---|---|---|
| `b6b7a41` | Pi, pi 1.6.0 | openai-completions, fetch boundary | Compaction (default auto) | pass | `run-pi-lifecycle.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | openai-completions, fetch boundary | Compaction (branch summary) | pass | `run-pi-lifecycle.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | openai-completions, fetch boundary | Retry (503, agent-level) | pass | `run-pi-lifecycle.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | Bedrock switch, fetch boundary | Retry / refusal (zero dispatch) | pass | `run-pi-compaction-refusal.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | three APIs, fetch boundary | Adapter | pass | `run-pi-wire.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | openai-completions, fetch boundary | Session (`--continue`) | pass | `run-pi-extension.mjs` |
| `b6b7a41` | Pi, pi 1.6.0 | any | Session (fresh session must not restore an earlier token) | unverified | none |
| `b6b7a41` | Pi, pi 1.6.0 | any | Pi interception mode | not applicable | mode unchanged; see [host capabilities](../host-capabilities.md) |
| `3fc1868` | OpenCode, 2.4.1 | Chat Completions HTTP, Responses WS→HTTP fallback, transparent | Adapter | pass | `run-boundary.mjs` C10, C11, C13, C19 |
| `3fc1868` | OpenCode, 2.4.1 | transparent | Session (resume in a new process) | pass | `run-boundary.mjs` C12 |
| `3fc1868` | OpenCode, 2.4.1 | transparent | Session (fresh session must not restore an earlier token) | unverified | none |
| `3fc1868` | OpenCode, 2.4.1 | transparent | Compaction | unverified | no harness |
| `3fc1868` | OpenCode, 2.4.1 | transparent | Retry | unverified | no harness |
| `3fc1868` | Claude Code, 2.1.330 | loopback proxy | Adapter (mask, refuse) | pass | `claude-code/run.mjs` |
| `3fc1868` | Claude Code, 2.1.330 | loopback proxy | Session (resume, fresh) | unverified | none |
| `3fc1868` | Claude Code, 2.1.330 | loopback proxy | Compaction | unverified | no probe ([#111](https://github.com/jwcrystal/leakshield/issues/111)) |
| `3fc1868` | Claude Code, 2.1.330 | loopback proxy | Retry | unverified | none |

## Verdict

- **Pi on pi 1.6.0: not yet signed off; one row remains.** Default
  compaction, branch summary, automatic retry, refusal, the adapter case and
  resume all have host evidence and pass. Fresh-session isolation has no host
  evidence, and under the checklist that unverified row still blocks.
  pi 1.6.1 (the current npm `latest`) was not run.
- **OpenCode on 2.4.1: not ready under the checklist.** Masking, tool
  restoration, resume and WebSocket fallback pass. Compaction, retry and
  fresh-session isolation have no host evidence, and the checklist treats an
  unverified supported path as blocking.
- **Claude Code on 2.1.330: not ready under the checklist.** Mask and refuse
  pass. Session, compaction and retry have no host evidence.

Not covered by this record: real providers, Windows and Linux, pi 1.6.1, the
TUI tree navigation, and request headers (only request bodies were scanned).

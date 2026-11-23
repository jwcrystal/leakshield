# Issue #98 provider boundary runtime evidence

> **Superseded for the adapter decision.** This record shows why a hook-only adapter fails open. The gate was closed with a loopback transport boundary instead; see [2026-11-23-pi-adapter.md](2026-11-23-pi-adapter.md). The fixture can be restored from commit `ae33512`.

**Blocked.** Pi 1.6.0 sends the original request after both a synchronous hook exception and a rejected Promise. On both paths the loopback provider returned a streamed response and the CLI exited successfully. The pi adapter implementation stopped at this decision gate.

## Environment and reproduction

The cloud run used Node.js v24.22.3 and a separate Git worktree at LeakShield PR #100 head `88c26efb2fa1f3f4f9a0523ddb43c1a57bd38448`. It used the npm distribution `@earendil-works/pi-coding-agent@1.6.0`, with the npm tarball integrity `sha512-zX1BVEsshx7A2MRuQ6jfr3RJGWw4Wn+vLq5ZfmlvS1RskhRmByaSZVXH/zcwRrWHO7qPgs98pNCbPOEti/t0fQ==`. The upstream source inspection used tag `v1.6.0` at `faac585884ae2c013a6b1400f3e9e77f10b34bac`.

Save the fixture as `pi-provider-boundary.mjs`. Run from the directory containing the fixture.

```sh
runtime="$(mktemp -d)"
npm install --prefix "$runtime" --save-exact @earendil-works/pi-coding-agent@1.6.0
PI_CODING_AGENT_DIR="$runtime/agent" "$runtime/node_modules/.bin/pi" --offline --version
node pi-provider-boundary.mjs "$runtime/node_modules/.bin/pi"
```

The fixture runs the actual CLI with an isolated configuration, a synthetic API key, and a recording OpenAI-compatible endpoint bound to `127.0.0.1`. It reports marker matches against the captured HTTP request body. Exit status 1 signals that a forced-error case sent a request.

## Captured observations

All four cases issued one request to `/v1/chat/completions`, printed the stub's streamed reply, and exited 0. The harness exited 1.

| Case | Hook invoked | Original system prompt | Original user prompt | Replacement count |
| --- | --- | --- | --- | --- |
| Return rewritten payload | Yes | Absent | Absent | 2 |
| Synchronous throw | Yes | Present | Present | 0 |
| Rejected Promise | Yes | Present | Present | 0 |
| Extension disabled | No | Present | Present | 0 |

The pinned runner awaits the handler, emits an extension error if the handler fails, and returns the current payload. The SDK registers this function as the agent's `onPayload` callback. The observed throw and rejection behavior matches that source path. [Runner](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/src/core/extensions/runner.ts#L1379-L1408) · [SDK](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/src/core/sdk.ts#L374-L431)

## Coverage and baseline checks

Runtime coverage is limited to system and user prompts on the OpenAI Chat Completions wire format over loopback HTTP with an SSE response. History, tool results, compaction, retries, background requests, alternate providers, real authenticated endpoints, direct transports, and tool restoration remain unverified. The observed failed request boundary blocks the adapter. Resuming implementation requires a verified cancellation or transport enforcement mechanism that prevents any request from reaching the provider under both error conditions.

The existing LeakShield suite passed all 1,772 tests in 62 files. Typecheck (`npm exec -- tsc --noEmit`), build (`npm run build`), and package dry run (`npm pack --dry-run`) passed. No Core, OpenCode, or Claude Code source changes were made.

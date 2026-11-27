# Adapter production readiness

Use the shared [adapter protection matrix](../../tests/adapter-protection-matrix.test.ts)
on every release candidate. It sends the same two synthetic NDA values and
Anthropic Messages payloads through the OpenCode HTTP hooks, Claude Code
loopback proxy handler, and Pi fetch guard. It checks the complete outbound
request body, local response restoration, mapping stability and isolation,
and refusal before dispatch.

```sh
npx vitest run tests/adapter-protection-matrix.test.ts
```

The automated check exercises adapter boundaries with a recording provider.
It simulates a summary-shaped request and replays a request after HTTP 500.
A production sign-off also requires the following host evidence on the
candidate SHA and the host versions being released.

| Case | Required host evidence |
|---|---|
| Session | Multiple turns, resume and a fresh session. Capture outbound requests and verify the mapping lifetime against the adapter's documented persistence policy. A fresh session must not restore a token minted in the previous one. |
| Adapter | Replay the common synthetic values through each supported transport and interception mode in the release scope. Verify absence of originals, presence of replacement markers, and restoration only within the intended local session. |
| Compaction | On hosts that support it, trigger automatic compaction with the default configuration and capture the summarizer request and the following model request. Run branch summary separately where supported. Require host evidence that the intended background operation occurred. |
| Retry | Make the local provider return a retryable error on the first attempt. Require the host to retry, capture both attempts, and verify both are masked. For a protection failure on a supported path, require zero outbound dispatches for the refused request. |
| Pi interception mode | Compare hook-only probes and the shipped fetch boundary with the same inputs and host version. Record each captured path separately. Require direct evidence for compaction and branch summary before changing the supported interception mode. |

Use a local recording provider and synthetic data. The
[OpenCode harness](../../scripts/e2e/README.md),
[Claude Code harness](../../scripts/e2e/claude-code/run.mjs),
[Pi wire harness](../../scripts/e2e/run-pi-wire.mjs),
[Pi refusal harness](../../scripts/e2e/run-pi-compaction-refusal.mjs),
and [Pi hook probes](../../scripts/e2e/pi-hook-probe/README.md) are starting
points. Their existing scenarios and fixtures may differ from the shared test.

Record one row per evaluated case.

| Candidate SHA | Adapter and host version | Transport and interception mode | Case | Result | Capture or run link |
|---|---|---|---|---|---|
| | | | | | |

Use **pass**, **fail**, **unverified**, or **not applicable**. Record the reason
for **not applicable** against the [host capability matrix](../host-capabilities.md).
A **fail** or **unverified** row for a supported path blocks production sign-off
for that adapter. The release workflow enforces the shared automated test.
The release sign-off records the host evidence.

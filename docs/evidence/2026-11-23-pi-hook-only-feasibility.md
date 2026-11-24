# pi 1.6.0: hook-only feasibility and cancellation proof

Date: 2026-11-23. Related: [#118](https://github.com/jwcrystal/leakshield/issues/118).
Follows the [fetch interception record](2026-11-23-pi-in-process-fetch-interception.md)
and [transport gap audit](2026-11-23-pi-fetch-gap-audit.md).

## Conclusion

pi's content hooks can mask ordinary requests, and explicit cancellation can stop
the tested requests. They are useful building blocks for a hook-only adapter.
They are not a complete replacement for the current fetch guard: default
compaction and branch-summary calls skip the generic content hooks, and a hook
exception alone does not prevent transmission.

Keep the existing fetch boundary as the default. A future hook-only mode needs
explicit failure cancellation, separate protected background-request handling
(or an explicit refusal of those features), and production mapping/restoration
integration. This record does not implement that mode or close #118.

## Setup and evidence

- Real `@earendil-works/pi-coding-agent@1.6.0`, installed separately with
  `--ignore-scripts`; Node 24.22.3 on Linux.
- Real `AgentSession` SDK engine for the matrix, including actual `read`,
  `compact()` and `navigateTree()` operations. The latter exercises the branch
  summarizer without navigating the interactive TUI.
- Recording providers listen only on `127.0.0.1`. The key and canary are
  synthetic. The recorder stores request path and content flags, not credentials
  or private conversation bodies.
- Normal requests cover all three supported wire APIs. The tool/history and
  background workflows use `openai-completions`.
- The current built `createPiGuard` is the wire-control case. The `wire-error`
  case injects a throwing Core to exercise the actual wrapper's error handling;
  `wire-over-limit` uses the actual Core with a small scan limit.
- The standalone CLI checks load the production pi extension for each of the
  three APIs and verify outgoing masking and incoming display restoration.

The packaged harness reproduced **37 SDK scenarios, 146 assertions and 50
SDK-to-recorder requests**, plus three successful production-adapter CLI checks.
The immutable [summary](pi-hook-only/2026-11-23-summary.json) records the runtime
integrity, source revision and script/results digests. The [raw observation
snapshot](pi-hook-only/2026-11-23-results.json) contains the per-case flags and hooks.
The [probe and analyzer](../../scripts/e2e/pi-hook-probe/README.md) generate fresh
raw observations and verify the expected positive and negative outcomes.

## 1. Ordinary requests can be masked with content hooks

| Case, one ordinary request per API | Chat Completions | Anthropic Messages | Responses |
|---|---|---|---|
| Unguarded positive control | original at recorder | original at recorder | original at recorder |
| `before_provider_request` replaces payload | masked | masked | masked |
| Existing fetch guard | masked | masked | masked |
| Formal CLI: masking and display restoration | pass | pass | pass |

A second prototype uses `before_agent_start` for the system prompt and
`context_with_system` for the full request transcript. In the Chat Completions
workflow, both hook prototypes mask ordinary prompts, replayed history and the
real `read` tool's output. The tool-result event is checked for the original
canary before masking, so a failed/empty tool result cannot make this pass.

## 2. Generic content hooks miss default background calls

The workflow completes ordinary turns and a real tool call, then runs manual
compaction and branch summarization. A separate small-context workflow triggers
automatic compaction with `reason: "threshold"` and observes successful
`compaction_end`.

| Background operation | `context` / `context_with_system` / `before_provider_request` | Hook prototype outcome | Existing fetch guard |
|---|---|---|---|
| Manual compaction | not invoked for its model call | original at recorder | masked |
| Automatic compaction | not invoked for its model call | original at recorder | masked |
| Tree/branch summary | not invoked for its model call | original at recorder | masked |

The dedicated `session_before_compact` and `session_before_tree` hooks do fire.
Returning `{ cancel: true }` stops manual/automatic compaction and tree
summarization before a model request reaches the recorder. That demonstrates
enforceable refusal, not a working protected summary implementation. A mode
that simply cancels these features must disclose that loss of functionality.

## 3. Exceptions and explicit abort have different outcomes

These ordinary-request cases run on each of the three APIs:

| Failure/cancellation case | Requests at recorder, per API | Host outcome |
|---|---|---|
| `before_provider_request` rejected Promise | 1, carrying original | extension error recorded; run continues |
| `context_with_system` throws | 1, carrying original | extension error recorded; run continues |
| Payload hook calls `ctx.abort()`, then throws | 0 | aborted |
| Context hook calls `ctx.abort()`, then throws | 0 | aborted |
| Fetch guard catches an injected Core error | 0 | local refusal/error |
| Fetch guard hits actual Core scan-length limit | 0 | local refusal/error |

The hook-only prototypes deliberately reproduce the host's exception behavior;
this is not an exposure in the production fetch-protected adapter. For a future
mode, masking errors must invoke an effective cancellation mechanism. Throwing
and relying on the host to stop is insufficient.

## 4. A later extension can add content after a masking hook

For Chat Completions, a later `before_provider_request` handler appends a fresh
canary after the earlier payload masker. The original reaches the recorder.
With the existing fetch guard in place, that late addition is masked before
transmission. Hook-only coverage therefore also needs an explicit extension
ordering limitation; it cannot promise final-payload inspection.

## Decision gate for #118

The positive evidence is that content masking and explicit cancellation work in
these pinned cases. The remaining implementation work is material:

1. Handle masking failures with cancellation and verify retry/abort races.
2. Provide independent protected compaction and branch-summary paths, or name
   their refusal as a reduced-coverage limitation.
3. Integrate real Core mapping, assistant/stream restoration and tool-argument
   restoration, including session continuation and model switches.
4. Preserve default wire protection; make any reduced mode explicit opt-in with
   a `PARTIAL` doctor reason and its exact gaps.
5. Use a reproducible benign compatibility failure to decide whether the mode is
   warranted; prefer a targeted protocol fix when it resolves the problem.

## Limits and reproduction

This is not a statistical estimate of real-provider availability or false
refusal rates. It does not test real credentials, OAuth, non-fetch transports,
multiple pi versions, Windows, interactive TUI behavior or complete hook-only
restoration. SDK retries are disabled, so the abort results are not a proof for
every retry or cancellation timing.

Follow [the harness README](../../scripts/e2e/pi-hook-probe/README.md) from a clean
build. It installs no runtime dependencies into LeakShield's package manifest,
writes fresh results outside the checkout, and runs both the SDK matrix and
existing production-adapter CLI checks. Older dated records retain their
original observations; this record adds runtime branch-summary and explicit
abort evidence without rewriting their conclusions.

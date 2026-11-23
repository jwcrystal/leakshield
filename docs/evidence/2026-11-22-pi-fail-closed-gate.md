# Issue #98 — pi extension boundary: pre-implementation security gate

Date: 2026-11-22
Status: **RESOLVED by the transport boundary** — the hook-only plan below remains rejected; the shipped adapter uses a loopback provider boundary plus a generated pi config, credential separation and fail-closed extension instead. See the [adapter evidence](2026-11-23-pi-adapter.md) and [conformance note](#resolution-2026-11-23).

Evidence level of the original investigation was static only. Subsequent cloud runtime proof is recorded in [the runtime report](2026-11-22-pi-runtime-provider-boundary.md) and [the two-stage loopback lab](pi-lab/README.md).

## Resolution (2026-11-23)

The gate required a tested non-bypassable provider/transport mechanism, not a hook assertion. The shipped adapter supplies it:

- `leakshield pi` writes a generated agent directory whose only provider is the loopback boundary; ambient extension discovery and project trust are disabled.
- The boundary masks every request on the supported routes before any upstream fetch, and fail-closed refusals are covered by tests.
- The upstream credential stays in the boundary process; the pi child receives only a short-lived loopback token, and every environment name the credential resolution read is scrubbed from the child.
- Hook throw/reject, compaction and disabled-extension scenarios no longer matter for provider egress: the boundary masks independently of the hook result.

Proof: [adapter evidence](2026-11-23-pi-adapter.md), including the real pi 1.6.0 scripted run, the real CommandCode request, and the unit coverage of all three wire formats.

Scope: this matches the OpenCode plugin's guarantee for host model requests. OS-level egress (a different process, or a permitted tool such as `bash`/`curl`) is a deployment-layer non-goal shared with the OpenCode plugin, not a pi-specific gap. Running plain `pi` outside the launcher is refused locally by the extension; removing the extension is the same class as disabling the OpenCode plugin.

## Scope and provenance
- LeakShield issue: https://github.com/jwcrystal/leakshield/issues/98
- Previous spike: https://github.com/jwcrystal/leakshield/issues/87
- Historical research: `docs/evidence/2026-10-15-agent-interception-capabilities.md`.
- pi upstream canonical repository: https://github.com/badlogic/pi-mono
- Pinned documentation snapshot inspected: `1ffca0f2aafb62119313016b9359c53747a4e674`, `packages/coding-agent/docs/extensions.md`. This is a documentation snapshot, **not a verified current runtime version**. https://upd.dev/badlogic/pi-mono/src/commit/1ffca0f2aafb62119313016b9359c53747a4e674/packages/coding-agent/docs/extensions.md
- Upstream reports of error propagation: https://github.com/earendil-works/pi/issues/3556 and https://github.com/earendil-works/pi/issues/4584 . Treat these as reports, not a substitute for inspecting the pinned runner and running a reproduction.

## Static observations
1. `context` precedes each LLM call and can replace a deep copy of messages. `before_agent_start` can modify the system prompt. `before_provider_request` runs after provider-specific serialization and can replace payloads. Later-loaded extensions can still modify them.
2. `tool_call` can mutate inputs or block execution; `tool_result` can replace results. These are not equivalent to a provider transport gate.
3. Upstream issue #4584 explicitly describes `emitBeforeProviderRequest` catching a callback error and continuing with the unmodified payload. Upstream issue #3556 reports error swallowing across extension emitters. Therefore **throw/reject from `before_provider_request` must not be used as proof of fail-closed**.
4. Documentation alone does not demonstrate that *every* outgoing provider request (including retries, compaction, background calls, custom providers, HTTP/WebSocket transports and extension-generated requests) crosses that callback.

## Decision
**Do not implement or ship a pi-native LeakShield adapter on a hook-only security assertion.** The issue's explicit gate requires a tested non-bypassable cancellation or provider/transport-level enforcement mechanism. No such mechanism has been verified here. The alternative is a fail-closed local proxy with a strict allowlist of supported provider wire formats, or a pinned upstream host patch with demonstrable enforcement.

## Required runtime proof (NOT EXECUTED)
Run in a separate local git worktree, isolated pi user config and a local loopback recording provider. Pin `@mariozechner/pi-coding-agent` / the actual pi distribution to its resolved version + source commit; check actual package name before installation. No real keys or personal data should be used.

Suggested test fixtures, to be adapted to the pinned pi package's supported CLI and extension APIs:
- Synthetic canary in user prompt, system/project instructions, prior history and tool result; observe exact serialized request at loopback HTTP endpoint.
- Handler `throw`, async rejected Promise, malformed payload, unknown payload shape, masking engine error and disabled/missing extension; assert **zero outbound requests** and nonzero process/error state.
- Compaction, retry, streaming, multiple provider wire formats, custom provider, external HTTP client and direct-provider bypass; record which requests hit the enforcement gate.
- Tool `bash`, `read`, `edit`, `write`, MCP/custom: safe placeholder restoration only at execution; modified/stale/unknown placeholders, nested strings and shell/code contexts blocked.
- Verify masking in session history and no restoration of model-visible history when assistant output is restored for local display.
- Run `npx tsc --noEmit`, `npm test`, `npm run build`, `npm pack --dry-run` and regression suites for OpenCode/Claude Code.

## Evidence matrix

| Test | Result | Evidence |
| --- | --- | --- |
| Hook registration and order | DOCUMENTED ONLY | pinned pi docs |
| Provider payload rewriting | DOCUMENTED ONLY | pinned pi docs |
| Callback exception prevents transport | **NOT PROVEN / upstream fail-open report** | pi #4584 |
| Async rejection prevents transport | NOT RUN | — |
| Canary reaches local stub provider only masked | NOT RUN | — |
| System/history/tool-output/compaction coverage | NOT RUN | — |
| Provider and streaming variants | NOT RUN | — |
| Tool argument restoration | NOT RUN | — |
| OpenCode and Claude Code regressions | NOT RUN | — |
| Typecheck/test/build/package | NOT RUN | — |

## Original environment limitations
This investigation could inspect connected GitHub repository metadata and public source docs, but this execution environment cannot resolve `github.com` for git clone and has no installed `pi` CLI. A real Git worktree and pi process could therefore **not** be created/run here. The separate GitHub branch for this research report is not a Git worktree. No adapter source has been changed.

## Unblock criteria
1. Pin a current pi release and inspect the exact `emitBeforeProviderRequest` error path and all provider transports.
2. Implement a supported pre-transmission **cancel/deny** gate (or an enforced strict proxy) and produce the forced-error loopback reproduction proving zero transmitted original canaries.
3. Only then implement `src/pi/` against exported Core/HostToolPolicy, preserving existing adapters.
4. Attach E2E logs, redacted request captures, commands, SHA/version, and CI results to this report; request review only after gate is green.

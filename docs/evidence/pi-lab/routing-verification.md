# Actual pi routing and compaction verification

PR #100 remains Draft. Testing the actual pi 1.6.0 process confirmed that proxy failures do not automatically fall back to a direct endpoint in the tested configuration. It also found a functional gap in manual compaction. With the proxy selected, compaction is refused. With a direct endpoint selected, compaction transmits original synthetic private values while the extension is enabled.

## Reproduce

Use the pinned runtime and built Core described in [the lab README](README.md), then run from the repository root.

```sh
node docs/evidence/pi-lab/run-routing.mjs "$runtime/node_modules/.bin/pi"
```

This starts fresh pi processes with isolated settings and synthetic credentials. Both provider configurations point only to recording loopback servers. The harness changes the configured baseUrl between the proxy and the stub. It uses print mode for failure cases and RPC mode for the real manual compact command. Compaction is configured with keepRecentTokens=1 to exercise summarization on a small synthetic conversation. Exit 0 means all observations below matched assertions, including the expected failures.

## Observations

| Actual pi scenario | Upstream observations | pi result |
| --- | --- | --- |
| Proxy, normal masking | 1 request, no original value | Exit 0 |
| Proxy, synchronous hook error | 0 requests, proxy HTTP 400 | Exit 1 |
| Proxy, rejected Promise | 0 requests, proxy HTTP 400 | Exit 1 |
| Proxy, extension disabled | 0 requests, proxy HTTP 400 | Exit 1 |
| Direct baseUrl, synchronous hook error | 1 request containing original value | Exit 0 |
| Direct baseUrl, rejected Promise | 1 request containing original value | Exit 0 |
| Direct baseUrl, extension disabled | 1 request containing original value | Exit 0 |
| Proxy, manual compaction | 2 normal masked requests, compaction refused with HTTP 400 | RPC compact success=false |
| Direct baseUrl, manual compaction | 2 normal masked requests with extension proofs, then 2 unproved summarization requests containing original values | RPC compact success=true |
| Proxy stopped | 0 requests to stub upstream | Exit 1 |

The proxy compaction test asserts that the error is the gate's refusal and the three proxy statuses are 200, 200, 400. The direct compaction test checks that both normal requests are masked and carry the extension's proof, then that both summarization requests contain the synthetic private value and lack that proof. The extension is active throughout that direct compaction run.

## Interpretation

The earlier lab's direct fetch was a test client intentionally skipping the proxy. This new test confirms that an actual pi process can also transmit directly when its baseUrl is configured to point at the stub upstream. It establishes a configuration route outside the proxy's enforcement. It does not show an automatic fallback while the tested proxy configuration is active.

The manual compaction gap reproduces with the extension enabled and normal prompts working. In this prototype, before_provider_request supplies both masking and a payload-bound proof. Compaction requests lack that proof and expose the original canary when sent directly. The strict proxy refuses them, preserving fail-closed behavior at the cost of a failed compaction operation.

Pinned upstream source shows manual compaction using agent.streamFunction. The extension's payload transformer is assigned to the Agent's onPayload option, while the SDK streamFn wrapper builds transport options from the options passed by its caller. The observations are consistent with this summarization path not receiving the normal agent-loop payload transformation. [Agent setup](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/src/core/sdk.ts#L340-L431) · [Compaction entry](https://github.com/earendil-works/pi/blob/faac585884ae2c013a6b1400f3e9e77f10b34bac/packages/coding-agent/src/core/agent-session.ts#L2893-L2920)

## Ready assessment

The original #98 criteria require compaction coverage and an enforceable provider boundary. This run fails the compaction criterion and demonstrates a direct configuration route. The production adapter decision gate remains blocked.

A supported transport-level integration must protect summarization and enforce the chosen provider route. It then needs the same real pi tests to demonstrate successful masked compaction and refusal under hook failures. Persistent sessions, interactive rendering, other provider formats and remaining tools retain their previously documented verification gaps.

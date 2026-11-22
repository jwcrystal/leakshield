# Managed provider configuration, startup checks and proxy routing

These integration checks run in the cloud with actual pi 1.6.0 and two independent authenticated loopback stubs. They cover provider selection, startup validation, proxy routing and credential separation without requiring real provider credentials.

The managed research launcher generates one isolated pi configuration containing only the selected provider alias and a proxy URL. It checks the pinned CLI version and authenticated Core masking before starting the pi session. The proxy alone receives the selected upstream credential. The pi child receives a separate proxy credential and a restricted environment.

## Reproduce

Use the pinned runtime and repository build from [the lab README](README.md). Run from the repository root.

```sh
node docs/evidence/pi-lab/run-managed.mjs "$runtime/node_modules/.bin/pi"
```

The harness starts separate alpha and beta OpenAI-compatible HTTP/SSE stubs, each requiring its own synthetic bearer credential. It exercises actual pi through both RPC and the managed-launch.mjs CLI, checks the captured requests, and cleans up the child process, proxy and temporary configuration.

The launcher CLI accepts only pi, config, provider and message options. The input JSON contains a providers object. Each entry requires api=openai-completions, model=stub-model, a loopback HTTP /v1 baseUrl, and a printable bearer apiKey. Other entry fields and unsupported protocols/models are refused. The restrictions describe this lab's supported scope.

## Startup and routing behavior

1. Validate all provider entries and select a declared alias.
2. Verify pi --version is exactly 1.6.0 with offline startup enabled and an isolated configuration directory.
3. Create a session-bound proxy with a fixed upstream destination.
4. Authenticate to the proxy and verify that Core masks the startup canary. This check sends no request to the provider.
5. Write a mode-0600 models.json with only the selected provider, proxy URL and proxy credential. Write isolated settings and start with ambient extension/theme discovery disabled and the trusted extension explicitly selected.
6. Start pi with the selected model and session. Proxy loss, missing session identity or rejected masking causes failure on the supported route.
7. Close the proxy and remove the temporary configuration after child exit. The CLI relays termination signals to its child.

The child environment excludes synthetic ambient OpenAI and Anthropic credentials introduced by the test. The generated models file excludes both upstream credentials and upstream URLs. The recording stubs verify that the proxy supplies the correct upstream bearer credential. Captured model payloads contain no original canary or proxy credential.

## Observations

| Scenario | Result |
| --- | --- |
| Select alpha | Only alpha receives one masked, correctly authenticated request |
| Select beta | Only beta receives one masked, correctly authenticated request |
| Runtime switch to the unconfigured alias or native OpenAI model | pi rejects the model selection, available-model snapshot contains only the selected alias |
| Project extension and project package declaration | Sentinel extension is never evaluated |
| Stop either proxy while pi is running | Zero additional upstream requests, no direct fallback observed |
| Health check with wrong credential/session ID | Refused without a provider request |
| Health check after proxy stops | Fails |
| Wrong pi version | Refused before provider dispatch |
| Unknown provider, unsupported protocol/model, remote endpoint, URL query override, unknown setting | Refused with zero provider requests |
| Library extra-argument override or CLI base-url flag | Refused |
| Malformed configuration JSON | CLI exits 1 without a provider request |
| Managed CLI with valid configuration | CLI exits 0, upstream receives masked content |
| Upstream rejects its credential | CLI exits 1, attempted payload is masked, no provider fallback |
| Upstream unavailable | CLI exits 1, no alternate provider receives a request |
| Child shutdown | Proxy closes and temporary configuration is removed |

The harness prints nine grouped result summaries and exits 0 when all assertions match. It also asserts that the generated configuration and child environment omit the upstream credential.

## Coverage boundary

This closes the local integration-test gap for the supported managed loopback route. Provider configuration and startup/routing tests are feasible in the cloud using recording stubs.

The launcher is a research file under docs/evidence. It supports a single fresh session and the lab's fixed OpenAI-compatible model. The separately tested persistence options remain available in the lifecycle harness. Production packaging, user configuration loading, durable key custody, persistent-session launching, other wire protocols and real authenticated model services remain outside this demonstration.

The controlled launcher rejects endpoint/argument overrides and excludes unconfigured aliases and ambient credentials from its pi child. Independent processes and arbitrary code retain their own network access. The existing direct-configuration fixture continues to demonstrate the behavior outside the managed route. No operating-system-wide network policy was installed.

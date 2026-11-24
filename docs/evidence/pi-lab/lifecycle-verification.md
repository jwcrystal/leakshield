# Installation, session lifecycle and interactive display verification

> The fixture scripts were removed from the tree after the gate closed. To reproduce, restore them from commit `ae33512`: `git checkout ae33512 -- 'docs/evidence/pi-lab/*.mjs' docs/evidence/pi-provider-boundary.mjs`.

Actual pi 1.6.0 tests now cover local extension installation, saved sessions, pi and proxy restarts, session switching, manual compaction under session binding, and real interactive terminal rendering. The local prototype passes these tests. Formal npm pi integration and real authenticated provider verification remain incomplete.

## Reproduction

Use the pinned runtime from [the lab README](README.md). Build the repository first, then run from its root.

```sh
npm run build
node docs/evidence/pi-lab/run-lifecycle.mjs "$runtime/node_modules/.bin/pi"
node docs/evidence/pi-lab/run-wire.mjs "$runtime/node_modules/.bin/pi"
```

The lifecycle harness uses Python 3 and its standard-library PTY support for the interactive test. It creates isolated pi configuration and session directories, runs pi install against the local extension path, and launches subsequent pi processes through package discovery. It does not pass an explicit extension argument to those processes.

The harness also packs the actual LeakShield build, installs that tarball into a fresh directory, and imports leakshield/core through the installed package export. This requires npm registry access for the package's ordinary dependencies.

## Prototype changes

The lab proxy accepts optional Core persistence settings, a stable Core session ID and a bound pi session ID. Persistence uses the existing encrypted Core store. The test injects a random in-memory key and deliberately supplies the same key after a proxy restart. This exercises store recovery without configuring an OS keychain or writing a production keyfile.

When session binding is enabled, the proxy requires the pi session ID on both provider and control calls. The extension supplies it at before_provider_headers, which also runs on the tested compaction path. A different session, a disabled extension or a failed header hook cannot transmit on this bound route. The prototype supports one bound session per proxy. Switching back to that session restores access.

The extension uses pi.registerMarkdownTransformer for assistant and thinking surfaces. A bounded local cache of display substitutions is populated through the proxy's existing display operation. Rendering substitutes known placeholders without changing stored messages or the provider stream. The cache resets and reloads from saved entries on session_start. Unknown placeholders stay literal. Print-mode diagnostic output remains available.

The original wire harness uses the default unbound fixture, retaining its previous behavior where a disabled extension can fall back to proxy-only masking. The new lifecycle harness enables the stricter session-bound mode and checks its refusal behavior separately.

## Observed results

| Actual workflow | Result |
| --- | --- |
| pi install local extension file | Configuration registered, subsequent processes load it through discovery |
| Session save | Assistant entries contain placeholders and contain no original canary |
| Restart pi, retain proxy | Previously issued token restores the real local read filename |
| Restart both proxy and pi with same encrypted store/key/session | Previously issued token still restores, provider requests stay masked |
| Encrypted store inspection | Original canary absent from database bytes |
| Create another pi session | Its provider request is refused, zero upstream requests |
| Switch back to original session | Model requests work again and remain masked |
| Manual compaction with bound session | Two summarization requests succeed and stay masked |
| Bound session, extension disabled | Zero upstream requests |
| Session header hook throws or rejects | Zero upstream requests in both cases |
| Real interactive pi in a PTY | Assistant Markdown renders the original value, provider payload stays masked |
| Restart proxy without mappings | Old token cannot restore a tool argument, real read is refused |
| Bash, write and edit tool calls | Each is refused before execution, sentinel file absent and source file unchanged |
| Install actual npm tarball into clean directory | leakshield/core import succeeds, package has no pi adapter export |

The PTY driver starts actual interactive pi with a 120-column terminal. The recording stub emits a unique assistant reply label followed by a placeholder. The test asserts that the terminal transcript contains that label followed by the original canary, and excludes the print-mode diagnostic marker. It then terminates the interactive process. This verifies rendering behavior through the terminal transcript. Visual layout and platform-specific terminal behavior are outside this test.

The mapping-loss test preserves the saved pi conversation while starting a proxy without its old encrypted store. Model requests may continue with safe literal placeholders. The test makes the model request a read using an old token and verifies that restoration is refused and file content is never returned. It does not require blocking a model request that contains only safe placeholders.

## Validation and remaining conditions

The original wire suite is rerun to preserve masking, fail-closed proxy errors, negative payload tests, manual compaction and incremental SSE behavior. Full repository tests, TypeScript, build and package checks accompany this change.

Real provider credentials are not configured in the cloud test environment. Provider credential environment names were inspected without reading or exposing values, and no pi auth file was present at the checked default locations. Tests use synthetic credentials and loopback services only.

The product package still has no published pi adapter entrypoint, setup command or managed proxy launcher. Production key custody, multiple simultaneous pi sessions, additional provider protocols, automatic compaction, custom/MCP tools and restoration for write/edit/shell tools remain outside the demonstrated scope. Those tools currently refuse execution through this extension.

Direct provider configuration still bypasses the proxy, as demonstrated by the existing routing and wire harnesses. This evidence advances local prototype validation while #98's production release gate remains blocked.

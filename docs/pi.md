# pi adapter

LeakShield protects the [pi coding agent](https://github.com/earendil-works/pi) with an in-process extension. The extension wraps `globalThis.fetch` before any provider client is built, so every model request on the three supported wire APIs is masked by the shared core, and placeholders are restored only where they are safe: assistant display text and local tool arguments.

Verified against pi **1.6.0**. The doctor accepts `>= 1.6.0 < 2.0.0`; only 1.6.0 has runtime evidence.

## How it works

pi builds its provider clients per request and resolves `fetch` at that point (`options.fetch ?? globalThis.fetch`), including compaction and branch summaries. Wrapping the global fetch therefore covers the same traffic the [OpenCode plugin](README.md#opencode-plugin-recommended) covers through its wire hook, with no proxy and no launcher.

| Layer | Responsibility |
|---|---|
| `src/adapters/pi/guard.ts` | Wraps `globalThis.fetch`: masks provider requests, restores assistant text in the reply, passes unrelated fetch traffic through, refuses unknown routes and transports it cannot see |
| `src/adapters/pi/extension.ts` | Binds the pi session and model, blocks input and tools when the model cannot be protected, restores tool arguments at `tool_call` |
| `src/adapters/pi/tool-policy.ts` | pi's `HostToolPolicy`: read/write/edit/bash/powershell fields, unknown and MCP tools refused, codemode scripts restored at their inner calls |

pi's own provider traffic is guarded wherever LeakShield sits in the load order: the SDKs resolve `fetch` per request. What position changes is other extensions: one loaded earlier that keeps the raw fetch (or a client built from it) reaches the provider unmasked. First position is therefore recommended, not required for pi itself, and the doctor reports when LeakShield is not first.

## Install

LeakShield is also a pi package: its manifest points pi at the compiled extension, while the default package entry remains the OpenCode plugin. After the next release, install it with:

```bash
pi install npm:leakshield
```

The currently published npm 0.3.1 does not include pi support. Until a newer version is published, build a checkout and register the package directory:

```bash
npm ci
npm run build
pi install "$PWD"
```

pi records this in `settings.packages` and discovers the extension from `package.json`; do not also add the same extension to `settings.extensions`. `pi remove <same-source>` removes the registration. `pi install` does not add the `leakshield` command to your shell PATH. To check a source build, run `node dist/cli.js --doctor pi`; for a pi-managed npm install, run `node ~/.pi/agent/npm/node_modules/leakshield/dist/cli.js --doctor pi` (adjust for `PI_CODING_AGENT_DIR`).

Doctor recognizes user npm and local-directory registrations when the installed manifest declares the extension and its file exists. It reports `PARTIAL` because package/CLI/project load order is not verified. Empty extension filters are reported as disabled; other resource filters, git sources and project-only registrations are not verified. This is a configuration check, not proof that pi loaded the package; after installation, try a synthetic canary. pi may warn and continue without a package that failed to install or load.

### Explicit extension path

Add the extension to pi's `settings.json` (`~/.pi/agent/settings.json`). First position is recommended so that an extension loaded earlier cannot hold the raw fetch:

```json
{
  "extensions": ["/absolute/path/to/node_modules/leakshield/dist/adapters/pi/extension.js"]
}
```

Or start pi with the flag, which always loads before `settings.extensions`:

```bash
pi -e /absolute/path/to/node_modules/leakshield/dist/adapters/pi/extension.js
```

The flag is the only setup that structurally guarantees first position, but `--doctor pi` cannot see CLI flags: it reports a `-e`-only install as NOT VERIFIED. Register the path in settings when you want the check to be meaningful.

From a checkout:

```bash
npm ci
npm run build
pi -e "$PWD/dist/adapters/pi/extension.js"
```

Then check the setup:

```bash
leakshield --doctor pi
```

`LEAKSHIELD_CONFIG` selects the guard config file, the same way `--config` does for the Claude Code proxy. Without it, the usual discovery applies (`config/guard.config.yaml` in the working directory, then `~/.leakshield/guard.config.yaml`).

The extension needs Node.js 22.19 or later (pi 1.6's minimum) and a built LeakShield package. It is not served from the standalone Bun binaries; use the npm package or a checkout.

## Provider support

The guard speaks the three pi wire APIs it has shared Core support for:

| pi `api` | Endpoint | Verified |
|---|---|---|
| `openai-completions` | `POST …/chat/completions` | unit + real pi process (stub) |
| `anthropic-messages` | `POST …/messages` | unit + real pi process (stub) |
| `openai-responses` | `POST …/responses` | unit + real pi process (stub) |

Any provider declared in pi's `models.json` or built into pi works as long as its API is one of these. Example custom provider:

```json
{
  "providers": {
    "commandcode": {
      "baseUrl": "https://api.commandcode.ai/provider/v1",
      "api": "openai-completions",
      "apiKey": "$COMMANDCODE_API_KEY",
      "models": [{ "id": "deepseek/deepseek-v4.1-flash", "contextWindow": 1000000, "maxTokens": 8192 }]
    }
  }
}
```

Other APIs (`openai-codex-responses`, `bedrock-converse-stream`, `google-generative-ai`, Azure responses, …) do not send provider traffic through fetch. The extension cannot guard them, so it refuses the run when the selected model uses one. OAuth-only accounts are out of scope.

### Credentials

pi keeps its own credential and configuration. The extension runs inside the pi process, so unlike the Claude Code proxy it cannot separate the upstream credential from the agent process: a tool that can read the environment or `models.json` can read it too. This matches the OpenCode plugin, which also runs in-process; LeakShield's scope is the model boundary, not secret isolation from the host.

## What is protected

- Every provider request on the selected model's origin: system prompt, conversation history, tool results, and summarization requests. Automatic compaction was run against real pi 1.6.0; branch summarization uses the same `completeSummarization` path and is covered by that transport.
- Manual compaction (`/compact`, RPC `compact`) and `/tree` branch summarization are cancelled when the selected model cannot be guarded: they call the model without an `input` or `before_agent_start` event, so the fetch guard alone would not stop a fetch-bypassing transport.
- A model-shaped `POST` is masked wherever it goes, not only to the current model's origin, so a missed or skipped model switch cannot fail open. Other provider-origin routes are classified separately: an unknown `POST` is refused.
- A `POST` to a non-model path on a host other than the provider's — for example an extension calling a Google `:generateContent` URL — passes through. Route classification covers the three supported APIs, and that endpoint is not the selected model; it is outside this adapter's surface, like any non-provider traffic.
- A `POST` to the provider origin on a route the guard cannot classify is refused. So are masking failures, a missing session, an unsupported API, and a core that cannot be built. Read-only `GET`/`HEAD` requests (model catalogs, response lookups) pass through: they carry no conversation, and refusing them would break providers like OpenRouter and Copilot.
- Assistant text in the reply is restored for display. Stored history keeps whatever pi received; the next request is masked again.
- Tool arguments at execution time:
  - `read` (`path`, `offset`, `limit`), `grep`, `find`, `ls`: restored; an unresolved placeholder may stay literal because it can only match nothing.
  - `write` (`path`, `content`), `edit` (`path`, `edits[].oldText/newText`): restored; an incomplete restoration refuses the call.
  - `bash` and `powershell`: restored only in complete argument words where the original is shell-safe; command position, option injection, quoting and metacharacters refuse the call.
  - Shell restoration follows the same literal-argument subset as the OpenCode plugin: a placeholder may be a complete unquoted or whole-word quoted argument, a `curl`/`http` embedded value, or sit before a single trailing `>`/`>>` with a static filename. Pipelines, command chaining, expansions, `<`/`2>` redirection and a tokenized redirect target refuse the call. Token-free commands are unchanged.
  - Unknown, MCP and custom tools: a placeholder refuses the call. Their arguments may be forwarded to a remote service outside this session's mapping.
  - `codemode`: the script source keeps placeholders literal. The QuickJS sandbox has no network, file system or timers, and pi re-fires `tool_call` for every call the script makes, so the rules above apply at that inner call and an unknown tool called from a script is still refused there (ADR-0007). The script sees that refusal as a tool error and keeps running.

## Parity with the OpenCode plugin

The two adapters implement the same protection contract; only the host hook and its reach differ.

Shared contract:

- model requests on the supported wire APIs are masked in-process before they are sent; a masking failure or an unknown request shape is refused, not forwarded;
- assistant text in the reply is restored for display, and tool arguments are restored only at the local execution boundary;
- transports the adapter cannot see are refused when the model is selected;
- the credential stays in the host process; neither adapter isolates it from the host;
- mapping persistence is opt-in, with the same encrypted store and key ladder.

Host-specific, and not a contract difference:

- interception surface: OpenCode's host wire hook versus pi's `globalThis.fetch`. The fetch wrapper additionally sees a tool or extension that calls a model URL, so pi can be stricter; it never sees less of pi's own provider traffic.
- read-only `GET`/`HEAD` requests (model catalogs) pass in pi; OpenCode's hook does not receive them.
- pi refuses the Codex WebSocket transport; OpenCode has a WebSocket frame adapter.
- pi's load order matters for other extensions; OpenCode's host hook does not depend on plugin order.
- an unknown, MCP or custom tool refuses a placeholder in pi and restores it by field in OpenCode, whose tools run inside the host process (ADR-0001, ADR-0006).

## Sessions and persistence

Session files stay where pi keeps them, so `--continue`, `--resume`, `--session` and `/tree` keep working.

Mappings are process-lifetime by default: a resumed session's old placeholders stay literal, `write`/`edit`/shell calls that need one are refused, and read-only tools degrade to a no-match.

The encrypted mapping store is opt-in, like the OpenCode plugin's, because pi has no plugin-options channel:

| Variable | Default | Meaning |
|---|---|---|
| `LEAKSHIELD_PI_PERSIST` | off | `1`/`true`/`yes`/`on` enables the store |
| `LEAKSHIELD_PI_PERSIST_TTL_DAYS` | `7` | session TTL in days; `0` never expires |
| `LEAKSHIELD_PI_PERSIST_PATH` | `~/.local/share/leakshield/SGP.db` | store path |
| `LEAKSHIELD_PI_PERSIST_KEYFILE` | off | allow the keyfile step when no OS keychain is available |
| `LEAKSHIELD_PI_PERSIST_KEYFILE_PATH` | `~/.local/share/leakshield/sgp.key` | keyfile path |

Key custody is the same ladder as the plugin: OS keychain, then the opt-in keyfile, then memory-only with a warning. `leakshield --forget --all` erases the store. An invalid value makes the extension throw while pi loads it: pi exits 1 with `Failed to load extension` before any request, instead of running without the store you asked for.

With the store enabled, a later process can restore placeholders from earlier sessions wherever the guard sees them: a new request that replays old history, and tool calls. A transcript rendered by a previous process is not re-rendered.

## Doctor

`leakshield --doctor` reports a `pi:` section:

- pi binary and a supported version
- the extension file is present
- the guard config loads
- pi `settings.json` / `models.json` are readable
- LeakShield is registered in `settings.extensions`, and whether it is first
- the selected provider/model uses one of the three fetch APIs

`leakshield --doctor pi` checks only this section. It exits 0 with `PROTECTED` when LeakShield is the first entry of `settings.extensions` and no check failed, and with `PARTIAL` when it is registered later (pi's own requests are still guarded; an earlier extension's can bypass). A `-e`-only install cannot be seen and reports `NOT VERIFIED` with exit 1. `--doctor claude-code` and `--doctor opencode` do the same for the other hosts.

## Limitations

The declared coverage, and the residuals that qualify it, are printed by `leakshield --doctor pi` and summarized in the [host capability matrix](host-capabilities.md); the bullets below are the operational consequences.

- A `pi` run without the extension is not protected. Nothing can fail closed in a process that never loaded the guard.
- `pi --no-extensions` disables it, as do `-ne` and a project that overrides settings. The doctor reports the settings state, not a running process.
- pi's own requests are guarded regardless of load position. An extension loaded before LeakShield can keep the raw fetch (or a client built from it) and reach the provider unmasked; one loaded after it sees the guard. Loading LeakShield first removes the earlier case.
- Providers outside the three wire APIs are refused, not guarded.
- A model switch is applied on `model_select`, re-read at each `before_agent_start`, and re-read again on `input`, the last hook before a run starts. `before_agent_start` cannot cancel a run, so a switch that fired none of those events would rely on the per-request fetch guard; an unsupported API is refused as soon as the model is known, and a non-fetch transport that reached a request unnoticed is not cancellable.
- Images and attachments follow LeakShield's `block` policy in this adapter; they are replaced rather than forwarded.
- This is a model-boundary control, not an OS egress firewall. Any local process, including a user shell, can still send data directly; the OpenCode plugin has the same scope, so OS-level egress is a deployment concern rather than a host-adapter gap.
- Interactive TUI rendering was not part of the runtime verification; print mode and the wire scripts cover the transport.

## Verification

- `node scripts/e2e/run-pi-wire.mjs <pi> openai-completions|anthropic-messages|openai-responses` — real pi, recording stub, one request per format, placeholder at the stub, restored display.
- `node scripts/e2e/run-pi-package.mjs <absolute-pi-path>` — after building, packs and installs the npm artifact into an isolated directory, then uses real pi 1.6.0 to install/discover/check/remove that local package on all three APIs. No publishing or live provider credentials; dependencies install from npm. See the [package-install evidence](evidence/2026-11-24-pi-package-install.md).
- `node scripts/e2e/run-pi-extension.mjs <pi>` — real pi, scripted read → write → edit → bash → `--continue`, with the original values reaching only the local tools.
- `node scripts/e2e/run-pi-codemode.mjs <pi>` — real pi with `codemode` enabled, a script carrying a placeholder: the inner `read` gets the restored path, an inner custom tool is refused and never runs, and the provider never sees the original value.
- `node scripts/e2e/run-pi-compaction-refusal.mjs <pi>` — real pi, a conversation on a guarded model, then a switch to a `bedrock-converse-stream` model: manual compaction is cancelled and nothing reaches the provider.
- `node scripts/e2e/run-pi-config-refusal.mjs <pi>` — an invalid `LEAKSHIELD_PI_PERSIST` value: pi exits 1 with `Failed to load extension` and no request.
- Record and transport audit: [2026-11-23-pi-extension.md](evidence/2026-11-23-pi-extension.md) and [2026-11-23-pi-fetch-gap-audit.md](evidence/2026-11-23-pi-fetch-gap-audit.md).

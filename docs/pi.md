# pi adapter

LeakShield protects the [pi coding agent](https://github.com/earendil-works/pi) with an in-process extension. The extension wraps `globalThis.fetch` before any provider client is built, so every model request on the three supported wire APIs is masked by the shared core, and placeholders are restored only where they are safe: assistant display text and local tool arguments.

Verified against pi **1.6.0**. The doctor accepts `>= 1.6.0 < 2.0.0`; only 1.6.0 has runtime evidence.

## How it works

pi builds its provider clients per request and resolves `fetch` at that point (`options.fetch ?? globalThis.fetch`), including compaction and branch summaries. Wrapping the global fetch therefore covers the same traffic the [OpenCode plugin](README.md#opencode-plugin-recommended) covers through its wire hook, with no proxy and no launcher.

| Layer | Responsibility |
|---|---|
| `src/pi/guard.ts` | Wraps `globalThis.fetch`: masks provider requests, restores assistant text in the reply, passes unrelated fetch traffic through, refuses unknown routes and transports it cannot see |
| `src/pi/extension.ts` | Binds the pi session and model, blocks input and tools when the model cannot be protected, restores tool arguments at `tool_call` |
| `src/pi/tool-policy.ts` | pi's `HostToolPolicy`: read/write/edit/bash/powershell fields, unknown and MCP tools refused |

An extension that runs *before* LeakShield can hold the raw fetch. Load order is therefore part of the setup, and the doctor reports it.

## Install

Add the extension as the **first** entry of pi's `settings.json` (`~/.pi/agent/settings.json`):

```json
{
  "extensions": ["/absolute/path/to/node_modules/leakshield/dist/pi/extension.js"]
}
```

Or start pi with the flag, which always loads before `settings.extensions`:

```bash
pi -e /absolute/path/to/node_modules/leakshield/dist/pi/extension.js
```

From a checkout:

```bash
npm ci
npm run build
pi -e "$PWD/dist/pi/extension.js"
```

Then check the setup:

```bash
leakshield --doctor pi
```

`LEAKSHIELD_CONFIG` selects the guard config file, the same way `--config` does for the Claude Code proxy. Without it, the usual discovery applies (`config/guard.config.yaml` in the working directory, then `~/.leakshield/guard.config.yaml`).

The extension needs Node.js 20 or later and a built LeakShield package. It is not served from the standalone Bun binaries; use the npm package or a checkout.

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
- A `POST` to the provider origin on a route the guard cannot classify is refused. So are masking failures, a missing session, an unsupported API, and a core that cannot be built.
- Assistant text in the reply is restored for display. Stored history keeps whatever pi received; the next request is masked again.
- Tool arguments at execution time:
  - `read` (`path`, `offset`, `limit`), `grep`, `find`, `ls`: restored; an unresolved placeholder may stay literal because it can only match nothing.
  - `write` (`path`, `content`), `edit` (`path`, `edits[].oldText/newText`): restored; an incomplete restoration refuses the call.
  - `bash` and `powershell`: restored only in complete argument words where the original is shell-safe; command position, option injection, quoting and metacharacters refuse the call.
  - Shell restoration follows the same literal-argument subset as the OpenCode plugin: a placeholder may be a complete unquoted or whole-word quoted argument, a `curl`/`http` embedded value, or sit before a single trailing `>`/`>>` with a static filename. Pipelines, command chaining, expansions, `<`/`2>` redirection and a tokenized redirect target refuse the call. Token-free commands are unchanged.
  - Unknown, MCP and custom tools: a placeholder refuses the call. Their arguments may be forwarded to a remote service outside this session's mapping.

## Sessions

Session files stay where pi keeps them, so `--continue`, `--resume`, `--session` and `/tree` keep working. Mappings are process-lifetime: a resumed session's old placeholders stay literal, `write`/`edit`/shell calls that need one are refused, and read-only tools degrade to a no-match. Persistent mappings are tracked in #105.

## Doctor

`leakshield --doctor` reports a `pi:` section:

- pi binary and a supported version
- the extension file is present
- the guard config loads
- pi `settings.json` / `models.json` are readable
- LeakShield is registered in `settings.extensions`, and whether it is first
- the selected provider/model uses one of the three fetch APIs

`leakshield --doctor pi` checks only this section. It exits 0 only when the extension is registered and no check failed; a load-order warning keeps exit 0 but says LeakShield is not first. `--doctor claude-code` and `--doctor opencode` do the same for the other hosts.

## Limitations

- A `pi` run without the extension is not protected. Nothing can fail closed in a process that never loaded the guard.
- `pi --no-extensions` disables it, as do `-ne` and a project that overrides settings. The doctor reports the settings state, not a running process.
- An extension loaded before LeakShield can keep the raw fetch; load LeakShield first. An extension loaded after it sees the guard.
- Providers outside the three wire APIs are refused, not guarded.
- A model switch is checked on `model_select`; a switch made through a path that skips that event would be caught by the guard's per-request model check only if the new model uses a supported API.
- Images and attachments follow LeakShield's `block` policy in this adapter; they are replaced rather than forwarded.
- This is a model-boundary control, not an OS egress firewall. Any local process, including a user shell, can still send data directly; the OpenCode plugin has the same scope, so OS-level egress is a deployment concern rather than a host-adapter gap.
- Interactive TUI rendering was not part of the runtime verification; print mode and the wire scripts cover the transport.

## Verification

- `node scripts/e2e/run-pi-wire.mjs <pi> openai-completions|anthropic-messages|openai-responses` — real pi, recording stub, one request per format, placeholder at the stub, restored display.
- `node scripts/e2e/run-pi-extension.mjs <pi>` — real pi, scripted read → write → edit → bash → `--continue`, with the original values reaching only the local tools.
- Record and transport audit: [2026-11-23-pi-extension.md](evidence/2026-11-23-pi-extension.md) and [2026-11-23-pi-fetch-gap-audit.md](evidence/2026-11-23-pi-fetch-gap-audit.md).

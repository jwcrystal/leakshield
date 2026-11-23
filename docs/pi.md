# pi adapter

LeakShield protects the [pi coding agent](https://github.com/earendil-works/pi) by running it against a loopback provider boundary. Placeholders replace sensitive values before any provider request, and local tools receive the original values only at their execution boundary.

Verified against pi **1.6.0**. Supported version range: `>= 1.6.0 < 2.0.0`.

## Why a proxy, not only an extension

pi's extension hooks are useful but not enforceable for egress:

- `before_provider_request` continues with the original payload when a handler throws or rejects.
- Compaction, branch summarization and other background calls use a different provider path that can bypass the payload hook.
- A disabled extension, a `--no-extensions` run or a project package cannot be stopped by a callback.

The adapter therefore uses both layers:

| Layer | Responsibility |
|---|---|
| Loopback provider boundary (`src/pi/proxy.ts`) | Masks every provider request, holds the session mapping, forwards with the upstream credential, refuses unsupported routes/models and failed masking |
| pi extension (`src/pi/extension.ts`) | Supplies the pi session identity, restores placeholders for local tools, restores assistant display text |

`leakshield pi` writes a generated agent directory whose only provider is the boundary, starts pi with ambient extension discovery and project trust disabled, and never gives the child the upstream credential.

## Install

Requires Node.js 20 or later and a built LeakShield package.

```bash
npm install -g leakshield
leakshield --pi-install   # optional: register the extension in ~/.pi/agent/settings.json
```

`--pi-install` writes the extension path into the user's pi settings additively and preserves unrelated fields. The managed launcher loads the extension explicitly, so installation is only needed for the fail-closed guard when someone runs plain `pi`.

From a checkout:

```bash
npm ci
npm run build
node dist/cli.js pi --provider anthropic --continue
```

## Start pi through the boundary

```bash
leakshield pi --continue
leakshield pi --provider anthropic --model anthropic/claude-sonnet
leakshield pi --provider openai --model openai/gpt-6 -p "review this diff"
leakshield --pi --provider openai   # same launcher
```

Launcher options (everything else is passed to pi):

| Option | Meaning |
|---|---|
| `--provider <id>` | pi provider to protect. Defaults to `defaultProvider` in pi's `settings.json`, then the provider part of `--model` |
| `--model <pattern>` | Forwarded to pi; accepts `provider/id` and `:thinking` |
| `--upstream <url>` | Override the provider API base (https, or loopback http) |
| `--api <api>` | `openai-completions`, `openai-responses` or `anthropic-messages` |
| `--config <path>` | `guard.config.yaml` instead of discovery |
| `--control-port <port>` | Boundary port; defaults to an ephemeral loopback port |
| `--persist` | Keep encrypted mappings across restarts (see [Persistence](plugin/persistence.md)) |
| `--persist-ttl-days <n>` / `--persist-path <path>` / `--persist-keyfile` | Persistence controls |

The launcher prints nothing that contains a credential.

## Provider support

The boundary speaks the three pi wire protocols it has shared Core support for:

| pi `api` | Endpoint | Verified |
|---|---|---|
| `openai-completions` | `POST …/chat/completions` | unit + real pi process + real CommandCode provider |
| `anthropic-messages` | `POST …/messages` | unit |
| `openai-responses` | `POST …/responses` | unit |

Built-in providers with known metadata can be selected by id:

`anthropic`, `openai`, `openrouter`, `groq`, `deepseek`, `together`, `cerebras`, `baseten`, `nvidia`, `xai`, `moonshotai`, `moonshotai-cn`, `minimax`, `minimax-cn`, `fireworks`, `zai`.

A provider declared in pi's `models.json` is used as-is (base URL and API), including its declared model list. Anything else needs `--upstream` and `--api`.

Example: Command Code is not in pi's catalog, so it is declared as a custom provider (verified with `deepseek/deepseek-v4.1-flash`):

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

The launcher copies only safe model metadata into the generated config; `baseUrl`, `apiKey` and `headers` from that entry stay out of the pi child.

### Credentials

Resolution order for the upstream credential:

1. `apiKey` of the provider entry in pi's `models.json` (literal or `$ENV`; `!command` is refused)
2. The provider's usual environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
3. `pi auth print-api-key --provider <id>` (API keys saved by `pi auth login`)

OAuth-only accounts are not supported by the managed route. One real CommandCode request was verified (`deepseek/deepseek-v4.1-flash` through a custom `models.json` entry). Anthropic, OpenAI and OpenRouter are pi's own provider integrations; the adapter verifies their three wire formats by unit test rather than by live per-provider runs. The credential value is never passed to the pi child: its provider API key is the short-lived loopback token.

## What is protected

- Every provider request on the configured route: system prompt, conversation history, tool results, and the summarization requests that compaction and branch summaries issue.
- Streaming replies pass through unchanged, so model-facing history keeps placeholders. The assistant display is restored locally through `pi.registerMarkdownTransformer`; stored messages are not rewritten.
- Tool arguments at execution time:
  - `read` (`path`, `offset`, `limit`), `grep`, `find`, `ls`: restored; an unresolved placeholder may stay literal because it can only match nothing.
  - `write` (`path`, `content`), `edit` (`path`, `edits[].oldText/newText`): restored; an incomplete restoration refuses the call.
  - `bash` and `powershell`: restored only in complete argument words where the original is shell-safe; command position, option injection, quoting and metacharacters refuse the call.
  - Unknown, MCP and custom tools: a placeholder refuses the call. Their arguments may be forwarded to a remote service outside this session's mapping.
- Unknown routes, models, malformed bodies, missing session identity, a wrong loopback token, failed masking, and upstream redirects are refused before any upstream request.

## Sessions

Session files stay in the user's normal session directory, so `--continue`, `--resume`, `--session` and `/tree` keep working. The boundary scopes mappings by the pi session id that the extension supplies.

- Without `--persist`, mappings are process-lifetime. A resumed session's old placeholders stay literal; a tool call that needs one is refused (read-only tools degrade to a no-match).
- With `--persist`, mappings are encrypted at rest and reloaded by session id, so a resumed session can restore values issued before the restart.

## Unmanaged pi fails closed

If the LeakShield extension is installed in pi's settings but pi is started without the launcher, the extension refuses input and every tool call with a message that says to use `leakshield pi`. It cannot block a provider request by itself, and it does not pretend to.

## Doctor

`leakshield --doctor` reports a `pi:` section:

- pi binary and supported version
- extension file present
- pi `settings.json` / `models.json` readable
- provider resolvable, and whether a credential is available (never its value)
- warning when plain `pi` would go straight to a real provider endpoint
- whether this shell is inside a managed launch, with a health probe of the boundary

## Limitations

- Plain `pi` without the launcher is not protected; the extension only refuses locally.
- `--no-extensions` is always passed by the launcher, so pi's built-in extensions (MCP, codemode, tool search) and project packages are not loaded. Pass an explicit `--extension` yourself if you accept the egress risk.
- Project trust is disabled (`--no-approve`) for the managed run; project `.pi` resources do not load.
- Providers outside the three wire protocols (`google-generative-ai`, Bedrock, Vertex, Codex responses) are refused.
- Images and attachments follow LeakShield's `block` policy in this adapter; they are replaced rather than forwarded.
- This is a model-boundary control, not an OS egress firewall. Any local process, including a user shell, can still send data directly.
- The standalone release binaries (`leakshield`, built with Bun) cannot serve the pi extension file from inside the binary. Use the npm package (or a checkout) for the pi adapter; `--doctor` reports the missing extension.
- Interactive TUI rendering was not part of this change's runtime verification; the transformer is exercised by unit tests and print mode.

# pi adapter

LeakShield protects the [pi coding agent](https://github.com/earendil-works/pi) by running it against a loopback provider boundary. Placeholders replace sensitive values before any provider request, and local tools receive the original values only at their execution boundary.

Verified against pi **1.6.0**. The launcher accepts `>= 1.6.0 < 2.0.0`; only 1.6.0 is covered by the runtime evidence.

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
node dist/cli.js pi --provider commandcode --continue
```

## Start pi through the boundary

```bash
leakshield pi --provider commandcode --continue
leakshield pi --provider commandcode -p "review this diff"
leakshield --pi --provider commandcode   # same launcher
```

Launcher options (everything else is passed to pi):

| Option | Meaning |
|---|---|
| `--provider <id>` | **Required.** pi provider to protect; must be declared in pi's `models.json` with an `apiKey` |
| `--model <pattern>` | Forwarded to pi; accepts `provider/id` and `:thinking` |
| `--upstream <url>` | Override the provider API base (https, or loopback http) |
| `--api <api>` | `openai-completions`, `openai-responses` or `anthropic-messages` |
| `--config <path>` | `guard.config.yaml` instead of discovery |
| `--control-port <port>` | Boundary port; defaults to an ephemeral loopback port |

The launcher prints nothing that contains a credential.

## Provider support

The boundary speaks the three pi wire protocols it has shared Core support for:

| pi `api` | Endpoint | Verified |
|---|---|---|
| `openai-completions` | `POST …/chat/completions` | unit + real pi process + real CommandCode provider |
| `anthropic-messages` | `POST …/messages` | unit + real pi process (stub) |
| `openai-responses` | `POST …/responses` | unit + real pi process (stub) |

A provider declared in pi's `models.json` is used as-is (base URL and API), including its declared model list. The provider must be declared there with an `apiKey`; `--upstream` and `--api` only override its base URL and API. Built-in provider selection (pi's catalog metadata and env-var credentials) was removed from the adapter and is tracked in #106.

Example: Command Code is declared as a custom provider (verified with `deepseek/deepseek-v4.1-flash`):

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

The upstream credential comes only from the selected provider's `apiKey` in pi's `models.json`: a literal, or `$ENV_NAME` naming an environment variable. A `!command` value is refused and never executed. Environment variables are not read implicitly, and API keys saved by `pi auth login` are not consulted; if `apiKey` is absent or its `$ENV` variable is unset, the launcher refuses to start.

OAuth-only accounts are not supported by the managed route. One real CommandCode request was verified (`deepseek/deepseek-v4.1-flash` through a custom `models.json` entry). Anthropic, OpenAI and OpenRouter work only once declared in `models.json` like any other provider; the adapter verifies their three wire formats by unit test rather than by live per-provider runs. The credential value is never passed to the pi child: its provider API key is the short-lived loopback token.

## What is protected

- Every provider request that reaches the configured route: system prompt, conversation history, tool results, and the summarization requests that compaction and branch summaries send. Automatic compaction and branch summarization were not run against the production launcher; their request shape is unit-tested.
- Streaming replies pass through unchanged, so model-facing history keeps placeholders. The assistant display is restored locally through `pi.registerMarkdownTransformer`; stored messages are not rewritten.
- Tool arguments at execution time:
  - `read` (`path`, `offset`, `limit`), `grep`, `find`, `ls`: restored; an unresolved placeholder may stay literal because it can only match nothing.
  - `write` (`path`, `content`), `edit` (`path`, `edits[].oldText/newText`): restored; an incomplete restoration refuses the call.
  - `bash` and `powershell`: restored only in complete argument words where the original is shell-safe; command position, option injection, quoting and metacharacters refuse the call.
  - Shell restoration follows the same literal-argument subset as the OpenCode plugin: a placeholder may be a complete unquoted or whole-word quoted argument, a `curl`/`http` embedded value, or sit before a single trailing `>`/`>>` with a static filename. Pipelines, command chaining, expansions, `<`/`2>` redirection and a tokenized redirect target refuse the call. Token-free commands are unchanged.
  - Unknown, MCP and custom tools: a placeholder refuses the call. Their arguments may be forwarded to a remote service outside this session's mapping.
- Unknown routes, models, malformed bodies, missing session identity, a wrong loopback token, failed masking, and upstream redirects are refused before any upstream request.

## Sessions

Session files stay in the user's normal session directory, so `--continue`, `--resume`, `--session` and `/tree` keep working. The boundary scopes mappings by the pi session id that the extension supplies.

Mappings are process-lifetime. A resumed session's old placeholders stay literal; `write`, `edit` and shell (`bash`, `powershell`) calls that need one are refused, and read-only tools degrade to a no-match. Persistent mappings are tracked in #105.

## Unmanaged pi fails closed

If the LeakShield extension is installed in pi's settings but pi is started without the launcher, the extension refuses input and every tool call with a message that says to use `leakshield pi`. It cannot block a provider request by itself, and it does not pretend to.

## Doctor

`leakshield --doctor` reports a `pi:` section:

- pi binary and supported version
- extension file present
- pi `settings.json` / `models.json` readable
- provider selected through `PI_PROVIDER` (skipped when unset), and whether its `models.json` `apiKey` is available (never its value)
- warning when plain `pi` would go straight to a real provider endpoint
- whether this shell is inside a managed launch, with a health probe of the boundary

`leakshield --doctor pi` checks only this section and exits 0 only when the shell is a managed launch with no failed check. `--doctor claude-code` and `--doctor opencode` do the same for the other hosts, so CI can check one integration without another host's state changing the result.

## Limitations

- Plain `pi` without the launcher is not protected; the extension only refuses locally.
- `--no-extensions` is always passed by the launcher, so pi's built-in extensions (MCP, codemode, tool search) and project packages are not loaded. The launcher refuses extra `-e`/`--extension` flags for the same reason: an extension can open its own connection and bypass the boundary.
- Project trust is disabled (`--no-approve`) for the managed run; project `.pi` resources do not load.
- Providers outside the three wire protocols (`google-generative-ai`, Bedrock, Vertex, Codex responses) are refused.
- Images and attachments follow LeakShield's `block` policy in this adapter; they are replaced rather than forwarded.
- This is a model-boundary control, not an OS egress firewall. Any local process, including a user shell, can still send data directly; the OpenCode plugin has the same scope, so OS-level egress is a deployment concern rather than a host-adapter gap.
- The standalone release binaries (`leakshield`, built with Bun) cannot serve the pi extension file from inside the binary. Use the npm package (or a checkout) for the pi adapter; `--doctor` reports the missing extension.
- Interactive TUI rendering was not part of this change's runtime verification; the transformer is exercised by unit tests and print mode.

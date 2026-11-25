# Claude Code (local proxy)

LeakShield protects Claude Code through a local proxy. Claude Code sends its model requests to `ANTHROPIC_BASE_URL`; point that at the proxy and every Anthropic Messages request is masked before it leaves your machine, while placeholders in the assistant's text are restored before Claude Code shows them. The proxy forwards Claude Code's own credentials and `anthropic-beta` headers unchanged. Claude Code's documentation says the base URL also applies to a claude.ai subscription login; that has not been verified here, and a subscription session may use other body-bearing routes at the base URL, which the proxy blocks.

Status: experimental. Verified with Claude Code 2.1.321 against a loopback stub upstream and a synthetic key, not yet against the real Anthropic API ([record](evidence/2026-11-21-claude-code-proxy.md)).

## Setup

1. Start the proxy and leave it running:

   ```bash
   leakshield --claude-code-proxy
   ```

   It listens on `127.0.0.1:8787` and forwards to `https://api.anthropic.com`. Options: `--port <n>`, `--upstream <url>` (another Anthropic-compatible gateway; plain `http` only on loopback), `--config <path>` (the same LeakShield config file the CLI uses; the proxy does not start if the file does not exist), `--attachments allow`.

2. Point Claude Code at it, either in the shell that starts Claude Code:

   ```bash
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```

   or in the `env` block of `~/.claude/settings.json` (or a project's `.claude/settings.json`):

   ```json
   { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787" } }
   ```

3. Check it:

   ```bash
   leakshield --doctor
   ```

   The `Claude Code:` section says where `ANTHROPIC_BASE_URL` comes from (settings files win over the shell; project-local over project over user, as observed with Claude Code 2.1.321) and whether the LeakShield proxy answers there. It also warns when Bedrock, Vertex or Foundry is enabled, or when `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` is set, because then Claude Code does not use the base URL from settings. Every OpenCode result keeps its exit code. On a machine without OpenCode, the doctor exits 0 only when Claude Code points at a running LeakShield proxy and no provider or host setting bypasses it; a base URL pointing at a proxy that is not running exits 1. `leakshield --doctor claude-code` runs only this section and exits 0 only behind a healthy proxy.

If the proxy is not running while `ANTHROPIC_BASE_URL` points at it, Claude Code's requests fail instead of going to Anthropic directly, and the doctor exits 1.

Claude Code started by another app (the Claude desktop app, an Agent SDK host, or a Claude Code session launching another) may take its endpoint from that app instead: in such a child process the shell's `ANTHROPIC_BASE_URL` won over the settings files. Check where requests actually go before relying on it there.

## What the proxy does

- `POST /v1/messages`: the whole body (system prompt, history, tool results, tool schemas, thinking text) is masked in one transaction. A value is replaced by the same placeholder for the whole Claude Code session (keyed by Claude Code's `x-claude-code-session-id` header), so history stays consistent across turns.
- Replies, JSON or SSE: placeholders in assistant text are restored, including a placeholder split across stream events.
- `POST /v1/messages/count_tokens`: masked the same way, because it carries the whole conversation.
- Deferred tools: when Claude Code loads a tool through ToolSearch, the result is a `tool_reference` that names the tool and nothing else. It is forwarded unchanged; a tool name that holds a finding blocks the request.
- Thinking history: Claude Code resends earlier `thinking` blocks. Their text is masked like other text; the `signature` and `redacted_thinking` data cross unchanged, because Anthropic verifies them.
- Bodyless `GET`/`HEAD` (Claude Code sends `HEAD /api/hello`): forwarded when neither the URL nor the name or value of a non-credential header carries a finding.
- Every route: a finding in the request path or query blocks the request. An upstream redirect is neither followed nor relayed: it is answered with a 400, so neither the proxy nor Claude Code resends the request to another host.
- Anything else is **blocked, not forwarded**: a body on another route, a Messages body the masker does not recognise, a content block type it cannot mask, a sensitive value in a header or a structural field (model name, tool name, tool id), or a masking error. Claude Code shows `API Error: 400 LeakShield blocked …` with a code naming the check. Claude Code makes up to six attempts on any 400; each one is blocked.
- `GET /__leakshield/health` is answered by the proxy itself; the doctor uses it.

The proxy keeps mappings in memory only. After a restart, assistant text in Claude Code's history (restored originals) is masked again under new placeholders. Thinking text and `tool_use` input are never restored, so placeholders from before the restart stay in the history: they pass through unchanged, the model may see two placeholders for one value, and the old ones can no longer be restored. Nothing leaks, but keep the proxy running for the length of a session.

## What it does not cover

- **Tool execution.** There is no tool gate yet. Placeholders inside `tool_use` input are not restored, so if the model writes a placeholder into a Bash command or a file edit, the tool receives the placeholder, not the original. You see restored assistant text, not restored tool arguments. Restoration at tool execution through Claude Code hooks is a separate issue.
- **Traffic that does not use the base URL.** WebFetch's domain safety check sends the hostname (without the path) straight to `api.anthropic.com`; set `skipWebFetchPreflight: true` in Claude Code settings to turn it off. Telemetry and error reporting, Bedrock/Vertex/Foundry providers, and Claude Code cloud sessions do not go through the proxy either.
- **Server tools.** Claude Code's WebSearch puts `server_tool_use` and `web_search_tool_result` blocks into the history. The masker does not recognise them, so once a session has used WebSearch, its next requests are blocked. Other unrecognised block types are blocked the same way.
- **Images and documents** are blocked unless the proxy runs with `--attachments allow`, which sends them unscanned.
- **Large sessions.** A request body over 4 MiB is blocked.
- **Long-running proxy.** One proxy process tracks at most 4096 Claude Code sessions and never releases them, because Claude Code sends no session-end signal. After that every new session is blocked until the proxy is restarted.
- **Your disk.** Claude Code's transcripts, logs and files keep the originals. The proxy protects the model boundary only.
- **Signed thinking after a new detection.** If an earlier thinking block holds a value LeakShield now detects (for example after you add a rule), masking changes the signed text and Anthropic rejects the request.
- Detection gaps listed in the [README](../README.md#what-this-protects--and-what-it-does-not) apply here too.

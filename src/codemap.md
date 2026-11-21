# src/

## Responsibility
Application layer for the scanner: configuration, rule engine, decision model, pseudonymization, OpenCode plugin hooks, and the CLI / Web transports.

## Design
- Entrypoints: `index.ts` (OpenCode plugin, re-exports `opencode.ts`) and `cli.ts` (CLI / Web / doctor / forget).
- Subdirectories:
  - `config/` — YAML config loading and validation.
  - `rules/` — built-in and dynamic rules, encoding-aware detection, unicode checks, exact `.env` values.
  - `scanner/` — `scanText()` engine, redaction and redaction verification.
  - `decision/` — decision model, ingress gate, pseudonymization and mapping store (encrypted persistence is opt-in), deidentify, schema-string handling.
  - `transports/` — `cli.ts` (non-interactive CLI output and exit codes) and `web.ts` / `web-ui.ts` (Web UI and REST).
  - `i18n/` — `en` and `zh-TW` messages, selected by `LEAKSHIELD_LANG`.
  - `utils/` — file collection, path security, Windows console encoding.
- `core/` — host-independent wire layer: `wire.ts` (Chat/Anthropic/Responses mask and restore), `sse-recovery.ts`, `ws.ts` (Responses WebSocket frames), `tool-restore-policy.ts` (per-field tool restore rules), `session-guard.ts` (`createGuardCore`: session mapping, request masking, reply and tool restoration, persistence). With `decision/`, `scanner/`, `rules/`, `config/` and `types.ts` it must not import any `opencode*` module (`tests/core-boundary.test.ts`).
- Plugin modules: `opencode.ts` (plugin entry; `server` is a fail-closed stub for unsupported v1 hosts), `opencode-v2.ts` (v2), `opencode-transparent*.ts` (OpenCode hook registration over `core/`: transparent pseudonymization over HTTP/SSE, WebSocket, AI SDK), `opencode-hooks.ts`, `opencode-env-tools.ts` / `env-queries.ts` (opt-in read-only env queries), `plugin-options.ts`, `doctor.ts`, `forget.ts`.
- MCP server mode no longer exists.

## Flow
1. A hook or transport hands text to the scanner.
2. `scanText()` truncates to `max_chars`, runs the rules, and returns findings with masked previews.
3. The decision model maps findings to `ALLOW` / `WARN` / `CONFIRM`.
4. In the plugin, block mode refuses; transparent mode replaces values with stable placeholders and restores them in tool inputs and replies.

## Integration
- Depends on `zod`, `js-yaml`, and `chalk`; transparent persistence uses Node's built-in `node:sqlite` (Node 22.13+).
- Consumes `config/guard.config.yaml`.
- Exposes the plugin entry, the `leakshield` CLI, and the local Web UI / REST endpoint.

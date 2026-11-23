# src/

## Responsibility
Application layer for the scanner: configuration, rule engine, decision model, pseudonymization, OpenCode plugin hooks, and the CLI / Web transports.

## Design
- Entrypoints: `index.ts` (OpenCode plugin, re-exports `adapters/opencode/plugin.ts`), `cli.ts` (CLI / Web / doctor / forget / `--claude-code-proxy`), and `adapters/pi/extension.ts` (pi extension, registered in pi `settings.extensions` or loaded with `-e`).
- `adapters/` — one directory per host. Host-specific modules live only here; anything in `core/`, `decision/`, `scanner/`, `rules/` or `config/` must not import from it (`tests/core-boundary.test.ts`).
  - `adapters/opencode/` — `plugin.ts` (plugin entry; `server` is a fail-closed stub for unsupported v1 hosts), `v2.ts`, `transparent*.ts` (transparent pseudonymization over HTTP/SSE, WebSocket and the AI SDK), `hooks.ts`, `tool-policy.ts`, `env-tools.ts` / `env-queries.ts` (opt-in read-only env queries), `doctor.ts` (the `--doctor opencode` checks).
  - `adapters/claude-code/` — proxy adapter: `proxy.ts` (Anthropic Messages masking and restoration), `cli.ts` (`--claude-code-proxy`), `doctor.ts`.
  - `adapters/pi/` — `guard.ts` (in-process fetch boundary: masking, reply restoration, route and API refusal, tool restoration), `extension.ts` (pi hook surface: session/model binding, input and tool refusal), `tool-policy.ts` (pi built-in classification and unknown-tool refusal), `persistence.ts`, `settings.ts` (pi `settings.json`/`models.json` reads and model selection), `doctor.ts`.
- Other subdirectories:
  - `config/` — YAML config loading and validation.
  - `rules/` — built-in and dynamic rules, encoding-aware detection, unicode checks, exact `.env` values.
  - `scanner/` — `scanText()` engine, redaction and redaction verification.
  - `decision/` — decision model, ingress gate, pseudonymization and mapping store (encrypted persistence is opt-in), deidentify, schema-string handling.
  - `transports/` — `cli.ts` (non-interactive CLI output and exit codes) and `web.ts` / `web-ui.ts` (Web UI and REST).
  - `i18n/` — `en` and `zh-TW` messages, selected by `LEAKSHIELD_LANG`.
  - `utils/` — file collection, path security, Windows console encoding.
- `core/` — host-independent wire layer: `wire.ts` (Chat/Anthropic/Responses mask and restore), `sse-recovery.ts`, `ws.ts` (Responses WebSocket frames), `tool-restore-policy.ts` (per-field tool restore rules), `session-guard.ts` (`createGuardCore`: session mapping, request masking, reply and tool restoration, persistence).
- Root modules: `guard-options.ts` (the plugin option schema, shared by the OpenCode entry, the pi persistence parser and the doctors), `doctor-report.ts` (report shape, rendering and exit code shared by the three doctors), `doctor-hosts.ts` (per-host dispatch), `forget.ts`, `help.ts`, `types.ts`.
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

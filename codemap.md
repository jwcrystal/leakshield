# Repository Atlas: leakshield

## Responsibility
Scans for secrets, PII, database credentials, internal domains, and NDA keywords before content reaches an AI model. It blocks or pseudonymizes content inside OpenCode, and also offers a CLI and a local Web UI for explicit scans.

## Design
- Single-package TypeScript application with three entrypoints:
  - `src/index.ts` — OpenCode plugin entry (re-exports `src/opencode.ts`); importing it never starts a process.
  - `src/cli.ts` — CLI / Web UI / `--doctor` / `--forget` / `--claude-code-proxy` / `--pi` entry (the `leakshield` bin and release binaries).
  - `src/pi/extension.ts` — pi extension entry (declared by the package `pi.extensions` manifest and exported as `leakshield/pi`).
- `src/core/` is the host-independent layer (wire masking, session guard); `src/opencode*.ts`, `src/claude-code/` and `src/pi/` are the host adapters on top of it.
- The pi adapter pairs a loopback provider boundary with the extension: pi's hooks fail open, so the generated pi config routes its only provider through `src/pi/proxy.ts`, which owns masking and the session mapping.
- MCP server mode was removed: it relied on the model voluntarily calling a scan tool after it had already received the content.
- Detection is rule-based: built-in rules, dynamic rules from `config/guard.config.yaml`, and opt-in exact `.env` value matching.
- Output is normalized through `ScanResult` / `Finding`, then mapped to a decision (`ALLOW` / `WARN` / `CONFIRM`).

## Flow
1. The plugin hooks (or the CLI/Web transport) receive text.
2. `loadConfig()` resolves configuration from project-local or user-home paths.
3. `scanText()` applies built-in, dynamic and exact-value rules.
4. `toDecisionResult()` produces the decision; redaction / pseudonymization produce the safe text.
5. The plugin substitutes or refuses; the CLI prints results and sets the exit code (0 safe, 1 findings, 2 usage error).

## Integration
### System Entry Points
- `src/index.ts` — OpenCode plugin entry.
- `src/cli.ts` — CLI / Web UI entry.
- `package.json` — npm metadata, scripts, dependency manifest.
- `config/guard.config.yaml` — operator-tunable detection inputs.

### Directory Map
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Plugin, scanner, decision model, pseudonymization, CLI and Web transports. | [View Map](src/codemap.md) |
| `config/` | Operator-defined NDA keywords, private domains, rule overrides, and scanner limits. | [View Map](config/codemap.md) |

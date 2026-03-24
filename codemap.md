# Repository Atlas: sensitive-guard

## Responsibility
Provides a dual-mode sensitive content scanner that blocks or flags secrets, PII, database credentials, internal domains, and NDA keywords before content is sent to AI systems.

## Design
- Single-package TypeScript application with one runtime entrypoint in `src/index.ts`.
- Supports two execution modes:
  - MCP server mode for tool-based integration with AI clients.
  - CLI mode for direct local scanning of text, files, and directories.
- Detection is rule-based:
  - static built-in regex rules for common secret/PII patterns
  - dynamic rules generated from `config/guard.config.yaml`
- Output model is normalized through `ScanResult` and `Finding` structures.

## Flow
1. Process starts in `src/index.ts`.
2. Runtime mode is selected via `--cli`.
3. `loadConfig()` resolves configuration from project-local or user-home paths.
4. Input is scanned through `scanText()` using built-in and config-derived rules.
5. Results are surfaced either:
   - as MCP tool responses over stdio, or
   - as colored terminal output with process exit codes.

## Integration
### System Entry Points
- `src/index.ts` — application entrypoint, scanner engine, MCP registration, CLI runtime.
- `package.json` — npm metadata, scripts, dependency manifest.
- `tsconfig.json` — TypeScript compilation policy.
- `config/guard.config.yaml` — operator-tunable detection inputs.

### Directory Map
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Implements scanner domain model, rule engine, MCP server tools, and CLI command flow. | [View Map](src/codemap.md) |
| `config/` | Stores operator-defined NDA keywords, private domains, and scanner limits. | [View Map](config/codemap.md) |

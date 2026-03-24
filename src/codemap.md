# src/

## Responsibility
Implements the application service layer: configuration loading, detection rule construction, text scanning, MCP tool registration, CLI argument handling, recursive file collection, and terminal reporting.

## Design
- Monolithic entry module in `index.ts` with four main concerns:
  - domain types (`GuardConfig`, `Finding`, `ScanResult`)
  - rule engine (`BUILTIN_RULES`, `buildDynamicRules`, `scanText`)
  - MCP transport adapter (`createMcpServer`)
  - CLI adapter (`runCli`, `printCliResult`, `collectFiles`)
- Uses a rule-based scanning strategy where each `Rule` binds:
  - finding type
  - severity
  - human-readable description
  - regex matcher
- Applies redaction before output so matched secrets are not returned in raw form.
- Uses immutable aggregation patterns for result creation except for controlled local accumulation arrays/sets inside the scanner.

## Flow
1. `loadConfig()` resolves YAML configuration from known paths.
2. `scanText()` truncates input to `max_chars`, merges built-in and dynamic rules, then iterates regex matches.
3. `getLineCol()` computes source coordinates for user-visible findings.
4. `redact()` masks sensitive matched values before preview emission.
5. `createMcpServer()` registers four MCP tools:
   - `scan_text`
   - `scan_file`
   - `scan_dir`
   - `reload_config`
6. `runCli()` parses `--text`, `--file`, `--dir`, `--ext`, and `--stdin`, then prints summarized results and exits with status codes.

## Integration
- Depends on:
  - `@modelcontextprotocol/sdk` for MCP server and stdio transport
  - `zod` for tool input schemas
  - `js-yaml` for config parsing
  - Node `fs`, `path`, `url` for IO/runtime paths
  - `chalk` for CLI rendering
- Consumes:
  - `config/guard.config.yaml` dynamic keyword/domain configuration
- Exposes:
  - CLI executable behavior through `dist/index.js`
  - MCP tools to external AI orchestration environments

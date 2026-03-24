# config/

## Responsibility
Defines operator-maintained scanner inputs that extend the built-in detection engine with project- or organization-specific confidentiality markers.

## Design
- `guard.config.yaml` separates configuration into three concerns:
  - `nda_keywords`: high-severity custom keyword matches
  - `private_domains`: medium-severity internal domain matches
  - `settings`: scanner execution limits and output behavior
- YAML format is human-editable and intended for local customization without code changes.

## Flow
1. `src/index.ts` calls `loadConfig()` during startup.
2. YAML is parsed into `GuardConfig`.
3. `buildDynamicRules()` transforms configured keywords/domains into runtime regex rules.
4. `reload_config` can re-read this directory's main file without restarting the MCP server.

## Integration
- Consumed by: `src/index.ts`
- Affects:
  - scan sensitivity
  - result severity composition
  - maximum scanned input size
  - whether line/column metadata is emitted

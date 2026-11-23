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
1. The CLI, Web UI, and plugin call `loadConfig()` (`src/config/loader.ts`) at startup.
2. YAML is parsed into `GuardConfig`.
3. `buildDynamicRules()` transforms configured keywords/domains into runtime regex rules.
4. The CLI re-reads the file on every run; the OpenCode plugin needs an OpenCode restart to pick up changes.

## Integration
- Loaded by `src/config/loader.ts`; consumed by the CLI (`src/transports/cli.ts`), Web UI (`src/transports/web.ts`), `src/adapters/opencode/doctor.ts`, and the plugin (`src/adapters/opencode/opencode.ts`)
- Affects:
  - scan sensitivity
  - result severity composition
  - maximum scanned input size
  - whether line/column metadata is emitted

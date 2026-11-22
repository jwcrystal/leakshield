# Core packaging migration (incremental)

## Current state

The repo has a host-independent source directory (`src/core/`) but publishes a
single npm package (`leakshield`). This change exposes an **experimental**
`leakshield/core` subpath. It is **not** a new `@leakshield/core` package,
nor does it claim complete host independence for tool-restoration semantics.

```ts
import { createGuardCore } from "leakshield/core";
```

The default `leakshield` entrypoint remains the OpenCode plugin. The CLI and
Claude Code local proxy remain unchanged. Type declarations for all built
modules are now emitted alongside JavaScript to make the core subpath usable
from TypeScript.

## Remaining steps before independent packages

1. Move OpenCode-specific Code Mode `execute` handling and tool-field
   restoration policies out of `src/core/session-guard.ts` behind an explicit
   host policy interface. Require safe defaults for hosts that provide no
   restoration policy; tests must verify fail-closed behavior.
2. Define a stable public core API with integration and compatibility tests for
   OpenCode and Claude Code, including masking, HTTP/SSE/WS restoration,
   session persistence, and refusal behavior.
3. Extract shared `scanner/`, `decision/`, `rules/`, `config/` and types
   with core into an actual workspace package, removing imports outside the
   package root. Add CI tests that build the core package in isolation.
4. Move OpenCode and Claude Code adapters into separate workspace packages
   depending only on the core public API. Add packaged installation smoke tests.
5. Preserve the existing `leakshield` npm package as a compatibility facade
   until a deliberate versioned migration; publish independently only after
   comparing packed output and migration impact.

## Compatibility and security

Do not publish `@leakshield/core` yet. The subpath is experimental and the
single-package deployment stays authoritative. A host-neutral import boundary
alone is insufficient to prove host-neutral tool restoration: existing rules
for `execute` and tool fields still reflect OpenCode. Avoid relaxing them to
accommodate new hosts without adversarial tests.

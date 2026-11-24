# OpenCode plugin

[← README](../README.md) · 🌐 English | [繁體中文](opencode.zh-TW.md)

The OpenCode plugin is LeakShield's most complete host integration: it scans at OpenCode's content hooks and, in transparent mode, validates the final provider body as well. For the other hosts see [pi](pi.md) and [Claude Code](claude-code.md); for what each host covers, see the [host capability matrix](host-capabilities.md).

When loaded successfully, the OpenCode plugin is the enforced integration. It scans and blocks user text before OpenCode persists or sends it to a model, sanitizes system prompts and tool definitions, protects tool output before the next model turn, and re-scans history before replay. It always enables encoded-content detection. Invalid plugin options or scanner configuration make every protected hook fail closed and abort the model request. A bounded SHA-256 decision cache avoids repeatedly scanning unchanged history without retaining original or redacted content.

Transparent mode details: [Encoded content and tool schemas](plugin/transparent-mode.md#encoded-content-and-tool-schemas).

LeakShield supports OpenCode v2 only. v2 hosts load the package `id` + `setup(ctx)` definition. OpenCode v1 is no longer supported: a v1 host that loads the package gets hooks that fail closed and abort every model request, and `leakshield --doctor` reports `BROKEN`. Upgrade to OpenCode v2.

**OpenCode v2** — point `plugins` at the published package, or at the `dist` directory of a local build:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "leakshield" // or "/absolute/path/to/leakshield/dist"
      // No options: mode defaults to "transparent" on v2.
      // Add "options": { "mode": "block" } to refuse instead of pseudonymize.
    }
  ]
}
```

Note that v2 only accepts plugin *directories* (it resolves `dist/index.js`) or package names; a `file://` URL to a single `.js` file is rejected with `configured plugin path must be a directory`.

The default `mode` is **`transparent`** (see [Transparent mode](plugin/transparent-mode.md)). `block` replaces unsafe content with a disclosure-free notice; set `"mode": "block"` to use it. Set `mode` to `redact` only when you explicitly want recognized direct matches replaced with `[REDACTED_TYPE]` placeholders. `--doctor` shows the mode in effect and marks it `(default)` when the options omit it.

## What `PARTIAL` means

`leakshield --doctor` exits 0 for two statuses. They are install-level results, not a guarantee that nothing sensitive reaches a model. Pass `--doctor opencode`, `--doctor claude-code` or `--doctor pi` (also `--doctor=<host>`) to check one host with its own exit code.

| Status | Setup | Meaning |
|--------|-------|---------|
| `PROTECTED` | `block` or `redact`, or transparent with `wireProtection` omitted or `true` (the v2 default), and every declared capability row covered | Install-level checks pass. In transparent mode, the final HTTP body or supported WS frame is validated too |
| `PARTIAL` | Transparent with `wireProtection: false` ([hook-first example](../config/opencode.hook-first.example.json)), or a host whose [declared capability rows](host-capabilities.md) include `unknown` or `outside` | Final outbound HTTP bodies are not inspected, or a declared egress is not covered; the doctor names the row and the issue that closes it |

Doctor prints `Configuration status` and `Wire protection` separately from host-wide `Coverage`. `Wire protection: enabled` describes the validated configuration, not proof of interception in a live session; block mode reports `not-applicable`, and an unknown configuration reports `unknown`. A `PARTIAL` verdict lists configuration and host-coverage reasons separately, including both when both apply. Host coverage is not filtered to your selected provider/model. Each host section also prints its declared credential handling, mapping-persistence policy and complete residual list; `opt-in` describes persistence support, not whether it is enabled in your install.

With `PARTIAL`:

- Later-added content or attachments may leave unmasked, even with `attachments: "block"`.
- **Content-hook masking failures still refuse the affected call**; hook-only does not silently forward unprotectable raw content.

See [Wire protection](plugin/wire-protection.md) for both levels.

**OpenCode v2 only — email de-identification trial:** the opt-in `deidentify` option (valid only together with `mode: "redact"`) additionally replaces repeated MEDIUM email findings with stable, opaque `[SG-EMAIL-…]` placeholders so an agent can correlate records without seeing the addresses. The mapping key is generated once per plugin setup (one OpenCode session), held in memory only, and never persisted — placeholders are stable within a live session but change after a restart, and no reverse mapping exists. Everything else keeps its existing disposition: HIGH credentials are still redacted/blocked, and truncated, encoded, or unverifiable content blocks the whole unit.

```jsonc
{ "package": "/absolute/path/to/leakshield/dist", "options": { "mode": "redact", "deidentify": true } }
```

Attachments: transparent mode supports an `attachments` policy (plural; `attachment` is not recognized). **`"block"` (default)** omits media/file parts at content hooks and replaces them with a notice; the model cannot read those omitted images. Final wire protection also refuses residual wire attachment parts; hook-first does not inspect late-added attachments. **`"allow"`** sends attachments through unscanned and appends a visible notice part — an explicit decision that you vouch for their content (`"allow"` requires `mode: "transparent"`). In block/redact modes attachments are blocked as before. Existing conversations can replay originals, subject to the [restart limitations](plugin/transparent-mode.md#restart-limitation); starting a new conversation is not a substitute for verifying recovery. The plugin protects OpenCode model requests only, not other AI clients or local tools.

OpenCode currently logs and skips modules that fail before their plugin factory can run, such as a missing package or JavaScript syntax error. After installation or upgrade, run a smoke test with a synthetic key matching `sk-` followed by at least 20 letters or digits and verify that LeakShield replaces the message before using real sensitive data.

## Isolated smoke test (OpenCode v2)

Run this from the project root. It uses a temporary working directory and a synthetic value, not a real credential:

```bash
npm run build
SMOKE_DIR="$(mktemp -d)"
PROJECT_DIR="$(pwd)"
cat > "$SMOKE_DIR/opencode.json" <<EOF
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "$PROJECT_DIR/dist", "options": { "mode": "block" } }
  ]
}
EOF
(cd "$SMOKE_DIR" && opencode run --standalone \
  "Smoke test only. Do not reveal or use this token: sk-AAAAAAAAAAAAAAAAAAAA")
rm -rf "$SMOKE_DIR"
```

The model-facing message must contain the LeakShield block notice and must not contain the synthetic token. Do not use a real credential for this test.

To test the published package, use `"leakshield"` instead of the local `dist` path.

## Automated install check: `--doctor`

```bash
npm run scan -- --doctor     # or: leakshield --doctor after global install
```

The doctor verifies the install without sending anything anywhere: it checks the OpenCode host version, reads the `opencode.json` or `opencode.jsonc` files OpenCode applies (`.opencode/`, the project root and one global directory), combines their `plugins` arrays the way the host does, confirms LeakShield is registered with options that the plugin itself would accept, verifies a local `dist` entry point actually exists (a missing one makes OpenCode silently log-and-skip the plugin — sessions look normal but are unprotected), loads the guard config, and runs the synthetic-canary smoke scan locally. Each host section is followed by the capability rows that host declares ([matrix](host-capabilities.md)): an `unknown` or `outside` row keeps that host at `PARTIAL` and names the issue that closes it. Exit code 0 means `PROTECTED` or `PARTIAL` (`wireProtection: false`: final outbound HTTP bodies are not inspected); a v1 host is reported `BROKEN` with a fix that says to upgrade to OpenCode v2; any other status prints the failing check with a concrete fix, including a copy-paste registration snippet when the plugin is missing. A separate `Claude Code:` section checks the [Claude Code proxy](claude-code.md) wiring; the exit code is also 0 when Claude Code is behind a running LeakShield proxy, even without OpenCode.

Doctor is an install-level check that runs outside the host — it cannot see inside a live session. Runtime proof comes from the smoke test above or `scripts/e2e/run-boundary.mjs`.

## Detailed guides

- [Transparent mode](plugin/transparent-mode.md): placeholders, supported protocols, tool argument restoration (per field, `code`/`script` fields, Code Mode, `curl`, `rtk`), restart limitation
- [Wire protection](plugin/wire-protection.md): hook-only and final wire levels, AI SDK providers, refusals, reply-side recovery
- [Native WebSocket](plugin/websocket.md): experimental Responses-family support and its limits
- [Mapping persistence](plugin/persistence.md): opt-in encrypted storage, key custody, erasure
- [Capacity and lifecycle](plugin/capacity.md): budgets, session limits, retention
- [Readonly env queries](plugin/env-queries.md): opt-in tools that answer configuration questions without returning values

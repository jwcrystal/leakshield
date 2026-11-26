# Security Policy

leakshield is a guard for what reaches an AI model, so a bypass is a security bug even when no credential is involved. This applies to every model-facing entry point: the OpenCode plugin, the pi extension and the Claude Code proxy.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue, pull request or discussion for a leak or bypass.

Include, using synthetic values only (never a real secret):

- the LeakShield version (`npm ls -g leakshield`, or the commit for a source build) and the host with its version:
  - **OpenCode**: the plugin options (`mode`, `wireProtection`, `attachments`, `persistence`);
  - **pi**: how the extension is loaded (`pi install`, `settings.extensions` position, or `-e`), the selected provider's `api`, and any `LEAKSHIELD_PI_PERSIST*` variables;
  - **Claude Code**: the proxy flags (`--upstream`, `--attachments`, `--config`) and where `ANTHROPIC_BASE_URL` is set;
  - **CLI / Web UI**: the command line or request;
- the output of `leakshield --doctor <host>` for that host;
- the input that reached the model unmasked, or the restoration that went wrong;
- how you observed it (captured request, provider log, test).

You should get an acknowledgement within a week. Fixes land on `main` with a regression test and ship in the next release; credit is given in the changelog unless you prefer otherwise.

## In scope

- A value the configured rules detect reaches the model in clear text through a supported host setup that `--doctor` reports as `PROTECTED` or `PARTIAL`, outside the residuals that host declares (see below).
- A way to hide a detectable value from the scanner (encoding, Unicode, splitting) that is not already documented as a limitation.
- A request the adapter cannot mask that is forwarded instead of refused.
- A placeholder restored to the wrong original, across sessions, or into an unsafe tool argument.
- Persisted mappings readable without the key, or surviving `--forget`.

## Out of scope

Documented limitations are not vulnerabilities by themselves. Each host's declared coverage and residuals are printed by `leakshield --doctor <host>` and listed in the [host capability matrix](docs/host-capabilities.md).

All hosts:

- traffic that does not pass the interception point (host telemetry, analytics or crash reports, a local process or permitted tool that sends data itself: `curl`, a remote MCP server);
- values no built-in or configured rule detects;
- local history, logs and files containing originals.

OpenCode:

- hook-only mode (`wireProtection: false`) does not inspect final outbound bodies;
- content added after the plugin's hooks.

pi:

- a pi process started without the extension, or with `--no-extensions`;
- an extension loaded before LeakShield that keeps the raw `fetch`;
- providers whose transport bypasses `fetch` (Codex WebSocket, Bedrock, Google auth) are refused, not guarded; OAuth-only accounts are not supported.

Claude Code:

- placeholders inside tool calls are not restored yet;
- requests that do not use `ANTHROPIC_BASE_URL` (WebFetch's domain check, Bedrock/Vertex/Foundry, cloud sessions);
- Claude Code started without the proxy, or with the proxy not running.

## Supported versions

LeakShield is `0.x`. Only the latest published release on npm and `main` receive security fixes.

| Version | Supported |
| ------- | --------- |
| latest `0.x` release | ✅ |
| older releases | ❌ |

# Security Policy

leakshield is a guard for what reaches an AI model, so a bypass is a security bug even when no credential is involved.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue, pull request or discussion for a leak or bypass.

Include, using synthetic values only (never a real secret):

- the mode and options (`mode`, `wireProtection`, `attachments`, `persistence`) and the OpenCode version;
- the input that reached the model unmasked, or the restoration that went wrong;
- how you observed it (captured request, provider log, test).

You should get an acknowledgement within a week. Fixes land on `main` with a regression test; credit is given in the changelog unless you prefer otherwise.

## In scope

- A value the configured rules detect reaches the model in clear text in a supported setup.
- A way to hide a detectable value from the scanner (encoding, Unicode, splitting) that is not already documented as a limitation.
- A placeholder restored to the wrong original, across sessions, or into an unsafe tool argument.
- Persisted mappings readable without the key, or surviving `--forget`.

## Out of scope

Documented limitations are not vulnerabilities by themselves; see the "Project status" section of the README and `--doctor`'s coverage notes:

- hook-only mode (`wireProtection: false`) does not inspect final outbound bodies;
- content added after the plugin's hooks, and permitted tool egress (curl, remote MCP, etc.);
- values no built-in or configured rule detects;
- local history, logs and files containing originals.

## Supported versions

Only `main` is supported until the first tagged release.

# Mapping persistence (opt-in)

> 🌐 English | [繁體中文](./persistence.zh-TW.md)

[← OpenCode plugin](../opencode.md)

> ⚠️ Read the [persistence risk notes](../../README.md#persistence-risk-notes-read-before-enabling) before enabling.

## Enabling

Set `"persistence": { "enabled": true }` in transparent mode to survive restarts — mappings persist encrypted (per-entry AES-256-GCM, AAD-bound) in a SQLite store (default `~/.local/share/leakshield/SGP.db`) and rehydrate on a session's first touch, so previously saved placeholders in resumed sessions keep restoring.

Requires Node.js 22.13+ (built-in `node:sqlite`); on an older runtime the store cannot open and mappings stay memory-only with a WARN.

Options: `ttlDays` (default 7; 0 = manual erasure only), `path` (store location), `keyFile`/`keyfilePath` (weaker fallback when no OS keychain exists).

## Key custody

Key custody resolves down a ladder — OS keychain (macOS Keychain / Windows DPAPI / Linux libsecret) → explicit keyfile → memory-only degrade.

## What `--doctor` and logs report

Runtime logs report `persistence: active; key=os-keychain|keyfile` when the store opens successfully; later degradation emits a WARN.

Missing keys do not directly refuse conversations, but an unsaved old token can still fail the tool gate.

`--doctor` reports configuration/store readability as **unverified**, not runtime activation or decryptability, and never touches the real keychain.

## Retention and erasure

TTL cleanup runs when a writer opens the store, not on a timer; saving a changed mapping snapshot extends expiry, while reads do not.

Seven days is not a hard deletion deadline.

Persistence cannot recover mappings already lost before activation.

Active erasure: `leakshield --forget --all` (or `--session <id>`) deletes persisted mappings, counts only in output.

Erasure is logical plus in-file best effort (`secure_delete` zeroes freed pages, `forget --all` also vacuums and truncates the WAL); physical-media and backup residue (SSD wear leveling, snapshots, restores) are out of scope.

Switching the key source after enabling (keychain ↔ keyfile) refuses to open the store — it degrades memory-only until `forget --all` resets — rather than silently re-keying history.

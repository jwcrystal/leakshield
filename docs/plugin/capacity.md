# Transparent capacity and lifecycle

> 🌐 English | [繁體中文](./capacity.zh-TW.md)

[← README](../../README.md#opencode-plugin-recommended)

The guard uses an 8 Mi UTF-16-unit combined input/output budget and 100,000 value nodes per protect/restore operation, rather than applying the standalone core's 1 Mi-unit budget to an entire history. HTTP bodies and WS frames retain their 4 MiB limits; scanner `max_chars`, depth 32, mapping-entry and aggregate mapping-memory caps remain enforced. Up to 4,096 sessions can be retained per guard instance; live mappings are never LRU-evicted to admit another session.

The public V2 `session.deleted` event releases only that session's RAM, prepared-response proof and WS buffers. Idle, completed and interrupted sessions retain mappings for resume. Missing/failed lifecycle subscriptions retain mappings until unload, so capacity remains finite, not an unlimited-lifetime guarantee.

Deletion does not erase encrypted persisted rows: TTL/explicit `forget` remain their retention policy. [Local verification and remaining live-test gap](../evidence/2026-10-14-transparent-capacity-verification.md).

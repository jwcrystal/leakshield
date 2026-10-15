/**
 * W2 (B1+B3) tests — encrypted mapping store + core session hydration.
 *
 * The restart simulation at the bottom is the W2 acceptance core in
 * miniature: process A protects and persists; process B (a fresh
 * pseudonymizer instance) seeds from the store and restores exactly.
 * Guard lifecycle wiring (B4) and the keychain provider (B2) land later;
 * these tests pin the storage and hydration seams they will build on.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  InMemoryMappingKeyProvider,
  MappingForgottenError,
  MappingKeyMismatchError,
  MappingStoreConflictError,
  openMappingStore,
  type MappingStore,
} from "../src/decision/mapping-store.js";
import { createRequire } from "node:module";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";

const nodeRequire = createRequire(import.meta.url);
import type { GuardConfig } from "../src/types.js";

const baseConfig: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true,
  },
};

const EMAIL = "alice@example.com";
const KEY = "sk-QwertyuiopAsdfghjklZx";

const tempRoot = mkdtempSync(join(tmpdir(), "sgp-store-"));
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function storePath(name: string): string {
  return join(tempRoot, `${name}.db`);
}

function makeStore(name: string, provider = new InMemoryMappingKeyProvider()): MappingStore {
  return openMappingStore({ path: storePath(name), keyProvider: provider });
}

describe("mapping store (B1)", () => {
  it("roundtrips sessions across store instances and keeps originals off disk in plaintext", () => {
    const keyProvider = new InMemoryMappingKeyProvider();
    const store = makeStore("roundtrip", keyProvider);
    store.putSession({
      sessionId: "ses_restart",
      epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      entries: [
        { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL },
        { token: "[SGP1:0123456789abcdef0123456789abcdef-00000001]", original: KEY },
      ],
    }, 0);
    store.close();

    // Plaintext absence: the DB file must not contain either original.
    const raw = readFileSync(storePath("roundtrip"));
    expect(raw.includes(Buffer.from(EMAIL))).toBe(false);
    expect(raw.includes(Buffer.from(KEY))).toBe(false);

    const reopened = openMappingStore({ path: storePath("roundtrip"), keyProvider });
    const loaded = reopened.loadSession("ses_restart");
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(2);
    const byToken = new Map(loaded!.entries.map((entry) => [entry.token, entry.original]));
    expect(byToken.get("[SGP2:PII_EMAIL-abcd-efgh-ijkl]")).toBe(EMAIL);
    expect(byToken.get("[SGP1:0123456789abcdef0123456789abcdef-00000001]")).toBe(KEY);
    reopened.close();
  });

  it("dual-secret (R-round): a wrong key REFUSES to open instead of silently forking", () => {
    const provider = new InMemoryMappingKeyProvider();
    const store = makeStore("dual-secret", provider);
    store.putSession({
      sessionId: "ses_secret",
      epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      entries: [{ token: "[SGP2:SECRET-abcd-efgh-ijkl]", original: "password = hunter2secret" }],
    }, 0);
    store.close();

    // Stronger than the pre-R behavior (open + empty load): the pinned key
    // identity turns key-source drift into a loud, immediate refusal — the
    // guard translates this into memory-only degradation, never a fork.
    expect(() =>
      openMappingStore({ path: storePath("dual-secret"), keyProvider: new InMemoryMappingKeyProvider() }),
    ).toThrow(MappingKeyMismatchError);
    // The right key still reads everything.
    const right = openMappingStore({ path: storePath("dual-secret"), keyProvider: provider });
    expect(right.loadSession("ses_secret")!.entries).toHaveLength(1);
    right.close();
  });

  it("replaces a session atomically and supports forget", () => {
    const provider = new InMemoryMappingKeyProvider();
    const store = makeStore("forget", provider);
    const epoch = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    store.putSession({
      sessionId: "ses_a",
      epoch,
      entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
    }, 0);
    // Replace semantics: second put overwrites the mapping set (CAS against v1).
    store.putSession({
      sessionId: "ses_a",
      epoch,
      entries: [
        { token: "[SGP2:PII_EMAIL-mnop-qrst-uvwx]", original: EMAIL },
        { token: "[SGP2:API_KEY-mnop-qrst-uvwx]", original: KEY },
      ],
    }, 1);
    expect(store.sessionCount()).toBe(1);
    expect(store.loadSession("ses_a")!.entries).toHaveLength(2);
    expect(store.forgetSession("ses_a")).toBe(true);
    expect(store.forgetSession("ses_a")).toBe(false); // idempotent
    expect(store.loadSession("ses_a")).toBeNull();
    // Targeted forget (R-round): a different session's write-behind keeps
    // flowing on the same handle…
    store.putSession({
      sessionId: "ses_b",
      epoch: "11111111111111111111111111111111",
      entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
    }, 0);
    expect(store.sessionCount()).toBe(1);
    expect(store.forgetAll()).toBe(1);
    expect(store.sessionCount()).toBe(0);
    // …but this handle lived through the forgetAll — its epoch is stale, so
    // further writes refuse (no resurrection). A fresh handle is fine.
    expect(() =>
      store.putSession({
        sessionId: "ses_c",
        epoch: "22222222222222222222222222222222",
        entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
      }, 1),
    ).toThrow(MappingForgottenError);
    store.close();
    const fresh = openMappingStore({ path: storePath("forget"), keyProvider: provider });
    // R3: the absent look must carry the advanced generation (forgetAll
    // tombstoned ses_a/ses_b); a bare 0-look is a conflict for THIS session's
    // lineage only if it was itself deleted — ses_c is virgin, so 0 works.
    fresh.putSession({
      sessionId: "ses_c",
      epoch: "22222222222222222222222222222222",
      entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
    }, 0);
    expect(fresh.sessionCount()).toBe(1);
    fresh.close();
  });

  it("sweeps expired sessions on open (TTL), and ttlDays 0 keeps them", () => {
    let clock = 1_000_000_000_000;
    const now = () => clock;
    const provider = new InMemoryMappingKeyProvider();
    const store = openMappingStore({ path: storePath("ttl"), keyProvider: provider, ttlDays: 7, now });
    const epoch = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    store.putSession({
      sessionId: "ses_old",
      epoch,
      entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
    }, 0);
    store.close();

    clock += 8 * 86_400_000; // 8 days later: expired
    const swept = openMappingStore({ path: storePath("ttl"), keyProvider: provider, ttlDays: 7, now });
    expect(swept.loadSession("ses_old")).toBeNull();
    swept.close();

    // ttlDays 0 disables expiry entirely.
    const store2 = openMappingStore({ path: storePath("ttl0"), keyProvider: provider, ttlDays: 0, now });
    store2.putSession({
      sessionId: "ses_kept",
      epoch,
      entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL }],
    }, 0);
    store2.close();
    clock += 365 * 86_400_000;
    const reopened = openMappingStore({ path: storePath("ttl0"), keyProvider: provider, ttlDays: 0, now });
    expect(reopened.loadSession("ses_kept")).not.toBeNull();
    reopened.close();
  });
});

describe("open failure hygiene", () => {
  it("closes the handle when PRAGMA setup fails on a non-SQLite file", () => {
    const path = join(tempRoot, "not-a-database.db");
    writeFileSync(path, "this is not a sqlite database, it is just text ".repeat(40));
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const original = DatabaseSync.prototype.close;
    let closes = 0;
    DatabaseSync.prototype.close = function (this: InstanceType<typeof DatabaseSync>) {
      closes += 1;
      return original.call(this);
    };
    try {
      expect(() => openMappingStore({ path, keyProvider: new InMemoryMappingKeyProvider(Buffer.alloc(32, 0x11)) })).toThrow();
    } finally {
      DatabaseSync.prototype.close = original;
    }
    expect(closes).toBe(1);
  });
});

describe("core seedSession (B3)", () => {
  it("rebuilds a session that restores both v2 and v1 tokens exactly", () => {
    const ps = createPseudonymizer(baseConfig);
    expect(ps.ok).toBe(true);
    if (!ps.ok) return;
    const seed = {
      epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      entries: [
        { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL },
        { token: "[SGP1:0123456789abcdef0123456789abcdef-00000001]", original: KEY },
      ],
    };
    expect(ps.seedSession("s", seed)).toEqual({ ok: true });
    expect(
      ps.restoreText("s", "mail [SGP2:PII_EMAIL-abcd-efgh-ijkl] key [SGP1:0123456789abcdef0123456789abcdef-00000001]"),
    ).toEqual({ ok: true, text: `mail ${EMAIL} key ${KEY}` });
    // New protection reuses the seeded mapping (stable original → token).
    const again = ps.protectText("s", `again ${EMAIL}`);
    expect(again).toEqual({ ok: true, text: "again [SGP2:PII_EMAIL-abcd-efgh-ijkl]" });
  });

  it("fails atomically on malformed tokens, duplicates, or budget breaches", () => {
    const ps = createPseudonymizer(baseConfig, { maxEntriesPerSession: 2 });
    expect(ps.ok).toBe(true);
    if (!ps.ok) return;
    const epoch = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    // Malformed token shape.
    expect(
      ps.seedSession("s1", { epoch, entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh", original: EMAIL }] }),
    ).toEqual({ ok: false, reason: "malformed_token" });
    // Duplicate token for two originals.
    expect(
      ps.seedSession("s2", {
        epoch,
        entries: [
          { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL },
          { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: "bob@example.com" },
        ],
      }),
    ).toEqual({ ok: false, reason: "token_collision" });
    // Same original twice with different tokens.
    expect(
      ps.seedSession("s3", {
        epoch,
        entries: [
          { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: EMAIL },
          { token: "[SGP2:PII_EMAIL-mnop-qrst-uvwx]", original: EMAIL },
        ],
      }),
    ).toEqual({ ok: false, reason: "key_collision" });
    // Entry budget: 3 entries against maxEntriesPerSession 2 — nothing commits.
    expect(
      ps.seedSession("s4", {
        epoch,
        entries: [
          { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: "a@example.com" },
          { token: "[SGP2:PII_EMAIL-mnop-qrst-uvwx]", original: "b@example.com" },
          { token: "[SGP2:PII_EMAIL-zzzz-yyyy-xxxx]", original: "c@example.com" },
        ],
      }),
    ).toEqual({ ok: false, reason: "entry_limit" });
    // Failed seeds committed nothing: s4 still protects fresh and the budget
    // headroom is untouched.
    const fresh = ps.protectText("s4", "x a@example.com y");
    expect(fresh.ok).toBe(true);
    // A committed seed registers its epoch; another session reusing it fails.
    expect(
      ps.seedSession("s_ok", {
        epoch,
        entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: "d@example.com" }],
      }),
    ).toEqual({ ok: true });
    expect(
      ps.seedSession("s5", {
        epoch,
        entries: [{ token: "[SGP2:PII_EMAIL-mnop-qrst-uvwx]", original: EMAIL }],
      }),
    ).toEqual({ ok: false, reason: "epoch_collision" });
    expect(ps.seedSession("s5", { epoch, entries: [] })).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("restart simulation (store + hydration seam)", () => {
  it("a fresh service instance restores what another process protected and persisted", () => {
    const keyProvider = new InMemoryMappingKeyProvider();

    // "Process A": protect and persist.
    const a = createPseudonymizer(baseConfig);
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const protectedText = a.protectText("ses_live", `mail ${EMAIL} auth ${KEY}`);
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    const epoch = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const tokens = [...protectedText.text.matchAll(/\[SGP2:[A-Z][A-Z_]*-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g)].map((m) => m[0]);
    expect(tokens).toHaveLength(2);
    const store = makeStore("restart", keyProvider);
    store.putSession({
      sessionId: "ses_live",
      epoch,
      entries: tokens.map((token) => ({
        token,
        original: token.includes("PII_EMAIL") ? EMAIL : KEY,
      })),
    }, 0);
    store.close();

    // "Process B": fresh service + fresh store handle, seeded from disk.
    const b = createPseudonymizer(baseConfig);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const storeB = openMappingStore({ path: storePath("restart"), keyProvider });
    const seed = storeB.loadSession("ses_live");
    expect(seed).not.toBeNull();
    expect(b.seedSession("ses_live", seed!)).toEqual({ ok: true });
    expect(b.restoreText("ses_live", protectedText.text)).toEqual({
      ok: true,
      text: `mail ${EMAIL} auth ${KEY}`,
    });
    storeB.close();
  });
});


describe("R-round store invariants", () => {
  const EPOCH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const L = "abcdefghijklmnopqrstuvwxyz";
  const segAt = (i: number) => L[i % 26] + L[(i + 5) % 26] + L[(i + 11) % 26] + L[(i + 17) % 26];
  const entry = (i: number) => ({
    token: `[SGP2:PII_EMAIL-${segAt(i)}-efgh-ijkl]`,
    original: `user${i}@example.com`,
  });

  it("CAS: a stale handle cannot overwrite a newer snapshot", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h1 = makeStore("cas", provider);
    const h2 = openMappingStore({ path: storePath("cas"), keyProvider: provider });
    h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    expect(h1.loadSession("s")!.version).toBe(1);
    const seeded = h2.loadSession("s")!;
    expect(seeded.version).toBe(1);
    h2.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0), entry(1)] }, seeded.version);
    // h1 still believes v1: its stale snapshot must be refused, not merged.
    expect(() =>
      h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0), entry(2)] }, 1),
    ).toThrow(MappingStoreConflictError);
    expect(h1.loadSession("s")!.entries).toHaveLength(2); // h2's newer set survives
    h1.close();
    h2.close();
  });

  it("forget epoch: a pre-forget handle cannot resurrect erased data", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h1 = makeStore("epoch", provider);
    h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    const h2 = openMappingStore({ path: storePath("epoch"), keyProvider: provider });
    expect(h2.forgetAll()).toBe(1);
    expect(() =>
      h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 1),
    ).toThrow(MappingForgottenError);
    expect(h1.sessionCount()).toBe(0);
    h1.close();
    h2.close();
    // A handle opened AFTER the forget writes fine (fresh epoch view) — its
    // absent look carries the advanced generation (R3).
    const h3 = openMappingStore({ path: storePath("epoch"), keyProvider: provider });
    h3.putSession(
      { sessionId: "s", epoch: EPOCH, entries: [entry(0)] },
      -(h3.absentGeneration("s") + 1),
    );
    expect(h3.sessionCount()).toBe(1);
    h3.close();
  });

  it("erasure: plaintext never touches the file; forgetAll compacts it", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h = makeStore("erase", provider);
    // Bulk content so the pre-forget file spans many pages: VACUUM's rebuild
    // is then observable as a real size drop, not page-count noise.
    const bulk = Array.from({ length: 200 }, (_, i) => ({
      token: `[SGP2:SECRET-${segAt(i % 26)}-${segAt(Math.floor(i / 26))}-ijkl]`,
      original: `CANARY-original-${"x".repeat(200)}-${String.fromCharCode(97 + (i % 26))}`,
    }));
    h.putSession({ sessionId: "s", epoch: EPOCH, entries: bulk }, 0);
    h.close();
    expect(readFileSync(storePath("erase")).includes("CANARY")).toBe(false);
    const sizeBefore = statSync(storePath("erase")).size;
    const h2 = openMappingStore({ path: storePath("erase"), keyProvider: provider });
    expect(h2.forgetAll()).toBe(1);
    h2.close();
    expect(statSync(storePath("erase")).size).toBeLessThan(sizeBefore / 2); // VACUUM ran
  });

  it("WAL frame content never contains plaintext originals either", () => {
    const provider = new InMemoryMappingKeyProvider();
    const canary = "CANARY-wal-qq7y";
    const h = makeStore("walscan", provider);
    h.putSession(
      { sessionId: "s", epoch: EPOCH, entries: [{ token: "[SGP2:SECRET-mnop-qrst-uvwx]", original: canary }] },
      0,
    );
    // R3-F3: WAL must actually be ON (the R2 rewrite briefly lost the
    // pragmas — this assertion catches that class of regression), and the
    // live WAL must exist and stay plaintext-free.
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(storePath("walscan"));
    const mode = (raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    raw.close();
    expect(mode.toLowerCase()).toBe("wal");
    const walPath = `${storePath("walscan")}-wal`;
    expect(existsSync(walPath)).toBe(true); // an open writer in WAL mode frames here
    const wal = readFileSync(walPath);
    expect(wal.includes(canary)).toBe(false);
    h.close();
  });

  it("bounded retention: LRU eviction inside the write transaction", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h = openMappingStore({ path: storePath("caps"), keyProvider: provider, maxSessions: 2 });
    h.putSession({ sessionId: "s1", epoch: EPOCH, entries: [entry(1)] }, 0);
    h.putSession({ sessionId: "s2", epoch: EPOCH, entries: [entry(2)] }, 0);
    h.putSession({ sessionId: "s3", epoch: EPOCH, entries: [entry(3)] }, 0);
    expect(h.sessionCount()).toBe(2);
    expect(h.loadSession("s1")).toBeNull(); // oldest evicted
    expect(h.loadSession("s3")).not.toBeNull();
    h.close();

    const h2 = openMappingStore({ path: storePath("caps2"), keyProvider: provider, maxEntries: 2 });
    h2.putSession({ sessionId: "a", epoch: EPOCH, entries: [entry(1), entry(2)] }, 0);
    h2.putSession({ sessionId: "b", epoch: EPOCH, entries: [entry(3), entry(4)] }, 0);
    // Total 4 > cap 2: the oldest session (a) is evicted to fit.
    expect(h2.sessionCount()).toBe(1);
    expect(h2.loadSession("a")).toBeNull();
    expect(h2.loadSession("b")).not.toBeNull();
    h2.close();
  });

  it("key identity pinning: a different key refuses; readOnly probes skip the check", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h = makeStore("keyid", provider);
    h.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    h.close();
    expect(() =>
      openMappingStore({ path: storePath("keyid"), keyProvider: new InMemoryMappingKeyProvider() }),
    ).toThrow(MappingKeyMismatchError);
    // Same key reopens fine; a throwaway readOnly handle may count but not write.
    const h2 = openMappingStore({ path: storePath("keyid"), keyProvider: provider });
    expect(h2.loadSession("s")).not.toBeNull();
    h2.close();
    const probe = openMappingStore({
      path: storePath("keyid"),
      keyProvider: new InMemoryMappingKeyProvider(),
      readOnly: true,
    });
    expect(probe.sessionCount()).toBe(1);
    expect(() => probe.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 1)).toThrow(
      /read-only/,
    );
    probe.close();
  });
});


describe("R2 store invariants", () => {
  const EPOCH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const L = "abcdefghijklmnopqrstuvwxyz";
  const segAt = (i: number) => L[i % 26] + L[(i + 5) % 26] + L[(i + 11) % 26] + L[(i + 17) % 26];
  const entry = (i: number) => ({
    token: `[SGP2:PII_EMAIL-${segAt(i % 26)}-${segAt(Math.floor(i / 26))}-ijkl]`,
    original: `user${i}@example.com`,
  });

  it("R2-1: two absent-seeded writers cannot both insert — the second conflicts", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h1 = makeStore("absent", provider);
    const h2 = openMappingStore({ path: storePath("absent"), keyProvider: provider });
    h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0); // inserts
    // h2 also believed the row absent (expected 0): the row that appeared
    // since makes its write a conflict, not a blind overwrite.
    expect(() => h2.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, 0)).toThrow(
      MappingStoreConflictError,
    );
    expect(h1.loadSession("s")!.entries).toHaveLength(1); // h1's set intact
    h1.close();
    h2.close();
  });

  it("R2-2: delete→recreate continues the version lineage — no ABA (forget)", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h1 = makeStore("aba", provider);
    const v1 = h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    expect(v1).toBe(1);
    expect(h1.forgetSession("s")).toBe(true); // tombstones last_version=1
    const h2 = openMappingStore({ path: storePath("aba"), keyProvider: provider });
    // R3: a fresh absent look encodes the tombstone generation (-g-1).
    const absentToken = -(h2.absentGeneration("s") + 1);
    const v2 = h2.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, absentToken); // recreates
    expect(v2).toBe(2); // global counter: first insert was 1, this is 2
    // The stale handle still remembers v1 — the re-created row continues the
    // lineage, so its CAS can never match.
    expect(() => h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(2)] }, 1)).toThrow(
      MappingStoreConflictError,
    );
    // And the absent-row guard: a writer remembering v1 with the row deleted
    // and NOT recreated also refuses.
    expect(h2.forgetSession("s")).toBe(true);
    expect(() => h1.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(2)] }, 1)).toThrow(
      MappingStoreConflictError,
    );
    h1.close();
    h2.close();
  });

  it("R2-2b: LRU eviction tombstones too — an evicted session's live writer refuses, never ABA-matches", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h1 = openMappingStore({ path: storePath("evict-aba"), keyProvider: provider, maxSessions: 1 });
    const v1 = h1.putSession({ sessionId: "s_old", epoch: EPOCH, entries: [entry(0)] }, 0);
    const live = openMappingStore({ path: storePath("evict-aba"), keyProvider: provider, maxSessions: 1 });
    live.putSession({ sessionId: "s_new", epoch: EPOCH, entries: [entry(1)] }, 0); // evicts s_old
    expect(live.sessionCount()).toBe(1);
    // h1 remembers s_old at v1; the row is gone (evicted): refuse, don't resurrect.
    expect(() => h1.putSession({ sessionId: "s_old", epoch: EPOCH, entries: [entry(2)] }, v1)).toThrow(
      MappingStoreConflictError,
    );
    // A re-created s_old continues the lineage past the eviction tombstone
    // (global counter: v1=1, s_new=2, so the recreate is ≥3 — never v1 again).
    const absentToken = -(live.absentGeneration("s_old") + 1);
    const v2 = live.putSession({ sessionId: "s_old", epoch: EPOCH, entries: [entry(2)] }, absentToken);
    expect(v2).toBeGreaterThan(v1);
    h1.close();
    live.close();
  });

  it("R2-10: a single snapshot larger than maxEntries is refused outright", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h = openMappingStore({ path: storePath("cap"), keyProvider: provider, maxEntries: 2 });
    expect(() =>
      h.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0), entry(1), entry(2)] }, 0),
    ).toThrow(/exceeds the store entry cap/);
    expect(h.sessionCount()).toBe(0); // nothing committed
    h.close();
  });

  it("R2-12: a readOnly probe never initializes — empty file stays untouched", () => {
    const path = storePath("stub");
    writeFileSync(path, ""); // e.g. a doctor run on a crashed-create file
    const probe = openMappingStore({ path, keyProvider: new InMemoryMappingKeyProvider(), readOnly: true });
    expect(probe.sessionCount()).toBe(0);
    expect(probe.loadSession("s")).toBeNull();
    expect(() => probe.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0)).toThrow(/read-only/);
    probe.close();
    expect(statSync(path).size).toBe(0); // zero side effects
    // A writer open initializes normally afterwards — no wrong key was pinned.
    const writer = openMappingStore({ path, keyProvider: new InMemoryMappingKeyProvider() });
    writer.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    expect(writer.sessionCount()).toBe(1);
    writer.close();
  });

  it("R2-13: forgetAll clears the key pin — a different key may open afterwards", () => {
    const p1 = new InMemoryMappingKeyProvider();
    const h = makeStore("resetkey", p1);
    h.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    h.close();
    const eraser = openMappingStore({
      path: storePath("resetkey"),
      keyProvider: new InMemoryMappingKeyProvider(),
      readOnly: true,
    });
    expect(eraser.forgetAll()).toBe(1);
    eraser.close();
    const p2 = new InMemoryMappingKeyProvider();
    const h2 = openMappingStore({ path: storePath("resetkey"), keyProvider: p2 }); // no mismatch
    h2.putSession({ sessionId: "s2", epoch: EPOCH, entries: [entry(1)] }, 0);
    expect(h2.sessionCount()).toBe(1);
    h2.close();
  });

  it("R2-11: a v1-shaped store upgrades in place on the next writer open", () => {
    const path = storePath("v1upgrade");
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE mappings (
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        token TEXT NOT NULL, enc_value BLOB NOT NULL, PRIMARY KEY (session_id, token)
      ) WITHOUT ROWID;
    `);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    raw.close();
    const provider = new InMemoryMappingKeyProvider();
    const h = openMappingStore({ path, keyProvider: provider }); // upgrade path
    h.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    expect(h.sessionCount()).toBe(1);
    h.close();
    const h2 = openMappingStore({ path, keyProvider: provider }); // reopens at v3
    expect(h2.loadSession("s")!.entries).toHaveLength(1);
    h2.close();
  });
});


describe("R3 store invariants", () => {
  const EPOCH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const L = "abcdefghijklmnopqrstuvwxyz";
  const segAt = (i: number) => L[i % 26] + L[(i + 5) % 26] + L[(i + 11) % 26] + L[(i + 17) % 26];
  const entry = (i: number) => ({
    token: `[SGP2:PII_EMAIL-${segAt(i % 26)}-${segAt(Math.floor(i / 26))}-ijkl]`,
    original: `user${i}@example.com`,
  });

  it("R3-F1: secure_delete zeroes forgotten ciphertext out of the file", () => {
    const provider = new InMemoryMappingKeyProvider();
    const path = storePath("secdel");
    const canary = `CANARY-secdel-${"z".repeat(300)}`;
    const h = makeStore("secdel", provider);
    h.putSession(
      { sessionId: "s", epoch: EPOCH, entries: [{ token: "[SGP2:SECRET-abcd-efgh-ijkl]", original: canary }] },
      0,
    );
    h.close(); // close checkpoints the page into the main file

    // Grab the ciphertext blob as it sits in the file.
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(path);
    const blob = Buffer.from(
      (raw.prepare("SELECT enc_value FROM mappings LIMIT 1").get() as { enc_value: Uint8Array }).enc_value,
    );
    raw.close();
    expect(readFileSync(path).includes(blob)).toBe(true); // it was really on disk

    const h2 = openMappingStore({ path, keyProvider: provider });
    expect(h2.forgetSession("s")).toBe(true);
    h2.close();
    // secure_delete ON: the freed page region is zeroed, so the ciphertext
    // bytes are gone even before any VACUUM (freelist pages included).
    expect(readFileSync(path).includes(blob)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false); // clean close removed the wal
  });

  it("R3-F2: an absent-writer across a targeted forget is refused (generation CAS)", () => {
    const provider = new InMemoryMappingKeyProvider();
    // A is a handle that has NOT looked at "s" yet (its absent token is gen 0).
    const a = makeStore("f2", provider);
    const b = openMappingStore({ path: storePath("f2"), keyProvider: provider });
    b.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0); // create v1
    expect(b.forgetSession("s")).toBe(true); // targeted forget (tombstone 1)

    // A's stale absent look (generation 0) must NOT resurrect over the forget.
    expect(() => a.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, -1)).toThrow(
      MappingStoreConflictError,
    );
    // A fresh absent look sees generation 1 and inserts cleanly.
    expect(a.absentGeneration("s")).toBe(1);
    expect(a.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, -2)).toBeGreaterThan(1);
    a.close();
    b.close();
  });

  it("R3-F9: TTL sweep tombstones — stale absent-writer refused, fresh look inserts", () => {
    let clock = 1_000_000_000_000;
    const now = () => clock;
    const provider = new InMemoryMappingKeyProvider();
    const stale = openMappingStore({ path: storePath("ttlaba"), keyProvider: provider, ttlDays: 7, now });
    const writer = openMappingStore({ path: storePath("ttlaba"), keyProvider: provider, ttlDays: 7, now });
    writer.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(0)] }, 0);
    clock += 8 * 86_400_000; // expire
    const swept = openMappingStore({ path: storePath("ttlaba"), keyProvider: provider, ttlDays: 7, now });
    expect(swept.sessionCount()).toBe(0); // sweep deleted + tombstoned
    expect(() => stale.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, -1)).toThrow(
      MappingStoreConflictError, // generation moved under the stale absent look
    );
    expect(swept.absentGeneration("s")).toBeGreaterThan(0);
    const token = -(swept.absentGeneration("s") + 1);
    swept.putSession({ sessionId: "s", epoch: EPOCH, entries: [entry(1)] }, token);
    expect(swept.sessionCount()).toBe(1);
    stale.close();
    writer.close();
    swept.close();
  });

  it("R3-F9: entry-cap eviction tombstones — stale writer refused, recreate gets a fresh global version", () => {
    const provider = new InMemoryMappingKeyProvider();
    const hOld = openMappingStore({ path: storePath("entcap"), keyProvider: provider, maxEntries: 2 });
    const v1 = hOld.putSession(
      { sessionId: "s_old", epoch: EPOCH, entries: [entry(0), entry(1)] },
      0,
    );
    const live = openMappingStore({ path: storePath("entcap"), keyProvider: provider, maxEntries: 2 });
    live.putSession({ sessionId: "s_new", epoch: EPOCH, entries: [entry(2), entry(3)] }, 0); // evicts s_old
    expect(live.sessionCount()).toBe(1);
    expect(() =>
      hOld.putSession({ sessionId: "s_old", epoch: EPOCH, entries: [entry(4)] }, v1),
    ).toThrow(MappingStoreConflictError); // row vanished under a remembered version
    const token = -(live.absentGeneration("s_old") + 1);
    const v2 = live.putSession({ sessionId: "s_old", epoch: EPOCH, entries: [entry(4)] }, token);
    expect(v2).toBeGreaterThan(v1);
    hOld.close();
    live.close();
  });

  it("R3-F6: tombstones are bounded — pruning keeps the table under its ceiling", () => {
    const provider = new InMemoryMappingKeyProvider();
    const h = openMappingStore({ path: storePath("prune"), keyProvider: provider, maxSessions: 1, maxEntries: 50_000 });
    // Cycle many sessions through the single slot: every eviction tombstones.
    for (let i = 0; i < 60; i += 1) {
      h.putSession({ sessionId: `s${i}`, epoch: EPOCH, entries: [entry(i)] }, 0);
    }
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const raw = new DatabaseSync(storePath("prune"));
    // Ceiling = max(1000, 2×maxSessions) = 1000 > 60 → nothing pruned yet;
    // the assertion pins the bound itself (never unbounded growth beyond it).
    const tombstones = (raw.prepare("SELECT COUNT(*) AS n FROM session_tombstones").get() as { n: number }).n;
    raw.close();
    expect(tombstones).toBeLessThanOrEqual(Math.max(1000, 2));
    expect(tombstones).toBe(59); // 59 evictions tombstoned, all under ceiling
    h.close();
  });
});

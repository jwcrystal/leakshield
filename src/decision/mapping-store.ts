/**
 * W2 (B1, R2 2026-10-07) encrypted SQLite mapping store — the persistence
 * adapter for the transparent pseudonymization core (decision
 * `docs/plans/2026-10-07-persistence-decision-db-over-t2.md`).
 *
 * Design constraints (decision §4 + external-review R1/R2 rounds):
 * - Per-entry AES-256-GCM; AAD binds `sessionId || token` so a row moved
 *   between sessions/tokens fails authentication instead of decrypting.
 * - Originals NEVER appear in plaintext anywhere in the file (tokens do —
 *   they are non-sensitive by design: they ride transcripts already).
 * - Dual-secret custody: this module needs BOTH the DB file and the key
 *   provider's key; either alone exposes nothing.
 * - Degrade, never fail-closed: unreadable DB → the caller falls back to
 *   memory-only; undecryptable rows are skipped (treated as absent).
 * - WAL journal; writes are single transactions; lazy TTL sweep on open
 *   (writer handles only — readOnly handles never write).
 * - Pure storage: no OpenCode imports, no config coupling. The core stays
 *   fs/db-free; this adapter feeds it via seedSession (B3).
 *
 * Concurrency & lifecycle invariants (R1+R2):
 * - Lazy `node:sqlite` load: a runtime without the driver must not break
 *   plugin load when persistence is OFF (zero-diff default path).
 * - Initialization (DDL, version upgrade, meta bootstrap, key pinning) runs
 *   in ONE BEGIN IMMEDIATE transaction with ON CONFLICT DO NOTHING inserts:
 *   two first-openers can never clobber each other's key identity (R2-3).
 * - Key identity pinning: sha256(key) prefix recorded in meta. Opening with
 *   a DIFFERENT key throws MappingKeyMismatchError (memory-only degrade),
 *   never silently re-keys. `forgetAll` clears the pin so a mismatched store
 *   can be deliberately reset with `forget --all` (R2-13). readOnly handles
 *   never pin anything (R2-12).
 * - Optimistic concurrency with absent-sentinel and tombstones:
 *   - expectedVersion === 0 means "the row was ABSENT when this handle last
 *     looked" — writing then requires the row to still be absent (R2-1).
 *   - every delete (forget / TTL sweep / LRU eviction) records the row's
 *     version in session_tombstones; re-creation CONTINUES the numbering, so
 *     a stale writer's remembered version can never match a re-created row
 *     (no ABA resurrection, R2-2).
 * - Bounded retention: a single snapshot larger than maxEntries is refused
 *   outright (R2-10); beyond that, maxSessions / maxEntries evict
 *   least-recently-used sessions inside the write transaction.
 * - Erasure honesty: `PRAGMA secure_delete = ON` zeroes deleted pages,
 *   forgetAll additionally VACUUMs and truncates the WAL. Logical +
 *   best-effort in-file erasure — physical media residue is out of scope.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type * as NodeSqlite from "node:sqlite";

/** 32-byte AES-256 key material. Never persisted by this module. */
export type MappingKey = Buffer;

/** Supplies the encryption key. Implementations: in-memory (tests), keychain (B2). */
export interface MappingKeyProvider {
  /** Runtime provenance only; never key material. Omitted by custom providers. */
  readonly source?: "os-keychain" | "keyfile";
  /** Returns the 32-byte key, creating it on first use when supported. */
  getOrCreateKey(): MappingKey;
}

/** In-memory key provider for tests and throwaway stores. */
export class InMemoryMappingKeyProvider implements MappingKeyProvider {
  private key: MappingKey;
  constructor(seed?: Buffer) {
    this.key = seed !== undefined && seed.length === 32 ? Buffer.from(seed) : randomBytes(32);
  }
  getOrCreateKey(): MappingKey {
    return this.key;
  }
}

export interface MappingEntry {
  token: string;
  original: string;
}

export interface SeededSession {
  sessionId: string;
  epoch: string;
  entries: MappingEntry[];
}

/** What loadSession returns: the seed plus the row's optimistic-concurrency
 * version, captured at read time so a stale handle cannot overwrite a newer
 * snapshot written by another process in between (R1 F3.2). */
export interface LoadedSession extends SeededSession {
  version: number;
}

export interface OpenMappingStoreOptions {
  /** Absolute or relative DB file path. Parent directories are created 0700. */
  path: string;
  keyProvider: MappingKeyProvider;
  /**
   * TTL in whole days; 0 disables expiry (manual forget only). Sessions whose
   * `expires_at` passed are dropped by the sweep on open (writer handles
   * only). Default 7 (decision §8, owner 2026-10-07).
   */
  ttlDays?: number;
  /** Max persisted sessions before LRU eviction (default 256, owner R-round). */
  maxSessions?: number;
  /** Max total persisted mapping rows before LRU eviction (default 50,000).
   * A single snapshot larger than this is refused (R2-10). */
  maxEntries?: number;
  /**
   * Probe/erase handle for doctor and `forget`: never initializes or pins —
   * no DDL, no meta bootstrap or key pinning, no TTL sweep, no last_used
   * touches — and putSession refuses. Counting and deleting never decrypt,
   * so a throwaway key suffices. forgetSession/forgetAll still perform the
   * explicit erasure writes (tombstone + delete + epoch bump + key-pin
   * clear). An uninitialized file yields an empty stub (R2-12).
   */
  readOnly?: boolean;
  /** Injection point for deterministic tests. */
  now?: () => number;
}

/** CAS failure: another process holds a newer (or simply different-lineage)
 * snapshot for this session; the stale writer is refused. */
export class MappingStoreConflictError extends Error {
  constructor(sessionId: string) {
    super(`mapping store version conflict for session ${sessionId}: a newer snapshot exists; write skipped`);
    this.name = "MappingStoreConflictError";
  }
}

/** A forget ran under this handle; persisting now would resurrect erased data. */
export class MappingForgottenError extends Error {
  constructor() {
    super("mappings were forgotten while this process was running; persistence disabled for this process");
    this.name = "MappingForgottenError";
  }
}

/** The resolved key does not match the key identity pinned in this store. */
export class MappingKeyMismatchError extends Error {
  constructor() {
    super(
      "resolved key does not match this store's pinned key identity (key source changed?); " +
        "degrading to memory-only — run `sensitive-guard --forget --all` to reset, or restore the original key source",
    );
    this.name = "MappingKeyMismatchError";
  }
}

/** The single snapshot exceeds the store-wide entry cap; refused outright. */
export class MappingSnapshotTooLargeError extends Error {
  constructor(sessionId: string, entries: number, cap: number) {
    super(`session ${sessionId} snapshot (${entries} entries) exceeds the store entry cap (${cap}); write refused`);
    this.name = "MappingSnapshotTooLargeError";
  }
}

/**
 * Stable identity for a key: sha256 prefix. The key is 256-bit random, so
 * publishing this digest inside the (plaintext) meta row leaks nothing about
 * the key material; it exists to detect key-source drift before any write.
 */
export function deriveKeyId(key: MappingKey): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

const SCHEMA_VERSION = "3";
const KNOWN_SCHEMA_VERSIONS = new Set(["1", "2", "3"]);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DAY_MS = 86_400_000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_ENTRIES = 50_000;

export interface MappingStore {
  /** The persisted session, or null when absent. Undecryptable rows are skipped. */
  loadSession(sessionId: string): LoadedSession | null;
  /**
   * Tombstone generation for an ABSENT session (0 = never deleted). The guard
   * pairs this with loadSession's null to build the absent-CAS token
   * (-(generation+1)); an absent writer whose remembered generation no longer
   * matches is refused (R3-F2: no resurrection across a delete boundary).
   */
  absentGeneration(sessionId: string): number;
  /**
   * Atomically persists a session's full mapping set (replace semantics)
   * guarded by compare-and-swap on the version observed at LOAD time.
   * expectedVersion > 0: the remembered row version. expectedVersion <= 0
   * encodes an ABSENT look with its generation: -g-1 (0 ≡ generation 0, a
   * never-deleted look). Returns the
   * stored version. Throws MappingStoreConflictError on any lineage
   * mismatch, MappingForgottenError when a store-wide forget raced this
   * handle, MappingSnapshotTooLargeError when the snapshot itself exceeds
   * maxEntries, Error on I/O.
   */
  putSession(seed: SeededSession, expectedVersion: number): number;
  /** Drops one session (idempotent, tombstoning its version). Returns true
   * when a row was removed. */
  forgetSession(sessionId: string): boolean;
  /**
   * Drops every session AND clears the pinned key identity (deliberate reset
   * path — the next writer open re-pins). secure_delete zeroes freed pages,
   * then VACUUM + WAL truncate. Returns the number of sessions removed.
   */
  forgetAll(): number;
  /** Persisted session count. */
  sessionCount(): number;
  close(): void;
}

// ─── R-round: lazy driver load (zero-diff for persistence-off users) ───────
// A static `import { DatabaseSync } from "node:sqlite"` would crash module
// load on runtimes without the driver (Node < 22.5, or 22.x without the
// experimental flag) — even for users who never enabled persistence. Loading
// via createRequire keeps the public API synchronous and confines the failure
// to openMappingStore, which callers already translate into memory-only
// degradation.
const nodeRequire = createRequire(import.meta.url);
let sqliteModule: typeof NodeSqlite | null = null;

function loadSqlite(): typeof NodeSqlite {
  if (sqliteModule === null) {
    try {
      sqliteModule = nodeRequire("node:sqlite") as typeof NodeSqlite;
    } catch (error) {
      throw new Error(
        `node:sqlite is unavailable on this runtime (${(error as Error).message}); ` +
          "persistence requires Node 22.5+ (24+ recommended) or Bun — degrading to memory-only",
      );
    }
  }
  return sqliteModule;
}

function encryptOriginal(key: MappingKey, sessionId: string, token: string, original: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${sessionId}\u0000${token}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(original, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decryptOriginal(
  key: MappingKey,
  sessionId: string,
  token: string,
  blob: Buffer,
): string | null {
  try {
    if (blob.length <= NONCE_BYTES + TAG_BYTES) return null;
    const nonce = blob.subarray(0, NONCE_BYTES);
    const tag = blob.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(`${sessionId}\u0000${token}`, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong key, tampered AAD, or corrupted row: treat as absent
  }
}

/** readOnly handle for an uninitialized file: counts zero, writes refuse. */
function stubStore(): MappingStore {
  return {
    loadSession: () => null,
    absentGeneration: () => 0,
    putSession: () => {
      throw new Error("read-only mapping store handle cannot persist");
    },
    forgetSession: () => false,
    forgetAll: () => 0,
    sessionCount: () => 0,
    close: () => undefined,
  };
}

/**
 * Opens (creating when needed) the encrypted mapping store. Throws only on
 * unreadable/uncreatable files or key-identity mismatch — callers translate
 * that into a memory-only degradation, never a conversation failure
 * (decision §4.6).
 */
export function openMappingStore(options: OpenMappingStoreOptions): MappingStore {
  const ttlDays = options.ttlDays ?? 7;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const key = options.keyProvider.getOrCreateKey();
  if (key.length !== 32) throw new Error("mapping key must be 32 bytes");

  mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(options.path);
  // R3-F1/F3: connection-local pragmas on EVERY handle — secure_delete
  // zeroes freed pages for any deleting handle (writer or erase), busy_timeout
  // bounds lock waits instead of instant SQLITE_BUSY. journal_mode is a FILE
  // property: only writers may set it (a probe must never write the header).
  let epochAtOpen = 0;
  try {
    // Inside the close-on-failure boundary: a corrupt/non-SQLite file or a
    // filesystem error here must not leak the handle (fd/lock) either.
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA secure_delete = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!options.readOnly) db.exec("PRAGMA journal_mode = WAL");
    const metaTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get() as { name: string } | undefined;
    const initialized = metaTable !== undefined;

    if (options.readOnly) {
      // R2-12: an observation handle NEVER initializes, upgrades, pins, or
      // sweeps. An uninitialized file (or one missing its schema marker)
      // yields an empty stub rather than a side-effecting bootstrap.
      if (!initialized) {
        db.close();
        return stubStore();
      }
      const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
      if (versionRow === undefined) {
        db.close();
        return stubStore();
      }
      if (versionRow.value !== SCHEMA_VERSION) {
        throw new Error(
          `mapping store schema version ${versionRow.value} needs a writer open to upgrade to ${SCHEMA_VERSION} (run the plugin once)`,
        );
      }
      const epochRow = db.prepare("SELECT value FROM meta WHERE key = 'forget_epoch'").get() as
        | { value: string }
        | undefined;
      epochAtOpen = epochRow !== undefined ? Number.parseInt(epochRow.value, 10) : 0;
    } else {
      // Writer initialization: ONE immediate transaction so two first-openers
      // serialize; meta inserts never replace (R2-3), upgrades from v1/v2
      // complete inside the same transaction (R2-11).
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions (
            session_id TEXT PRIMARY KEY,
            epoch TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
          );
          CREATE TABLE IF NOT EXISTS session_tombstones (
            session_id TEXT PRIMARY KEY,
            last_version INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS mappings (
            session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            token TEXT NOT NULL,
            enc_value BLOB NOT NULL,
            PRIMARY KEY (session_id, token)
          ) WITHOUT ROWID;
        `);
        try {
          db.exec("ALTER TABLE sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
        } catch {
          // column already present (fresh create or v2+ store)
        }
        const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
          | { value: string }
          | undefined;
        if (versionRow !== undefined && !KNOWN_SCHEMA_VERSIONS.has(versionRow.value)) {
          throw new Error(`unsupported mapping store schema version ${versionRow.value}`);
        }
        const seedMeta = db.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        );
        seedMeta.run("schema_version", SCHEMA_VERSION);
        seedMeta.run("forget_epoch", "0");
        seedMeta.run("version_counter", "0");
        // Key pinning: first writer wins; later openers must match. For v1/v2
        // stores (never released; no pinned identity) the first opener is
        // trusted — EXCEPT when the store already holds mapping rows: a wrong
        // key would silently upgrade into an empty-reading store and then pin
        // itself against the RIGHT key (R3-F8). Verify AEAD before pinning.
        if (pinnedIsNull(db) && mappingRowCount(db) > 0) {
          const row = db
            .prepare("SELECT session_id, token, enc_value FROM mappings LIMIT 1")
            .get() as { session_id: string; token: string; enc_value: Uint8Array | Buffer };
          if (decryptOriginal(key, row.session_id, row.token, Buffer.from(row.enc_value)) === null) {
            throw new Error(
              "legacy mapping store exists but is not decryptable under this key (wrong key or corrupt); degrading to memory-only",
            );
          }
        }
        seedMeta.run("key_id", deriveKeyId(key));
        if (versionRow !== undefined && versionRow.value !== SCHEMA_VERSION) {
          db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(SCHEMA_VERSION);
        }
        const pinned = db.prepare("SELECT value FROM meta WHERE key = 'key_id'").get() as
          | { value: string }
          | undefined;
        const pinnedId = pinned !== undefined ? pinned.value : deriveKeyId(key);
        if (pinnedId !== deriveKeyId(key)) {
          throw new MappingKeyMismatchError();
        }
        const epochRow = db.prepare("SELECT value FROM meta WHERE key = 'forget_epoch'").get() as
          | { value: string }
          | undefined;
        epochAtOpen = epochRow !== undefined ? Number.parseInt(epochRow.value, 10) : 0;
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      // Lazy TTL sweep (writer handles only; tombstones continue versions).
      if (ttlDays > 0) {
        db.exec("BEGIN");
        try {
          tombstoneAndDelete(db, "expires_at <= ?", [`${now()}`]);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
    }
  } catch (error) {
    // R1/R2: any init failure must not leak the handle.
    db.close();
    throw error;
  }

  // ─── Prepared statements — same close-on-failure boundary as init (R3-F4)
  try {
  const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM sessions");
  const stmtEntryCount = db.prepare("SELECT COUNT(*) AS n FROM mappings");
  const stmtGet = db.prepare("SELECT epoch, version FROM sessions WHERE session_id = ?");
  const stmtTouch = db.prepare("UPDATE sessions SET last_used_at = ? WHERE session_id = ?");
  const stmtEntries = db.prepare(
    "SELECT token, enc_value FROM mappings WHERE session_id = ? ORDER BY token",
  );
  const stmtInsertSession = db.prepare(
    "INSERT INTO sessions (session_id, epoch, created_at, last_used_at, expires_at, version) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const stmtUpdateSession = db.prepare(
    "UPDATE sessions SET epoch = ?, last_used_at = ?, expires_at = ?, version = ? " +
      "WHERE session_id = ? AND version = ?",
  );
  const stmtBumpVersionCounter = db.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'version_counter'",
  );
  const stmtReadVersionCounter = db.prepare("SELECT value FROM meta WHERE key = 'version_counter'");
  const stmtAbsentGeneration = db.prepare(
    "SELECT last_version FROM session_tombstones WHERE session_id = ?",
  );
  const stmtTombstoneCount = db.prepare("SELECT COUNT(*) AS n FROM session_tombstones");
  const stmtPruneTombstones = db.prepare(
    "DELETE FROM session_tombstones WHERE session_id IN " +
      "(SELECT session_id FROM (SELECT session_id FROM session_tombstones ORDER BY last_version ASC LIMIT ?))",
  );
  const stmtClearMappings = db.prepare("DELETE FROM mappings WHERE session_id = ?");
  const stmtPutMapping = db.prepare(
    "INSERT INTO mappings (session_id, token, enc_value) VALUES (?, ?, ?)",
  );
  const stmtDropAll = db.prepare("DELETE FROM sessions");
  const stmtBumpEpoch = db.prepare(
    "UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'forget_epoch'",
  );
  const stmtClearKeyId = db.prepare("DELETE FROM meta WHERE key = 'key_id'");
  const stmtReadEpoch = db.prepare("SELECT value FROM meta WHERE key = 'forget_epoch'");
  // Eviction victims: oldest first, never the session being written. The
  // tombstone insert must select the SAME victim set (deterministic ORDER BY
  // with session_id tiebreak) inside the same transaction. Every
  // upsert-select carries `WHERE true` so SQLite's ON CONFLICT parses as an
  // upsert clause, not a join constraint.
  const EVICT_ORDER = "ORDER BY last_used_at ASC, session_id ASC";
  const stmtEvictOverflow = db.prepare(
    `DELETE FROM sessions WHERE session_id IN (` +
      `SELECT session_id FROM (SELECT session_id FROM sessions WHERE session_id != ? ${EVICT_ORDER} LIMIT ?))`,
  );
  const stmtEvictOldest = db.prepare(
    `DELETE FROM sessions WHERE session_id = (` +
      `SELECT session_id FROM (SELECT session_id FROM sessions WHERE session_id != ? ${EVICT_ORDER} LIMIT 1))`,
  );
  const stmtTombstoneOverflow = db.prepare(
    `INSERT INTO session_tombstones (session_id, last_version) ` +
      `SELECT session_id, version FROM (SELECT session_id, version FROM sessions WHERE session_id != ? ${EVICT_ORDER} LIMIT ?) ` +
      `WHERE true ` +
      `ON CONFLICT (session_id) DO UPDATE SET last_version = MAX(last_version, excluded.last_version)`,
  );
  const stmtTombstoneOldest = db.prepare(
    `INSERT INTO session_tombstones (session_id, last_version) ` +
      `SELECT session_id, version FROM (SELECT session_id, version FROM sessions WHERE session_id != ? ${EVICT_ORDER} LIMIT 1) ` +
      `WHERE true ` +
      `ON CONFLICT (session_id) DO UPDATE SET last_version = MAX(last_version, excluded.last_version)`,
  );

  /** Read the live forget epoch (inside the caller's transaction). */
  const liveEpoch = (): number => {
    const row = stmtReadEpoch.get() as { value: string } | undefined;
    return row !== undefined ? Number.parseInt(row.value, 10) : 0;
  };

  /**
   * R3-F6: versions come from a GLOBAL monotonic counter — never reused, so a
   * re-created session can never collide with a pre-delete version (belt to
   * the tombstone suspenders), and pruning tombstones stays safe: a pruned
   * lineage re-starts at a fresh, globally-unique version anyway.
   */
  const nextVersion = (): number => {
    stmtBumpVersionCounter.run();
    const row = stmtReadVersionCounter.get() as { value: string } | undefined;
    return row !== undefined ? Number.parseInt(row.value, 10) : 1;
  };

  /** Tombstone retention ceiling (R3-F6): bounded, generously above the
   * session cap so live-ish lineages are never pruned in practice. */
  const tombstoneCeiling = (): number => Math.max(1000, maxSessions * 2);

  return {
    loadSession(sessionId: string): LoadedSession | null {
      const session = stmtGet.get(sessionId) as { epoch: string; version: number } | undefined;
      if (session === undefined) return null;
      // Hydration counts as use (writer handles only — readOnly never writes).
      if (!options.readOnly) stmtTouch.run(now(), sessionId);
      const entries: MappingEntry[] = [];
      for (const row of stmtEntries.iterate(sessionId) as IterableIterator<{
        token: string;
        enc_value: Uint8Array | Buffer;
      }>) {
        const original = decryptOriginal(key, sessionId, row.token, Buffer.from(row.enc_value));
        if (original === null) continue; // decision §4.6: skip, never throw
        entries.push({ token: row.token, original });
      }
      return { sessionId, epoch: session.epoch, entries, version: session.version };
    },
    absentGeneration(sessionId: string): number {
      const tomb = stmtAbsentGeneration.get(sessionId) as { last_version: number } | undefined;
      return tomb !== undefined ? tomb.last_version : 0;
    },
    putSession(seed: SeededSession, expectedVersion: number): number {
      if (options.readOnly) throw new Error("read-only mapping store handle cannot persist");
      // R2-10: the snapshot itself must fit the cap — evicting others can
      // never satisfy a cap the current session alone exceeds.
      if (seed.entries.length > maxEntries) {
        throw new MappingSnapshotTooLargeError(seed.sessionId, seed.entries.length, maxEntries);
      }
      const expiresAt = ttlDays > 0 ? now() + ttlDays * DAY_MS : Number.MAX_SAFE_INTEGER;
      db.exec("BEGIN");
      try {
        // Forget tombstone: if anything was erased through another handle
        // since this one opened, refuse to write (no resurrection).
        if (liveEpoch() !== epochAtOpen) throw new MappingForgottenError();
        const existing = stmtGet.get(seed.sessionId) as { version: number } | undefined;
        let storedVersion: number;
        if (existing !== undefined) {
          // R2-1: a writer holding a remembered version must CAS against it
          // exactly; an absent-token (<= 0) can never blind-write a live row.
          if (expectedVersion <= 0 || existing.version !== expectedVersion) {
            throw new MappingStoreConflictError(seed.sessionId);
          }
          storedVersion = nextVersion();
          const updated = stmtUpdateSession.run(
            seed.epoch,
            now(),
            expiresAt,
            storedVersion,
            seed.sessionId,
            expectedVersion,
          );
          if (updated.changes === 0) throw new MappingStoreConflictError(seed.sessionId);
        } else if (expectedVersion > 0) {
          // The row vanished since this handle observed it (external
          // forgetSession / TTL sweep / LRU eviction): refuse rather than
          // resurrect or ABA-match a re-created row (re-created rows take a
          // fresh globally-unique version, so a remembered version can never
          // match anyway; this branch is the absent-row guard).
          throw new MappingStoreConflictError(seed.sessionId);
        } else {
          // R3-F2: absent-writer CAS. The token encodes the tombstone
          // generation the writer saw (0 ≡ never-deleted). An unchanged
          // generation is required to insert — a delete that happened since
          // (create→forget, sweep, eviction) must not be resurrected over.
          const rememberedGeneration = expectedVersion < 0 ? -expectedVersion - 1 : 0;
          const tombRow = stmtAbsentGeneration.get(seed.sessionId) as { last_version: number } | undefined;
          const currentGeneration = tombRow !== undefined ? tombRow.last_version : 0;
          if (rememberedGeneration !== currentGeneration) {
            throw new MappingStoreConflictError(seed.sessionId);
          }
          storedVersion = nextVersion();
          stmtInsertSession.run(seed.sessionId, seed.epoch, now(), now(), expiresAt, storedVersion);
        }
        stmtClearMappings.run(seed.sessionId);
        for (const entry of seed.entries) {
          stmtPutMapping.run(
            seed.sessionId,
            entry.token,
            encryptOriginal(key, seed.sessionId, entry.token, entry.original),
          );
        }
        // R-round bounded retention (§4.5): evict LRU sessions beyond the
        // session cap, then beyond the total-entries cap, inside the txn —
        // tombstoning every eviction so its version lineage survives.
        const overflow = (stmtCount.get() as { n: number }).n - maxSessions;
        if (overflow > 0) {
          stmtTombstoneOverflow.run(seed.sessionId, overflow);
          stmtEvictOverflow.run(seed.sessionId, overflow);
        }
        let total = (stmtEntryCount.get() as { n: number }).n;
        while (total > maxEntries) {
          const before = (stmtCount.get() as { n: number }).n;
          stmtTombstoneOldest.run(seed.sessionId);
          stmtEvictOldest.run(seed.sessionId);
          if ((stmtCount.get() as { n: number }).n === before) break; // only us left
          total = (stmtEntryCount.get() as { n: number }).n;
        }
        // R3-F6: tombstones are bounded — prune the oldest lineages past the
        // ceiling. A pruned id re-starts at a fresh global version, so this
        // cannot reopen a version collision, only (theoretically) an
        // absent-generation look ≥ ceiling sessions later — bounded residual.
        const tombstoneExcess = (stmtTombstoneCount.get() as { n: number }).n - tombstoneCeiling();
        if (tombstoneExcess > 0) stmtPruneTombstones.run(tombstoneExcess);
        db.exec("COMMIT");
        return storedVersion;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    forgetSession(sessionId: string): boolean {
      // Targeted forget (erase handles included): tombstone the version
      // lineage (no ABA), delete the row. Per-session forgets are guarded by
      // the absent-row CAS in putSession, so other sessions' write-behind
      // keeps flowing.
      db.exec("BEGIN");
      try {
        const changed = tombstoneAndDelete(db, "session_id = ?", [sessionId]);
        db.exec("COMMIT");
        return changed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    forgetAll(): number {
      let removed = 0;
      db.exec("BEGIN");
      try {
        tombstoneAll(db);
        removed = (stmtCount.get() as { n: number }).n;
        stmtDropAll.run();
        stmtBumpEpoch.run();
        stmtClearKeyId.run(); // R2-13: forget --all resets identity mismatches
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      // Best-effort physical compaction: rebuild the file (collapses the
      // freelist secure_delete already zeroed) and truncate the WAL.
      try {
        db.exec("VACUUM");
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {
        // A concurrent reader can block these; logical erasure already
        // committed — the next open retries the sweep/checkpoint path.
      }
      return removed;
    },
    sessionCount(): number {
      return (stmtCount.get() as { n: number }).n;
    },
    close(): void {
      db.close();
    },
  };
  } catch (error) {
    // R3-F4: a prepare failure (e.g. legacy/foreign schema shape) must not
    // leak the handle.
    db.close();
    throw error;
  }
}

/** Whether the store has no pinned key identity yet (v1/v2-era). */
function pinnedIsNull(db: import("node:sqlite").DatabaseSync): boolean {
  return (
    db.prepare("SELECT value FROM meta WHERE key = 'key_id'").get() as
      | { value: string }
      | undefined
  ) === undefined;
}

/** Total mapping rows — used by the legacy-upgrade AEAD verification. */
function mappingRowCount(db: import("node:sqlite").DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM mappings").get() as { n: number }).n;
}

/** Tombstones then deletes the matching sessions in the caller's transaction. */
function tombstoneAndDelete(
  db: import("node:sqlite").DatabaseSync,
  where: string,
  params: string[],
): boolean {
  db.prepare(
    `INSERT INTO session_tombstones (session_id, last_version) ` +
      `SELECT s.session_id, MAX(COALESCE(t.last_version, 0), s.version) ` +
      `FROM sessions s LEFT JOIN session_tombstones t ON t.session_id = s.session_id ` +
      `WHERE s.${where} ` +
      `GROUP BY s.session_id ` +
      `ON CONFLICT (session_id) DO UPDATE SET last_version = MAX(last_version, excluded.last_version)`,
  ).run(...params);
  return db.prepare(`DELETE FROM sessions WHERE ${where}`).run(...params).changes > 0;
}

/** Tombstones every existing session (caller's transaction). */
function tombstoneAll(db: import("node:sqlite").DatabaseSync): void {
  db.prepare(
    `INSERT INTO session_tombstones (session_id, last_version) ` +
      `SELECT s.session_id, MAX(COALESCE(t.last_version, 0), s.version) ` +
      `FROM sessions s LEFT JOIN session_tombstones t ON t.session_id = s.session_id ` +
      `WHERE true ` +
      `GROUP BY s.session_id ` +
      `ON CONFLICT (session_id) DO UPDATE SET last_version = MAX(last_version, excluded.last_version)`,
  ).run();
}

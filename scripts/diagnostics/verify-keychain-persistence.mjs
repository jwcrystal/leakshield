#!/usr/bin/env node
/**
 * Real OS-keychain custody verification (issue #26, first checkbox).
 *
 * Production code is exercised as-is: the compiled key ladder
 * (`dist/decision/mapping-key.js`) resolves the key, the encrypted mapping
 * store writes a session, a SECOND PROCESS re-resolves the key and decrypts the
 * same row. That is the restart property #26 asks about — not a mock.
 *
 * Safety:
 *  - The database lives in a temp directory; the user's real SGP.db is never
 *    opened or written.
 *  - The keychain item is the production one. The script reads it and NEVER
 *    deletes it. By default it also refuses to CREATE it: an absent item is a
 *    precondition failure (exit 2), because a diagnostic must not mint a
 *    production secret behind the operator's back. `--allow-create` opts in
 *    (equivalent to a real first run) and sets `createdProductionKey`.
 *  - "Did it exist before?" is answered by the key ladder's OWN first read
 *    (a recording probe), not by a second read after the ladder may have
 *    already created the item.
 *  - The restart child resolves the key through a read-only probe, so a child
 *    that finds the item missing fails the check instead of creating one.
 *  - No key material is printed: only source names, key ids and booleans.
 *
 * Usage:
 *   npm run build
 *   node scripts/diagnostics/verify-keychain-persistence.mjs                 # simulated keyfile (self-test)
 *   node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain # real OS keychain, read-only
 *   node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain --allow-create
 *
 * Exit: 0 passed, 1 failed, 2 precondition missing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KeyfileMappingKeyProvider,
  createPlatformKeychainProbe,
  resolveMappingKeyWithProbe,
} from "../../dist/decision/mapping-key.js";
import { deriveKeyId, openMappingStore } from "../../dist/decision/mapping-store.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SELF = fileURLToPath(import.meta.url);
const SESSION_ID = "ses_verify_keychain_0001";
const TOKEN = "verify-token-0001";
const ORIGINAL = "verify@example.test";
const REAL = process.argv.includes("--real-keychain");
const CHILD = process.argv.includes("--child");
const ALLOW_CREATE = process.argv.includes("--allow-create");
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

if (!REAL && !process.argv.includes("--simulated")) {
  console.error(
    "Refusing to touch the OS keychain without --real-keychain.\n" +
      "  Self-test (no keychain): node scripts/diagnostics/verify-keychain-persistence.mjs --simulated\n" +
      "  Real custody check:     node scripts/diagnostics/verify-keychain-persistence.mjs --real-keychain",
  );
  process.exit(2);
}

const warn = (message) => console.error(`warn: ${message}`);
const seed = { sessionId: SESSION_ID, epoch: "verify-epoch", entries: [{ token: TOKEN, original: ORIGINAL }] };

/**
 * Wraps the real probe so the key ladder's own first read is the evidence for
 * "did the item exist before?". Reading after the ladder ran would always say
 * yes, because the ladder creates the item when it is absent. When the item is
 * absent and creation was not opted into, this read refuses instead of letting
 * the ladder write a production key.
 */
function makeRecordingProbe(probe) {
  let existedBefore = null;
  let readFailed = false;
  let refusedAbsence = false;
  const recording = {
    read() {
      let value;
      try {
        value = probe.read();
      } catch (error) {
        readFailed = true;
        throw error;
      }
      if (existedBefore === null) existedBefore = value !== null;
      if (existedBefore === false && !ALLOW_CREATE) {
        refusedAbsence = true;
        const refusal = new Error("keychain item absent");
        refusal.code = "sg_key_absent";
        throw refusal;
      }
      return value;
    },
    write(hexKey) {
      probe.write(hexKey);
    },
  };
  return {
    probe: recording,
    state: {
      get existedBefore() {
        return existedBefore;
      },
      get readFailed() {
        return readFailed;
      },
      get refusedAbsence() {
        return refusedAbsence;
      },
    },
  };
}

/**
 * Read-only wrapper for the restart child. The child must never mint a key: if
 * the item is gone by the time it starts, that is a failed restart check, not
 * permission to write a new production secret.
 */
function makeReadOnlyProbe(probe) {
  return {
    read() {
      return probe.read();
    },
    write() {
      const refusal = new Error("read-only restart check: refusing to create a keychain item");
      refusal.code = "sg_read_only_probe";
      throw refusal;
    },
  };
}

function resolveForMode() {
  if (!REAL) {
    const keyfile = arg("--keyfile") ?? keyfilePath;
    return { provider: new KeyfileMappingKeyProvider(keyfile), probe: null, state: null };
  }
  const probe = createPlatformKeychainProbe();
  if (probe === null) return { provider: null, probe: null, state: null };
  const recording = makeRecordingProbe(probe);
  const provider = resolveMappingKeyWithProbe(recording.probe, {
    keyFile: false,
    warn: (message) => {
      // The ladder reports every refusal as "unavailable"; an absent item is an
      // explicit precondition, reported by the caller with the opt-in hint.
      if (!recording.state.refusedAbsence) warn(message);
    },
  });
  return { provider, probe, state: recording.state };
}

/** Child: a fresh process re-reading the key and decrypting the parent's row. */
if (CHILD) {
  const dbPath = arg("--db");
  const keyfilePath = arg("--keyfile");
  const expectedKeyId = arg("--key-id");
  const resolved = REAL
    ? (() => {
        const probe = createPlatformKeychainProbe();
        return probe === null
          ? null
          : resolveMappingKeyWithProbe(makeReadOnlyProbe(probe), { keyFile: false, warn });
      })()
    : new KeyfileMappingKeyProvider(keyfilePath);
  const result = {
    source: resolved?.source ?? null,
    keyIdMatch: false,
    found: false,
    entriesMatch: false,
    version: 0,
    readOnly: REAL,
  };
  try {
    if (resolved === null) throw new Error("key_unavailable");
    const key = resolved.getOrCreateKey();
    result.keyIdMatch = deriveKeyId(key) === expectedKeyId;
    const store = openMappingStore({ path: dbPath, keyProvider: resolved, ttlDays: 0, readOnly: true });
    try {
      const loaded = store.loadSession(SESSION_ID);
      result.found = loaded !== null;
      result.version = loaded?.version ?? 0;
      result.entriesMatch =
        loaded !== null &&
        loaded.entries.length === 1 &&
        loaded.entries[0].token === TOKEN &&
        loaded.entries[0].original === ORIGINAL;
    } finally {
      store.close();
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : "child_error";
  }
  console.log(JSON.stringify(result));
  process.exit(result.found && result.entriesMatch && result.keyIdMatch ? 0 : 1);
}

const preferred = path.join(os.tmpdir(), "opencode");
const workParent = process.env.E2E_WORK_ROOT || (existsSync(preferred) ? preferred : os.tmpdir());
const root = mkdtempSync(path.join(workParent, "sg-keychain-work-"));
const evidenceDir = mkdtempSync(path.join(workParent, "sg-keychain-evidence-"));
const dbPath = path.join(root, "SGP.db");
const keyfilePath = path.join(root, "sgp.key");
const summary = {
  generatedAt: new Date().toISOString(),
  issue: 26,
  kind: "keychain-custody",
  mode: REAL ? "real-os-keychain" : "simulated-keyfile",
  platform: process.platform,
  keychainItemExistedBefore: null,
  keychainAvailable: null,
  createdProductionKey: false,
  source: null,
  keyId: null,
  written: false,
  restartFound: false,
  restartEntriesMatch: false,
  restartKeyIdMatch: false,
  childSource: null,
  childReadOnly: REAL,
  passed: false,
};

let precondition = null;

try {
  const resolved = resolveForMode();
  if (REAL && resolved.probe === null) {
    summary.keychainAvailable = false;
    summary.error = "unsupported_platform";
    precondition = "unsupported_platform";
    throw new Error("unsupported_platform");
  }
  if (REAL) {
    summary.keychainItemExistedBefore = resolved.state.existedBefore;
    summary.keychainAvailable = resolved.provider !== null && !resolved.state.readFailed;
    if (resolved.state.refusedAbsence) {
      summary.error = "keychain_item_absent";
      precondition = "keychain_item_absent";
      console.error(
        "No keychain item yet. Enable persistence first, or rerun with --allow-create " +
          "to create the production key.",
      );
      throw new Error("keychain_item_absent");
    }
    if (resolved.state.readFailed) {
      summary.error = summary.error ?? "keychain_read_failed";
      precondition = "keychain_read_failed";
      throw new Error("keychain_read_failed");
    }
  }

  const provider = resolved.provider;
  if (provider === null) {
    summary.error = summary.error ?? "key_unavailable";
    throw new Error("key_unavailable");
  }
  summary.source = provider.source ?? "keyfile";
  const key = provider.getOrCreateKey();
  summary.keyId = deriveKeyId(key);
  summary.createdProductionKey = REAL && summary.keychainItemExistedBefore === false;

  const store = openMappingStore({ path: dbPath, keyProvider: provider, ttlDays: 0 });
  try {
    const expectedVersion = -(store.absentGeneration(SESSION_ID) + 1);
    store.putSession(seed, expectedVersion);
    summary.written = store.loadSession(SESSION_ID)?.version !== undefined;
  } finally {
    store.close();
  }

  const childArgs = [SELF, "--child", "--db", dbPath, "--key-id", summary.keyId];
  if (REAL) childArgs.push("--real-keychain");
  else childArgs.push("--simulated", "--keyfile", keyfilePath);
  const child = spawnSync(process.execPath, childArgs, { encoding: "utf8", timeout: 30000 });
  let childResult = {};
  try {
    childResult = JSON.parse(child.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    childResult = { error: "child_output_unparseable" };
  }
  summary.childSource = childResult.source ?? null;
  summary.restartFound = childResult.found === true;
  summary.restartEntriesMatch = childResult.entriesMatch === true;
  summary.restartKeyIdMatch = childResult.keyIdMatch === true;
  if (childResult.error) summary.childError = childResult.error;
  summary.passed =
    summary.written &&
    summary.restartFound &&
    summary.restartEntriesMatch &&
    summary.restartKeyIdMatch &&
    (REAL ? summary.source === "os-keychain" : summary.source === "keyfile");
} catch (error) {
  summary.error = summary.error ?? (error instanceof Error ? error.message : "harness_error");
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    summary.cleanup = "failed";
  }
}

writeFileSync(path.join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Evidence: ${path.join(evidenceDir, "summary.json")}`);
if (precondition !== null) process.exitCode = 2;
else if (!summary.passed) process.exitCode = 1;

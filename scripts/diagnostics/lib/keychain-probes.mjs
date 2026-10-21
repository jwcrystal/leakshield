/**
 * Probe wrappers for the OS-keychain custody check (issue #26).
 *
 * The key ladder creates the keychain item when it is absent, so the wrapper —
 * not a second read after the fact — has to be the place that records "did this
 * run create the key?". Both wrappers are pure pass-throughs except for that
 * bookkeeping, which makes the security boundary testable without a keychain.
 */

/**
 * Records the ladder's FIRST read as `existedBefore`, refuses to let the ladder
 * create anything unless creation was explicitly allowed, and calls `beforeWrite`
 * immediately before the underlying write so a warning lands before the secret
 * exists, not after.
 */
export function makeRecordingProbe(probe, { allowCreate = false, beforeWrite = null } = {}) {
  let existedBefore = null;
  let readFailed = false;
  let refusedAbsence = false;
  let writeAttempted = false;
  let writeSucceeded = false;
  let writeError = null;
  let writtenHex = null;

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
      if (existedBefore === false && !allowCreate) {
        refusedAbsence = true;
        const refusal = new Error("keychain item absent");
        refusal.code = "sg_key_absent";
        throw refusal;
      }
      return value;
    },
    write(hexKey) {
      writeAttempted = true;
      writtenHex = hexKey;
      if (typeof beforeWrite === "function") beforeWrite();
      try {
        probe.write(hexKey);
        writeSucceeded = true;
      } catch (error) {
        writeError = error instanceof Error ? error.message : String(error);
        throw error;
      }
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
      get writeAttempted() {
        return writeAttempted;
      },
      get writeSucceeded() {
        return writeSucceeded;
      },
      get writeError() {
        return writeError;
      },
      /** The hex this run wrote, or null. Kept in memory; never printed. */
      get writtenHex() {
        return writtenHex;
      },
    },
  };
}

/**
 * Read-only wrapper for the restart child. The child must never mint a key: if
 * the item is gone by the time it starts, that is a failed restart check, not
 * permission to write a new production secret.
 */
export function makeReadOnlyProbe(probe) {
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

/**
 * Tri-state answer to "does the key in the keychain come from this run?".
 *
 * - `true`  — our write succeeded AND the key that is now in the keychain is the
 *             one we wrote (same derived id).
 * - `false` — the item already existed and we never wrote.
 * - `null`  — indeterminate: no write of ours and the item appeared anyway, a
 *             write failed, or we wrote but the ladder adopted a different key
 *             (a concurrent creator won between our write and the read-back).
 *
 * Neither "it was absent, so we made it" nor "our write succeeded, so it is
 * ours" is sound on its own: both leave the race unaccounted for.
 */
export function keyCreationAttribution({
  existedBefore,
  writeAttempted,
  writeSucceeded,
  writtenKeyId = null,
  currentKeyId = null,
}) {
  if (writeAttempted === true) {
    if (writeSucceeded !== true) return null;
    if (writtenKeyId === null || currentKeyId === null) return null;
    return writtenKeyId === currentKeyId ? true : null;
  }
  if (existedBefore === true) return false;
  return null;
}

/**
 * Probe wrappers for the OS-keychain custody check (issue #26).
 *
 * The key ladder creates the keychain item when it is absent, so the wrapper —
 * not a second read after the fact — has to be the place that records "did this
 * run create the key?". Both wrappers are pure pass-throughs except for that
 * bookkeeping, which makes the security boundary testable without a keychain.
 */

/**
 * Records the ladder's FIRST read as `existedBefore`, and refuses to let the
 * ladder create anything unless creation was explicitly allowed.
 */
export function makeRecordingProbe(probe, { allowCreate = false } = {}) {
  let existedBefore = null;
  let readFailed = false;
  let refusedAbsence = false;
  let writeAttempted = false;
  let writeSucceeded = false;
  let writeError = null;

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
 * Tri-state answer to "did this run create the key?".
 *
 * - `true`  — our write was attempted and succeeded.
 * - `false` — the item already existed and we never wrote.
 * - `null`  — indeterminate: the item appeared without a write of ours (another
 *             process created it between the first read and the ladder's write),
 *             or a write was attempted and failed.
 *
 * Inferring this from "it was absent, therefore we made it" is not sound: the
 * gap between the first read and the write is a race.
 */
export function keyCreationAttribution({ existedBefore, writeAttempted, writeSucceeded }) {
  if (writeAttempted === true) return writeSucceeded === true ? true : null;
  if (existedBefore === true) return false;
  if (existedBefore === false) return null;
  return null;
}

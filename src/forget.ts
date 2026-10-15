/**
 * W2 (B5) `forget` — the active erasure lever for persisted mappings
 * (decision `docs/plans/2026-10-07-persistence-decision-db-over-t2.md` §4:
 * TTL is the passive bound, forget is the explicit one; dispose never
 * erases). Output is content-free: counts and paths only, never originals.
 *
 * Deletion does not decrypt anything, so the store is opened with a throwaway
 * in-memory key: the real key stays wherever the ladder put it (keychain /
 * keyfile). The key itself holds no data and is retained — removing it is
 * unnecessary and would only force regeneration.
 */

import { existsSync } from "node:fs";
import { InMemoryMappingKeyProvider, openMappingStore } from "./decision/mapping-store.js";
import { defaultStorePath } from "./decision/mapping-key.js";

export interface ForgetOptions {
  all: boolean;
  session?: string;
  storePath?: string;
}

/** Process exit code. 0 = success/no-op, 1 = store error, 2 = usage error. */
export function runForget(options: ForgetOptions): number {
  if (!options.all && options.session === undefined) {
    console.error("specify --all or --session <session-id>");
    return 2;
  }
  const storePath = options.storePath ?? defaultStorePath();
  if (!existsSync(storePath)) {
    console.log(`no mapping store at ${storePath} — nothing to forget`);
    return 0;
  }
  let store;
  try {
    store = openMappingStore({
      path: storePath,
      keyProvider: new InMemoryMappingKeyProvider(),
      ttlDays: 0, // forget must not side-effect TTL sweeps
      readOnly: true, // deletion never decrypts; no key-identity check needed
    });
  } catch (error) {
    console.error(`mapping store at ${storePath} is unreadable (${(error as Error).message})`);
    console.error("delete the file to reset persistence; conversations are unaffected (memory-only)");
    return 1;
  }
  try {
    if (options.all) {
      const sessions = store.forgetAll();
      console.log(`forgot ${sessions} session(s) from ${storePath}`);
      console.log(
        "old placeholders now degrade per policy: read-only tools see literals, side-effecting calls refuse",
      );
      return 0;
    }
    const removed = store.forgetSession(options.session!);
    console.log(
      removed
        ? `forgot session ${options.session} from ${storePath}`
        : `session ${options.session} not found in ${storePath}`,
    );
    return 0;
  } finally {
    store.close();
  }
}

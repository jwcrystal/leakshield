// Component under test: opt-in persistence configuration for the pi extension
// (src/pi/persistence.ts) and its wiring into the guard core.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.js";
import type { createGuardCore } from "../src/core/session-guard.js";
import { defaultStorePath } from "../src/decision/mapping-key.js";
import { createPiGuard } from "../src/pi/guard.js";
import {
  DEFAULT_PERSIST_TTL_DAYS,
  MAX_PERSIST_TTL_DAYS,
  PI_PERSIST_ENV,
  PI_PERSIST_KEYFILE_ENV,
  PI_PERSIST_KEYFILE_PATH_ENV,
  PI_PERSIST_PATH_ENV,
  PI_PERSIST_TTL_ENV,
  piPersistenceOptions,
} from "../src/pi/persistence.js";

const config = loadConfig(undefined, process.cwd());

describe("pi persistence options", () => {
  it("is off when unset or explicitly disabled", () => {
    expect(piPersistenceOptions({})).toBeUndefined();
    for (const value of ["0", "false", "no", "off", " false "]) {
      expect(piPersistenceOptions({ [PI_PERSIST_ENV]: value })).toBeUndefined();
    }
  });

  it("uses the OpenCode plugin defaults when enabled", () => {
    for (const value of ["1", "true", "yes", "on"]) {
      expect(piPersistenceOptions({ [PI_PERSIST_ENV]: value })).toEqual({
        ttlDays: DEFAULT_PERSIST_TTL_DAYS,
        path: defaultStorePath(),
        keyFile: false,
        keyfilePath: undefined,
      });
    }
  });

  it("reads the ttl, store path, keyfile flag and keyfile path", () => {
    expect(
      piPersistenceOptions({
        [PI_PERSIST_ENV]: "1",
        [PI_PERSIST_TTL_ENV]: "0",
        [PI_PERSIST_PATH_ENV]: "/tmp/store.db",
        [PI_PERSIST_KEYFILE_ENV]: "1",
        [PI_PERSIST_KEYFILE_PATH_ENV]: "/tmp/store.key",
      }),
    ).toEqual({ ttlDays: 0, path: "/tmp/store.db", keyFile: true, keyfilePath: "/tmp/store.key" });
  });

  it("refuses an invalid value instead of silently running without the store", () => {
    expect(() => piPersistenceOptions({ [PI_PERSIST_ENV]: "maybe" })).toThrow(PI_PERSIST_ENV);
    expect(() => piPersistenceOptions({ [PI_PERSIST_ENV]: "1", [PI_PERSIST_TTL_ENV]: "abc" })).toThrow(PI_PERSIST_TTL_ENV);
    expect(() => piPersistenceOptions({ [PI_PERSIST_ENV]: "1", [PI_PERSIST_TTL_ENV]: "-1" })).toThrow(PI_PERSIST_TTL_ENV);
    expect(() => piPersistenceOptions({
      [PI_PERSIST_ENV]: "1",
      [PI_PERSIST_TTL_ENV]: String(MAX_PERSIST_TTL_DAYS + 1),
    })).toThrow(PI_PERSIST_TTL_ENV);
    expect(() => piPersistenceOptions({ [PI_PERSIST_ENV]: "1", [PI_PERSIST_KEYFILE_ENV]: "sometimes" })).toThrow(PI_PERSIST_KEYFILE_ENV);
  });

  it("passes the options to the guard core", () => {
    let received: unknown;
    const spy = ((...args: unknown[]) => {
      received = args[3];
      return null;
    }) as unknown as typeof createGuardCore;
    const persistence = { ttlDays: 2, path: "/tmp/pi.db", keyFile: false };
    createPiGuard({ config, persistence, createCore: spy });
    expect(received).toEqual(persistence);
  });

  it("leaves persistence undefined when the store is not configured", () => {
    let received: unknown = "not called";
    const spy = ((...args: unknown[]) => {
      received = args[3];
      return null;
    }) as unknown as typeof createGuardCore;
    createPiGuard({ config, createCore: spy });
    expect(received).toBeUndefined();
  });
});

/**
 * Opt-in mapping persistence for the pi extension.
 *
 * pi has no plugin-options channel, so the store is configured with
 * environment variables. The defaults match the OpenCode plugin: off unless
 * enabled, a 7-day session TTL, the default store path, and the same key
 * custody ladder (OS keychain -> explicit keyfile -> memory-only).
 *
 * An invalid value refuses to load the extension instead of silently running
 * without the store the user asked for.
 */
import { defaultStorePath } from "../decision/mapping-key.js";
import type { GuardPersistenceOptions } from "../core/session-guard.js";

export const PI_PERSIST_ENV = "LEAKSHIELD_PI_PERSIST";
export const PI_PERSIST_TTL_ENV = "LEAKSHIELD_PI_PERSIST_TTL_DAYS";
export const PI_PERSIST_PATH_ENV = "LEAKSHIELD_PI_PERSIST_PATH";
export const PI_PERSIST_KEYFILE_ENV = "LEAKSHIELD_PI_PERSIST_KEYFILE";
export const PI_PERSIST_KEYFILE_PATH_ENV = "LEAKSHIELD_PI_PERSIST_KEYFILE_PATH";

export const DEFAULT_PERSIST_TTL_DAYS = 7;
export const MAX_PERSIST_TTL_DAYS = 3650;

const TRUE_VALUES: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

function invalid(name: string, expected: string): never {
  throw new Error(`LeakShield: ${name} ${expected}`);
}

function parseFlag(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  return invalid(name, "must be 1/true/yes or 0/false/no");
}

function nonEmpty(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.length > 4096) return invalid(name, "is too long");
  return value;
}

function parseTtl(raw: string | undefined): number {
  const value = nonEmpty(raw, PI_PERSIST_TTL_ENV);
  if (value === undefined) return DEFAULT_PERSIST_TTL_DAYS;
  if (!/^\d+$/.test(value)) return invalid(PI_PERSIST_TTL_ENV, "must be a whole number of days");
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > MAX_PERSIST_TTL_DAYS) {
    return invalid(PI_PERSIST_TTL_ENV, `must be between 0 and ${MAX_PERSIST_TTL_DAYS}`);
  }
  return days;
}

export function piPersistenceOptions(
  env: Readonly<Record<string, string | undefined>>,
): GuardPersistenceOptions | undefined {
  if (parseFlag(env[PI_PERSIST_ENV], PI_PERSIST_ENV) !== true) return undefined;
  return {
    ttlDays: parseTtl(env[PI_PERSIST_TTL_ENV]),
    path: nonEmpty(env[PI_PERSIST_PATH_ENV], PI_PERSIST_PATH_ENV) ?? defaultStorePath(),
    keyFile: parseFlag(env[PI_PERSIST_KEYFILE_ENV], PI_PERSIST_KEYFILE_ENV) === true,
    keyfilePath: nonEmpty(env[PI_PERSIST_KEYFILE_PATH_ENV], PI_PERSIST_KEYFILE_PATH_ENV),
  };
}

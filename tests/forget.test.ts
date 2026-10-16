/**
 * W2 (B5) tests — `forget` (active erasure) and the doctor's persistence
 * check (degradation visibility). All output paths are asserted content-free
 * (counts/paths only).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runForget } from "../src/forget.js";
import {
  InMemoryMappingKeyProvider,
  openMappingStore,
} from "../src/decision/mapping-store.js";
import { persistenceCheck } from "../src/doctor.js";
import { validatePluginOptions } from "../src/plugin-options.js";
import type { DoctorDeps } from "../src/doctor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "sgp-forget-"));
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const EPOCH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/**
 * Seeds a store and returns the path plus the provider that wrote it —
 * R-round key pinning means verification must reopen with the SAME key
 * (a throwaway key can count/erase but not decrypt-and-verify).
 */
function seedStore(name: string, sessions: string[]): { storePath: string; provider: InMemoryMappingKeyProvider } {
  const storePath = join(tempRoot, `${name}.db`);
  const provider = new InMemoryMappingKeyProvider();
  const store = openMappingStore({ path: storePath, keyProvider: provider, ttlDays: 0 });
  sessions.forEach((sessionId, index) => {
    store.putSession({
      sessionId,
      epoch: EPOCH.replace("0", String(index)),
      entries: [{ token: `[SGP2:PII_EMAIL-abcd-efgh-ijk${index}]`, original: "alice@example.com" }],
    }, 0);
  });
  store.close();
  return { storePath, provider };
}

describe("forget (B5)", () => {
  it("erases one session, leaves others, and reports counts only", () => {
    const { storePath, provider } = seedStore("one", ["ses_a", "ses_b"]);
    const exit = runForget({ all: false, session: "ses_a", storePath });
    expect(exit).toBe(0);
    const verify = openMappingStore({ path: storePath, keyProvider: provider, ttlDays: 0 });
    expect(verify.sessionCount()).toBe(1);
    expect(verify.loadSession("ses_a")).toBeNull();
    expect(verify.loadSession("ses_b")).not.toBeNull();
    verify.close();
  });

  it("--all erases every session", () => {
    const { storePath, provider } = seedStore("all", ["ses_a", "ses_b", "ses_c"]);
    expect(runForget({ all: true, storePath })).toBe(0);
    const verify = openMappingStore({ path: storePath, keyProvider: provider, ttlDays: 0 });
    expect(verify.sessionCount()).toBe(0);
    verify.close();
  });

  it("missing store is a no-op success", () => {
    expect(runForget({ all: true, storePath: join(tempRoot, "absent.db") })).toBe(0);
  });

  it("usage error without --all/--session; corrupt store reports exit 1", () => {
    expect(runForget({ all: false, storePath: join(tempRoot, "x.db") })).toBe(2);
    const corrupt = join(tempRoot, "corrupt.db");
    writeFileSync(corrupt, "not sqlite");
    expect(runForget({ all: true, storePath: corrupt })).toBe(1);
  });
});

describe("doctor persistence check (B5)", () => {
  const deps = (overrides: Partial<DoctorDeps> = {}): DoctorDeps => ({
    opencodeVersion: () => "2.0.23",
    readIfExists: () => null,
    existsDir: () => false,
    existsFile: () => false,
    loadGuardConfig: (() => ({})) as DoctorDeps["loadGuardConfig"],
    smokeScan: () => ({ findings: 1 }),
    cwd: tempRoot,
    home: tempRoot,
    ...overrides,
  });

  const optionsWith = (persistence: object) =>
    validatePluginOptions({ mode: "transparent", persistence }, "v2")!;

  it("reports OFF as a skip (default)", () => {
    const check = persistenceCheck(validatePluginOptions({}, "v2")!.options, deps());
    expect(check.state).toBe("skip");
    expect(check.detail).toContain("OFF");
  });

  it("reports a readable store count without claiming runtime persistence is active", () => {
    const { storePath } = seedStore("doctor", ["ses_1", "ses_2"]);
    const check = persistenceCheck(
      optionsWith({ enabled: true, path: storePath }).options,
      deps({ existsFile: (p) => p === storePath }),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("2 persisted session(s)");
    expect(check.detail).toContain(`store=${storePath}`);
    expect(check.detail).toContain("ttl=7d");
    expect(check.detail).toContain("runtime activation and decryptability not verified");
  });

  it("reports configured-but-not-yet-created persistence as unverified", () => {
    const check = persistenceCheck(
      optionsWith({ enabled: true, path: join(tempRoot, "later.db") }).options,
      deps({ existsFile: () => false }),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("not created yet");
  });

  it("reports a corrupt store as warn with the forget fix", () => {
    const corrupt = join(tempRoot, "doctor-corrupt.db");
    writeFileSync(corrupt, "garbage");
    const check = persistenceCheck(
      optionsWith({ enabled: true, path: corrupt }).options,
      deps({ existsFile: (p) => p === corrupt }),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toContain("memory-only");
    expect(check.fix).toContain("--forget --all");
  });

  it("keyfile source appears in the detail when opted in", () => {
    const keyfilePath = join(tempRoot, "doctor.key");
    const check = persistenceCheck(
      optionsWith({ enabled: true, path: join(tempRoot, "kf.db"), keyFile: true, keyfilePath }).options,
      deps({ existsFile: () => false }),
    );
    expect(check.state).toBe("warn");
    expect(check.detail).toContain(`keyfile fallback allowed (${keyfilePath})`);
  });
});

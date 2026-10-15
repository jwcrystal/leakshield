/**
 * W2 (B2) mapping-key tests — keyfile provider, resolution ladder, and the
 * documented degrade path (never fail-closed). Real keychains are NOT
 * touched: platform probes are faked; the keyfile provider uses a temp dir.
 */

import { chmodSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  interpretSecretToolLookup,
  KeyfileMappingKeyProvider,
  resolveMappingKeyWithProbe,
  type KeyStoreProbe,
} from "../src/decision/mapping-key.js";

const tempRoot = mkdtempSync(join(tmpdir(), "sgp-key-"));
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function fakeProbe(state: { hex: string | null; fail?: "read" | "write" }): KeyStoreProbe {
  return {
    read(): string | null {
      if (state.fail === "read") throw new Error("unavailable");
      return state.hex;
    },
    write(hexKey: string): void {
      if (state.fail === "write") throw new Error("denied");
      state.hex = hexKey;
    },
  };
}

const silentWarn = () => undefined;

describe("keyfile provider", () => {
  it("creates a 0600 hex keyfile and reuses the key across instances", () => {
    const path = join(tempRoot, "sgp.key");
    const first = new KeyfileMappingKeyProvider(path);
    const keyHex = first.getOrCreateKey().toString("hex");
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Same key from a fresh instance (restart survival for the KEY itself).
    const second = new KeyfileMappingKeyProvider(path);
    expect(second.getOrCreateKey().toString("hex")).toBe(keyHex);
    expect(readFileSync(path, "utf8").trim()).toBe(keyHex);
  });

  it("refuses a garbage keyfile (ambiguous corrupt vs concurrent write) — R-round", () => {
    const path = join(tempRoot, "garbage.key");
    // Non-hex content must be neither adopted nor silently regenerated: a new
    // key would orphan every persisted mapping behind a keyId mismatch anyway.
    // Refusing degrades loudly; the user deletes the file to reset.
    writeFileSync(path, "not-a-key");
    expect(() => new KeyfileMappingKeyProvider(path)).toThrow();
  });

  it("tightens a world-readable keyfile to 0600 on adoption — R-round", () => {
    const path = join(tempRoot, "loose.key");
    const provider = new KeyfileMappingKeyProvider(path);
    const keyHex = provider.getOrCreateKey().toString("hex");
    chmodSync(path, 0o644);
    const second = new KeyfileMappingKeyProvider(path);
    expect(second.getOrCreateKey().toString("hex")).toBe(keyHex);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("resolution ladder", () => {
  it("uses an existing keychain key without writing", () => {
    const existing = "a".repeat(64);
    const probe = fakeProbe({ hex: existing });
    const provider = resolveMappingKeyWithProbe(probe, { keyFile: false, warn: silentWarn });
    expect(provider).not.toBeNull();
    expect(provider!.getOrCreateKey().toString("hex")).toBe(existing);
  });

  it("creates and stores a fresh key when the keychain item is absent", () => {
    const state = { hex: null as string | null };
    const provider = resolveMappingKeyWithProbe(fakeProbe(state), { keyFile: false, warn: silentWarn });
    expect(provider).not.toBeNull();
    expect(state.hex).toBe(provider!.getOrCreateKey().toString("hex"));
    expect(state.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("steps down to the opt-in keyfile when the keychain is unavailable", () => {
    const warn = vi.fn();
    const keyfilePath = join(tempRoot, "ladder.key");
    const provider = resolveMappingKeyWithProbe(fakeProbe({ hex: null, fail: "read" }), {
      keyFile: true,
      keyfilePath,
      warn,
    });
    expect(provider).not.toBeNull();
    expect(statSync(keyfilePath).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledTimes(1); // one content-free ladder notice
  });

  it("returns null (memory-only degrade) when no key source exists", () => {
    const warn = vi.fn();
    const provider = resolveMappingKeyWithProbe(fakeProbe({ hex: null, fail: "read" }), {
      keyFile: false,
      warn,
    });
    expect(provider).toBeNull();
    // One notice per ladder step-down (keychain, then bottom) — content-free.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("returns null when the probe itself is unsupported and keyfile is off", () => {
    const warn = vi.fn();
    expect(resolveMappingKeyWithProbe(null, { keyFile: false, warn })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("falls to the keyfile even on write-denied keychains", () => {
    const state = { hex: null as string | null, fail: "write" as const };
    const keyfilePath = join(tempRoot, "write-denied.key");
    const provider = resolveMappingKeyWithProbe(fakeProbe(state), {
      keyFile: true,
      keyfilePath,
      warn: silentWarn,
    });
    expect(provider).not.toBeNull();
    // The denied keychain write stored nothing.
    expect(state.hex).toBeNull();
  });
});


describe("R-round: secret-tool exit semantics", () => {
  it("status 1 with empty stdout means absent, not unavailable", () => {
    // The bug this pins: treating lookup's rc=1 as an error made FIRST key
    // creation impossible on Linux (the ladder always stepped down).
    expect(interpretSecretToolLookup({ status: 1, stdout: "" })).toBeNull();
  });

  it("status 0 returns the secret; rc=0 with EMPTY stdout is a present-but-empty item (R3-F5)", () => {
    expect(interpretSecretToolLookup({ status: 0, stdout: "ab" })).toBe("ab");
    expect(() => interpretSecretToolLookup({ status: 0, stdout: "" })).toThrow(/present but empty/);
  });

  it("ENOENT and unexpected statuses throw (unavailable)", () => {
    expect(() =>
      interpretSecretToolLookup({ status: null, stdout: "", error: { code: "ENOENT" } }),
    ).toThrow(/not installed/);
    expect(() => interpretSecretToolLookup({ status: 2, stdout: "" })).toThrow(/lookup failed/);
  });

  it("R2-4: rc=1 with a stderr message is an ERROR, not absence", () => {
    // A misread keychain must never be mistaken for "no key yet" — that path
    // would create (and overwrite) a key over an unreadable store.
    expect(() =>
      interpretSecretToolLookup({ status: 1, stdout: "", stderr: "secret service error" }),
    ).toThrow(/lookup failed/);
    // The silent variant remains absent.
    expect(interpretSecretToolLookup({ status: 1, stdout: "", stderr: "" })).toBeNull();
  });

  it("R2-5: a present-but-malformed keychain item refuses instead of re-keying", () => {
    const warn = vi.fn();
    const provider = resolveMappingKeyWithProbe(fakeProbe({ hex: "definitely-not-hex" }), {
      keyFile: false,
      warn,
    });
    expect(provider).toBeNull(); // ladder bottoms out; nothing overwritten
    expect(warn).toHaveBeenCalledTimes(2); // keychain step-down + bottom notice
  });
});

describe("R-round: first-create race convergence", () => {
  it("adopts whatever the keychain holds after writing (read-back convergence)", () => {
    // A concurrent creator wrote a DIFFERENT key after our write: both
    // processes must converge on the keychain's content, not fork keys.
    const winner = "b".repeat(64);
    const calls: string[] = [];
    const probe: KeyStoreProbe = {
      read() {
        return calls.length === 0 ? null : winner;
      },
      write(hex) {
        calls.push(hex);
      },
    };
    const provider = resolveMappingKeyWithProbe(probe, { keyFile: false, warn: silentWarn });
    expect(provider!.getOrCreateKey().toString("hex")).toBe(winner);
    expect(calls).toHaveLength(1);
  });

  it("adopts the winner even when our own write is denied", () => {
    const winner = "c".repeat(64);
    let reads = 0;
    const probe: KeyStoreProbe = {
      read() {
        reads += 1;
        return reads === 1 ? null : winner;
      },
      write() {
        throw new Error("denied");
      },
    };
    const provider = resolveMappingKeyWithProbe(probe, { keyFile: false, warn: silentWarn });
    expect(provider!.getOrCreateKey().toString("hex")).toBe(winner);
  });

  it("steps down when the write is denied and nothing is stored", () => {
    const warn = vi.fn();
    const provider = resolveMappingKeyWithProbe(
      { read: () => null, write() { throw new Error("denied"); } },
      { keyFile: false, warn },
    );
    expect(provider).toBeNull();
  });
});

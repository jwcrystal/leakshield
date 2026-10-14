/**
 * W2 (B4 + R-round) guard persistence integration — the full acceptance path
 * through the real transparent guard hooks: protect in one guard, dispose
 * (process end), hydrate in a SECOND guard, restore via tool execution.
 *
 * R-round (F6.1): every store-backed test injects a deterministic in-memory
 * key provider, so this suite NEVER touches the developer's real OS keychain
 * and the degradation assertions are unconditional (no soft-skips). The key
 * ladder itself is unit-tested in mapping-key.test.ts with injected probes.
 *
 * R-round guard invariants covered here:
 * - store read failure mid-flight disables persistence for the process and
 *   never blocks the conversation (F4.1),
 * - a rejected seed never overwrites the session's persisted snapshot (F4.2),
 * - an external forget while the guard is running disables write-behind and
 *   never resurrects erased data, while in-memory mappings keep working (F3.2),
 * - a stale second writer is refused by CAS instead of deleting a newer
 *   snapshot (F3.2).
 *
 * Zero-diff is enforced by the untouched main suite: persistence is opt-in
 * and every default-path test runs without a store.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createTransparentSessionGuard,
  type GuardPersistenceOptions,
} from "../src/opencode-transparent.js";
import { InMemoryMappingKeyProvider, openMappingStore } from "../src/decision/mapping-store.js";
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
const TEST_KEY = Buffer.alloc(32, 0x5a);

const tempRoot = mkdtempSync(join(tmpdir(), "sgp-guard-"));
afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

interface Harness {
  guard: ReturnType<typeof createTransparentSessionGuard>;
  hook: (name: string) => (event: unknown) => Promise<unknown>;
}

async function arm(persistence: GuardPersistenceOptions, event?: {
  subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string; data: { sessionID: string } }>;
}): Promise<Harness> {
  const registered = new Map<string, (event: unknown) => unknown>();
  const hookFor = (domain: string) => {
    return async (name: string, callback: unknown) => {
      registered.set(`${domain}:${name}`, callback as (event: unknown) => unknown);
      return { dispose: async () => undefined };
    };
  };
  const ctx = {
    session: { hook: hookFor("session") },
    tool: { hook: hookFor("tool") },
    aisdk: { hook: hookFor("aisdk") },
    ...(event ? { event } : {}),
  };
  const guard = createTransparentSessionGuard(baseConfig, "block", true, persistence);
  await guard.setup(ctx as never);
  return {
    guard,
    hook: (name: string) => {
      const hit = registered.get(name);
      if (hit === undefined) throw new Error(`missing hook ${name}`);
      return async (event: unknown) => hit(event);
    },
  };
}

/** Every store test injects the SAME deterministic key — no OS keychain. */
function persistenceAt(name: string, extra: Partial<GuardPersistenceOptions> = {}): GuardPersistenceOptions {
  return {
    ttlDays: 7,
    path: join(tempRoot, `${name}.db`),
    keyFile: false,
    keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
    ...extra,
  };
}

function contextEvent(sessionID: string, text: string): Record<string, unknown> {
  return {
    sessionID,
    system: [{ type: "text", text: `system ${text}` }],
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: `mail ${text}` }] }],
    options: {},
  };
}

function tokenOf(event: Record<string, unknown>): string {
  const text = (event.system as Array<{ text: string }>)[0].text;
  const token = /\[SGP2:[A-Z][A-Z_]*-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/.exec(text)?.[0];
  expect(token).toBeDefined();
  return token as string;
}

describe("guard persistence (B4)", () => {
  it("reports active persistence and the actual injected key source without logging originals", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((message?: unknown) => logs.push(String(message)));
    try {
      const { guard } = await arm(persistenceAt("status"));
      expect(logs).toContain("[sensitive-guard] persistence: active; key=injected; ttl=7d; cleanup=on-store-open");
      expect(logs.join("\n")).not.toContain(EMAIL);
      await guard.dispose();
    } finally { spy.mockRestore(); }
  });

  it("restores tokens across guard restarts via the encrypted store", async () => {
    const persistence = persistenceAt("restart");
    let token: string | undefined;

    // "Process A": protect, then dispose (no explicit forget).
    {
      const { guard, hook } = await arm(persistence);
      const event = contextEvent("ses_restart", EMAIL);
      await hook("session:context")(event);
      token = tokenOf(event);
      await guard.dispose();
    }

    // "Process B": fresh guard (fresh pseudonymizer), same store and key.
    {
      const { hook } = await arm(persistence);
      // Side-effecting tool with the OLD token: mapping exists, so the real
      // value is restored — the pre-W2 refusal ("placeholder has no
      // mapping in this session") is gone.
      const input = { filePath: `/notes/${token}`, content: "data" };
      await hook("tool:execute.before")({ tool: "write", sessionID: "ses_restart", input });
      expect(input.filePath).toBe(`/notes/${EMAIL}`);
    }
  });

  it("releases deleted-session RAM without erasing persisted mappings or another live session", async () => {
    const persistence = persistenceAt("deleted-memory");
    let emit: ((sessionID: string) => void) | undefined;
    const events = {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        while (!signal.aborted) {
          const sessionID = await new Promise<string>((resolve) => {
            emit = resolve;
            signal.addEventListener("abort", () => resolve(""), { once: true });
          });
          if (!signal.aborted) yield { type: "session.deleted", data: { sessionID } };
        }
      },
    };
    const first = await arm(persistence, events);
    let removed: string;
    let kept: string;
    try {
      const a = contextEvent("removed", EMAIL);
      const b = contextEvent("kept", "other@example.org");
      await first.hook("session:context")(a);
      await first.hook("session:context")(b);
      removed = tokenOf(a);
      kept = tokenOf(b);
      emit!("removed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Persisted rows remain under the explicit TTL/forget policy.
      const store = openMappingStore({ path: persistence.path, keyProvider: persistence.keyProvider!, probeOnly: true });
      try {
        expect(store.sessionCount()).toBe(2);
        expect(store.loadSession("removed")?.entries.some((entry) => entry.token === removed)).toBe(true);
      } finally { store.close(); }
      const input = { content: kept };
      await first.hook("tool:execute.before")({ sessionID: "kept", tool: "write", input });
      expect(input.content).toBe("other@example.org");
    } finally { await first.guard.dispose(); }
    // This deliberately simulates a separate host retaining/restoring history;
    // a deletion event is not an implicit durable forget across all hosts.
    const second = await arm(persistence);
    try {
      const input = { content: removed! };
      await second.hook("tool:execute.before")({ sessionID: "removed", tool: "write", input });
      expect(input.content).toBe(EMAIL);
    } finally { await second.guard.dispose(); }
  });

  it("hydrates a restarted Responses WS lane before restoring its old display/tool tokens", async () => {
    const persistence = persistenceAt("ws-restart");
    const first = await arm(persistence);
    const context = contextEvent("ses_ws", EMAIL);
    await first.hook("session:context")(context);
    const token = tokenOf(context);
    await first.guard.dispose();
    const second = await arm(persistence);
    try {
      const route = { sessionID: "ses_ws", kind: "primary", model: { providerID: "gateway", id: "compatible" } };
      await second.hook("session:experimental.ws.handshake")({ ...route, url: "wss://gateway.example/v1/responses", headers: {} });
      await second.hook("session:experimental.ws.send")({ ...route, frame: JSON.stringify({ type: "response.create", input: token }) });
      await second.hook("session:experimental.ws.receive")({ ...route, frame: JSON.stringify({ type: "response.created", response: { id: "r1" } }) });
      const event = { ...route, frame: JSON.stringify({ type: "response.output_text.delta", delta: token }) };
      await second.hook("session:experimental.ws.receive")(event);
      expect(JSON.parse(event.frame).delta).toBe(EMAIL);
      const input = { content: token };
      await second.hook("tool:execute.before")({ ...route, tool: "write", input });
      expect(input.content).toBe(EMAIL);
    } finally { await second.guard.dispose(); }
  });

  it("keeps memory-only behavior identical when persistence is absent (dispose forgets)", async () => {
    // Same flow without persistence options: the second guard must NOT know
    // the old token (the pre-W2 orphan behavior, per P1 policy).
    const armBare = async () => {
      const registered = new Map<string, (event: unknown) => unknown>();
      const hookFor = (domain: string) => async (name: string, callback: unknown) => {
        registered.set(`${domain}:${name}`, callback as (event: unknown) => unknown);
        return { dispose: async () => undefined };
      };
      const ctx = {
        session: { hook: hookFor("session") },
        tool: { hook: hookFor("tool") },
        aisdk: { hook: hookFor("aisdk") },
      };
      const guard = createTransparentSessionGuard(baseConfig);
      await guard.setup(ctx as never);
      return { registered, guard };
    };
    let token: string | undefined;
    {
      const { registered, guard } = await armBare();
      const event = contextEvent("ses_memory", EMAIL);
      await registered.get("session:context")!(event);
      token = tokenOf(event);
      await guard.dispose();
    }
    {
      const { registered } = await armBare();
      const input = { filePath: `/notes/${token}`, content: "data" };
      await expect(
        (async () =>
          registered.get("tool:execute.before")!({ tool: "write", sessionID: "ses_memory", input }))(),
      ).rejects.toThrow("placeholder has no mapping in this session");
    }
  });

  it("degrades to memory-only on a corrupt store and never blocks the conversation", async () => {
    const path = join(tempRoot, "corrupt.db");
    writeFileSync(path, "definitely not sqlite");
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { hook } = await arm(persistenceAt("corrupt", { path }));
      const event = contextEvent("ses_corrupt", EMAIL);
      await hook("session:context")(event);
      const text = (event.system as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/\[SGP2:PII_EMAIL-/);
      expect(warnings.some((line) => line.includes("memory-only"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("F6.1/R: deterministic ladder-bottom with keyProvider null → exactly one memory-only WARN", async () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { hook } = await arm(persistenceAt("nokey", { keyProvider: null }));
      const event = contextEvent("ses_nokey", EMAIL);
      await hook("session:context")(event);
      expect((event.system as Array<{ text: string }>)[0].text).toMatch(/\[SGP2:PII_EMAIL-/);
      expect(warnings.some((line) => line.includes("no key provider"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("F4.1/R: a store that starts failing mid-flight disables persistence, not the conversation", async () => {
    const persistence = persistenceAt("midflight");
    // A healthy store exists and opens cleanly…
    const seed = openMappingStore({
      path: persistence.path,
      keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
    });
    seed.close();
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { hook } = await arm(persistence);
      // …then the file corrupts AFTER setup (disk failure, crash torn write).
      writeFileSync(persistence.path, "torn write garbage");
      const event = contextEvent("ses_midflight", EMAIL);
      await hook("session:context")(event);
      expect((event.system as Array<{ text: string }>)[0].text).toMatch(/\[SGP2:PII_EMAIL-/);
      expect(warnings.some((line) => line.includes("disabled for this process"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("F4.2/R: a seed-rejected session never overwrites its persisted snapshot", async () => {
    const persistence = persistenceAt("tampered");
    // Pre-seed the store with a TAMPERED category (F1.2 shape): the guard's
    // seed intake must reject it and then refuse to overwrite the row.
    const direct = openMappingStore({
      path: persistence.path,
      keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
    });
    direct.putSession(
      {
        sessionId: "ses_tampered",
        epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
        entries: [{ token: "[SGP2:NOT_A_CATEGORY-abcd-efgh-ijkl]", original: "preexisting@example.com" }],
      },
      0,
    );
    direct.close();
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { hook } = await arm(persistence);
      const event = contextEvent("ses_tampered", EMAIL);
      await hook("session:context")(event);
      expect((event.system as Array<{ text: string }>)[0].text).toMatch(/\[SGP2:PII_EMAIL-/);
      expect(warnings.some((line) => line.includes("seed rejected"))).toBe(true);
      // The tampered row is byte-identical to before: no overwrite happened.
      const verify = openMappingStore({
        path: persistence.path,
        keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
      });
      const row = verify.loadSession("ses_tampered");
      expect(row?.entries).toHaveLength(1);
      expect(row?.entries[0].token).toBe("[SGP2:NOT_A_CATEGORY-abcd-efgh-ijkl]");
      verify.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("F3.2/R: forget while running disables write-behind and never resurrects; memory keeps working", async () => {
    const persistence = persistenceAt("forgetrace");
    let token: string | undefined;
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      const { hook } = await arm(persistence);
      const event = contextEvent("ses_forgetrace", EMAIL);
      await hook("session:context")(event);
      token = tokenOf(event);

      // External `forget --all` while the guard process lives.
      const eraser = openMappingStore({
        path: persistence.path,
        keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
      });
      expect(eraser.forgetAll()).toBe(1);
      eraser.close();

      // More protects in the same session: write-behind hits the forget
      // tombstone, warns, disables persistence — and the conversation plus
      // in-memory mappings keep working.
      const second = contextEvent("ses_forgetrace", "bob@example.com");
      await hook("session:context")(second);
      const input = { filePath: `/notes/${token}`, content: "data" };
      await hook("tool:execute.before")({ tool: "write", sessionID: "ses_forgetrace", input });
      expect(input.filePath).toBe(`/notes/${EMAIL}`);
      expect(warnings.some((line) => line.includes("forgotten while this process was running"))).toBe(true);

      // The store stays empty: nothing was resurrected.
      const verify = openMappingStore({
        path: persistence.path,
        keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
      });
      expect(verify.sessionCount()).toBe(0);
      verify.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("F3.2/R: a stale second writer is refused by CAS, the newer snapshot survives", async () => {
    const persistence = persistenceAt("stalewriter");
    const EPOCH = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
    const oldOriginal = "legacy@example.com";

    // A pre-existing row (v1) with one mapping.
    const direct = openMappingStore({
      path: persistence.path,
      keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
    });
    direct.putSession(
      { sessionId: "ses_stale", epoch: EPOCH, entries: [{ token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: oldOriginal }] },
      0,
    );
    direct.close();

    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((message?: unknown) => {
      warnings.push(String(message));
    });
    try {
      // Guard A touches the session first (seed v1) with clean text: no write.
      const a = await arm(persistence);
      await a.hook("session:context")(contextEvent("ses_stale", "nothing sensitive here"));

      // Guard B seeds the SAME row and persists a newer snapshot (v2).
      const b = await arm(persistence);
      await b.hook("session:context")(contextEvent("ses_stale", EMAIL));

      // Guard A (stale, still at v1) protects something new: CAS must refuse.
      await a.hook("session:context")(contextEvent("ses_stale", "carol@example.com"));
      expect(warnings.some((line) => line.includes("concurrent writer"))).toBe(true);

      const verify = openMappingStore({
        path: persistence.path,
        keyProvider: new InMemoryMappingKeyProvider(TEST_KEY),
      });
      const row = verify.loadSession("ses_stale");
      expect(row?.version).toBe(2);
      // B's snapshot survived: legacy + EMAIL; carol (A's stale addition) never landed.
      expect(row?.entries.map((e) => e.original).sort()).toEqual([EMAIL, oldOriginal].sort());
      verify.close();
    } finally {
      spy.mockRestore();
    }
  });
});

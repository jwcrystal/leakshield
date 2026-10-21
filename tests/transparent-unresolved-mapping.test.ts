/**
 * Unresolved-placeholder diagnostics (issue #35).
 *
 * Three isolated setups are covered here, and they are deliberately kept apart
 * because the runtime cannot tell them apart from the marker alone:
 *
 * 1. a synthetic marker that was never minted (authoring mistake or fixture),
 * 2. a real marker that lost its mapping when the process restarted,
 * 3. a real marker minted in one session and replayed in another.
 *
 * The component under test is the transparent guard's `tool:execute.before`
 * refusal. The guard that protects the authoring session is the developer's
 * installed plugin, not this harness; nothing here writes to the filesystem.
 *
 * Fixture rule: this file never contains a complete placeholder literal. The
 * prefix comes from the exported constant and an unminted marker is derived
 * from a marker minted inside the test. A literal would be restored (or
 * refused) by the very guard the test author runs under, so the authoring
 * workflow and the behaviour under test would contaminate each other.
 *
 * What is asserted is the observable contract at the hook boundary: the hook
 * rejects instead of returning, the tool input it was given is unchanged, the
 * refusal text stays content-free, and the same guard still restores a mapped
 * value afterwards. The host owns the actual tool execution, so host ordering
 * is covered by the E2E runners under `scripts/e2e/`, not here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/opencode-transparent.js";
import { PSEUDONYM_TOKEN_PREFIX_V2 } from "../src/decision/pseudonymization.js";
import type { GuardConfig } from "../src/types.js";

// A configured keyword, not PII: the token type stays NDA_KEYWORD so the
// fixtures exercise the same protection path without synthetic personal data.
const MARKER = "acme-internal-codename";

const config: GuardConfig = {
  nda_keywords: [MARKER],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: false,
  },
};

const TOKEN_SHAPE = new RegExp(
  `${PSEUDONYM_TOKEN_PREFIX_V2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\\]`,
);

const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];

afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.dispose();
});

interface Harness {
  guard: ReturnType<typeof createTransparentSessionGuard>;
  call: (name: string, event: unknown) => Promise<unknown>;
}

async function arm(): Promise<Harness> {
  const hooks = new Map<string, (event: unknown) => unknown>();
  const hookFor = (domain: string) => async (name: string, callback: (event: unknown) => unknown) => {
    hooks.set(`${domain}:${name}`, callback);
    return { dispose: async () => undefined };
  };
  const guard = createTransparentSessionGuard(config);
  guards.push(guard);
  await guard.setup({
    session: { hook: hookFor("session") },
    tool: { hook: hookFor("tool") },
    aisdk: { hook: hookFor("aisdk") },
  } as never);
  const call = async (name: string, event: unknown) => {
    const callback = hooks.get(name);
    if (callback === undefined) throw new Error(`missing hook ${name}`);
    return callback(event);
  };
  return { guard, call };
}

function contextEvent(sessionID: string): Record<string, unknown> {
  return {
    sessionID,
    system: [{ type: "text", text: `system ${MARKER}` }],
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: `note ${MARKER}` }] }],
    options: {},
  };
}

function tokenOf(event: Record<string, unknown>): string {
  const system = (event.system as Array<{ text: string }>)[0].text;
  const token = TOKEN_SHAPE.exec(system)?.[0];
  expect(token).toBeDefined();
  return token as string;
}

/** Same shape as a real marker, different payload, never registered. */
function unmintedFrom(token: string): string {
  const derived = token.replace(
    /[a-z]{4}\]$/,
    (segment) => `${segment[0] === "a" ? "b" : "a"}${segment.slice(1)}`,
  );
  expect(derived).not.toBe(token);
  return derived;
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the tool call to be refused");
}

describe("unresolved placeholder diagnostics", () => {
  it("refuses a write whose marker was never minted and leaves the input untouched", async () => {
    const probe = await arm();
    const probeEvent = contextEvent("ses_probe");
    await probe.call("session:context", probeEvent);
    const unknown = unmintedFrom(tokenOf(probeEvent));
    await probe.guard.dispose();

    const { call } = await arm();
    const input = { path: "notes.txt", content: unknown };

    const error = await refusal(call("tool:execute.before", { sessionID: "ses_a", tool: "write", input }));

    expect(error.message).toContain("no mapping in this session");
    expect(error.message).toContain("The tool did not run");
    expect(error.message).toContain("rebuild the affected arguments from current references");
    expect(error.message).toContain("does not make an old placeholder valid");
    expect(error.message).toContain("ask the user");
    // Content-free: neither the marker nor the configured keyword is echoed.
    expect(error.message).not.toContain(unknown);
    expect(error.message).not.toContain("SGP2:");
    expect(error.message).not.toContain(MARKER);
    expect(input).toEqual({ path: "notes.txt", content: unknown });
  });

  it("refuses an edit whose marker lost its mapping across a restart", async () => {
    const first = await arm();
    const event = contextEvent("ses_restart");
    await first.call("session:context", event);
    const token = tokenOf(event);
    await first.guard.dispose();

    const second = await arm();
    const input = { filePath: `src/${token}.ts`, oldString: "before", newString: "after" };
    const error = await refusal(
      second.call("tool:execute.before", { sessionID: "ses_restart", tool: "edit", input }),
    );

    expect(error.message).toContain("does not make an old placeholder valid");
    // Rereading the source cannot validate the old token, so the text must not
    // promise that a retry will succeed.
    expect(error.message).not.toMatch(/try again/i);
    expect(input).toEqual({ filePath: `src/${token}.ts`, oldString: "before", newString: "after" });
  });

  it("keeps markers scoped to the session that minted them", async () => {
    const { call } = await arm();
    const ownerEvent = contextEvent("ses_owner");
    await call("session:context", ownerEvent);
    const ownerToken = tokenOf(ownerEvent);

    // Both sessions hold a mapping for the same configured value, so each one
    // has a usable marker of its own; this is not a "no mappings at all" case.
    const otherEvent = contextEvent("ses_other");
    await call("session:context", otherEvent);
    const otherToken = tokenOf(otherEvent);
    expect(otherToken).not.toBe(ownerToken);

    const ownerOwned = { path: "notes.txt", content: `value ${ownerToken}` };
    await expect(
      call("tool:execute.before", { sessionID: "ses_owner", tool: "write", input: ownerOwned }),
    ).resolves.toBeUndefined();
    expect(ownerOwned.content).toBe(`value ${MARKER}`);

    const otherOwned = { path: "notes.txt", content: `value ${otherToken}` };
    await expect(
      call("tool:execute.before", { sessionID: "ses_other", tool: "write", input: otherOwned }),
    ).resolves.toBeUndefined();
    expect(otherOwned.content).toBe(`value ${MARKER}`);

    // A marker is never guessed from the other session's mapping for the same
    // value, in either direction.
    const ownerInOther = { path: "notes.txt", content: `value ${ownerToken}` };
    const error = await refusal(
      call("tool:execute.before", { sessionID: "ses_other", tool: "write", input: ownerInOther }),
    );
    expect(error.message).toContain("no mapping in this session");
    expect(ownerInOther.content).toBe(`value ${ownerToken}`);

    const otherInOwner = { path: "notes.txt", content: `value ${otherToken}` };
    await expect(
      call("tool:execute.before", { sessionID: "ses_owner", tool: "write", input: otherInOwner }),
    ).rejects.toThrow("no mapping");
    expect(otherInOwner.content).toBe(`value ${otherToken}`);
  });
});

import { describe, expect, it } from "vitest";

// The issue-#26 runners are plain .mjs harness scripts and are not part of the
// product build (tsconfig includes src/ only), so they are imported dynamically.
const harness = (await import("../scripts/e2e/lib/real-harness.mjs")) as unknown as {
  sessionNotFound: (result: unknown, sessionID: string) => boolean;
  missingPlaceholders: (expected: string[], actual: string[]) => string[];
  newPlaceholders: (known: string[], actual: string[]) => string[];
  turnCoverage: (input: {
    known: string[];
    rows: Array<{ kind?: string; bytes?: number; placeholderHashes?: string[] }>;
    finalTurn?: boolean;
  }) => { covered: boolean; requests: number; missing: number; introduced: number };
};

const SESSION = "ses_verify_0001";
const sessionNotFoundError = (sessionID: unknown) => ({
  status: 1,
  parseFailed: false,
  timedOut: false,
  value: { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${String(sessionID)}` },
});

describe("sessionNotFound", () => {
  it("accepts the host's structured session-not-found error", () => {
    expect(harness.sessionNotFound(sessionNotFoundError(SESSION), SESSION)).toBe(true);
  });

  it("rejects the same error naming a different session", () => {
    expect(harness.sessionNotFound(sessionNotFoundError("ses_other"), SESSION)).toBe(false);
  });

  it("rejects a session id that merely starts with ours", () => {
    expect(harness.sessionNotFound(sessionNotFoundError(`${SESSION}_other`), SESSION)).toBe(false);
  });

  it("rejects a message that names our id but carries no session field", () => {
    expect(
      harness.sessionNotFound(
        { status: 1, parseFailed: false, value: { _tag: "SessionNotFoundError", message: `Session not found: ${SESSION}` } },
        SESSION,
      ),
    ).toBe(false);
  });

  it("rejects a non-string session field", () => {
    expect(harness.sessionNotFound(sessionNotFoundError(42), SESSION)).toBe(false);
  });

  it("rejects a location-not-found error", () => {
    expect(
      harness.sessionNotFound(
        { status: 1, parseFailed: false, value: { _tag: "LocationNotFoundError", sessionID: SESSION } },
        SESSION,
      ),
    ).toBe(false);
  });

  it("rejects a bare 404 without the session-specific tag", () => {
    expect(harness.sessionNotFound({ status: 1, parseFailed: false, value: { statusCode: 404 } }, SESSION)).toBe(false);
  });

  it("rejects an unrelated error that happens to say not found", () => {
    expect(
      harness.sessionNotFound(
        { status: 1, parseFailed: false, value: { error: { message: "Configuration file not found" } } },
        SESSION,
      ),
    ).toBe(false);
  });

  it("rejects a timeout", () => {
    expect(harness.sessionNotFound({ status: null, timedOut: true, parseFailed: false }, SESSION)).toBe(false);
  });

  it("rejects an unparseable reply", () => {
    expect(harness.sessionNotFound({ status: 1, parseFailed: true, value: undefined }, SESSION)).toBe(false);
  });

  it("rejects a session that is still returned", () => {
    expect(harness.sessionNotFound({ status: 0, value: { data: { id: SESSION } } }, SESSION)).toBe(false);
  });

  it("rejects a missing result", () => {
    expect(harness.sessionNotFound(null, SESSION)).toBe(false);
  });

  it("rejects when the expected session id is not known", () => {
    expect(harness.sessionNotFound(sessionNotFoundError(SESSION), "")).toBe(false);
  });
});

describe("missingPlaceholders", () => {
  it("reports a placeholder that earlier history carried and this request lost", () => {
    expect(harness.missingPlaceholders(["a", "b"], ["b", "c"])).toEqual(["a"]);
  });

  it("accepts a request that still carries everything", () => {
    expect(harness.missingPlaceholders(["a", "b"], ["b", "a", "c"])).toEqual([]);
  });

  it("is not fooled by a repeated placeholder standing in for a lost one", () => {
    expect(harness.missingPlaceholders(["a", "b"], ["b", "b", "c"])).toEqual(["a"]);
  });
});

describe("newPlaceholders", () => {
  it("returns only what this request introduced", () => {
    expect(harness.newPlaceholders(["a"], ["a", "b"])).toEqual(["b"]);
  });

  it("returns nothing when the request only replays history", () => {
    expect(harness.newPlaceholders(["a", "b"], ["b", "a"])).toEqual([]);
  });
});

describe("turnCoverage", () => {
  const row = (kind: string, placeholderHashes: string[], bytes = 100) => ({ kind, placeholderHashes, bytes });

  it("accepts a turn whose profile request carries the earlier history", () => {
    const coverage = harness.turnCoverage({ known: ["a"], rows: [row("primary", ["a", "b"], 500)] });
    expect(coverage).toMatchObject({ covered: true, requests: 1, missing: 0, introduced: 1 });
  });

  it("rejects a turn that only introduces a value", () => {
    const coverage = harness.turnCoverage({ known: [], rows: [row("generate", ["a"])] });
    expect(coverage.covered).toBe(true);
    expect(harness.turnCoverage({ known: ["a"], rows: [row("primary", ["b"])] }).covered).toBe(false);
  });

  it("is not fooled by a larger helper request carrying more than the turn request", () => {
    const coverage = harness.turnCoverage({
      known: ["a"],
      rows: [row("title", ["a", "b"], 9000), row("primary", ["b"], 500)],
    });
    expect(coverage).toMatchObject({ covered: false, requests: 1, missing: 1 });
  });

  it("rejects when a retry in the same turn loses earlier history", () => {
    const coverage = harness.turnCoverage({
      known: ["a"],
      rows: [row("primary", ["a", "b"], 900), row("primary", ["b"], 400)],
    });
    expect(coverage).toMatchObject({ covered: false, requests: 2, missing: 1 });
  });

  it("rejects a deficient retry on the replay-only final turn", () => {
    const coverage = harness.turnCoverage({
      known: ["a", "b"],
      rows: [row("primary", ["a", "b"], 900), row("primary", ["b"], 400)],
      finalTurn: true,
    });
    expect(coverage.covered).toBe(false);
  });

  it("rejects a final turn that introduces a new value instead of replaying", () => {
    const coverage = harness.turnCoverage({ known: ["a"], rows: [row("primary", ["a", "c"])], finalTurn: true });
    expect(coverage).toMatchObject({ covered: false, introduced: 1 });
  });

  it("rejects a turn with no turn-carrying request at all", () => {
    expect(harness.turnCoverage({ known: [], rows: [row("title", ["a"])] }).covered).toBe(false);
    expect(harness.turnCoverage({ known: [], rows: [] }).covered).toBe(false);
  });

  it("accepts a final turn that only replays", () => {
    const coverage = harness.turnCoverage({ known: ["a", "b"], rows: [row("primary", ["b", "a"])], finalTurn: true });
    expect(coverage).toMatchObject({ covered: true, introduced: 0 });
  });
});

import { describe, expect, it } from "vitest";

// The issue-#26 runners are plain .mjs harness scripts and are not part of the
// product build (tsconfig includes src/ only), so they are imported dynamically.
const harness = (await import("../scripts/e2e/lib/real-harness.mjs")) as unknown as {
  sessionNotFound: (result: unknown, sessionID: string) => boolean;
  missingPlaceholders: (expected: string[], actual: string[]) => string[];
  newPlaceholders: (known: string[], actual: string[]) => string[];
};

const SESSION = "ses_verify_0001";
const notFound = (sessionID: string) => ({
  status: 1,
  parseFailed: false,
  timedOut: false,
  value: { _tag: "SessionNotFoundError", sessionID, message: `Session not found: ${sessionID}` },
});

describe("sessionNotFound", () => {
  it("accepts the host's structured session-not-found error", () => {
    expect(harness.sessionNotFound(notFound(SESSION), SESSION)).toBe(true);
  });

  it("rejects the same error naming a different session", () => {
    expect(harness.sessionNotFound(notFound("ses_other"), SESSION)).toBe(false);
  });

  it("rejects a location-not-found error", () => {
    expect(
      harness.sessionNotFound(
        { status: 1, parseFailed: false, value: { _tag: "LocationNotFoundError", message: "Location not found: /x" } },
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
    expect(harness.sessionNotFound(notFound(SESSION), "")).toBe(false);
  });

  it("falls back to the message when the body carries no session field", () => {
    const withoutField = {
      status: 1,
      parseFailed: false,
      value: { _tag: "SessionNotFoundError", message: `Session not found: ${SESSION}` },
    };
    expect(harness.sessionNotFound(withoutField, SESSION)).toBe(true);
    expect(harness.sessionNotFound({ ...withoutField, value: { _tag: "SessionNotFoundError", message: "Session not found: ses_other" } }, SESSION)).toBe(false);
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
    // Turn 2 introduced b; the request replays only b (twice, e.g. user + echoed
    // assistant) plus the new c. a is gone, so the turn must not count as replay.
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

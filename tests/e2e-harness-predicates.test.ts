import { describe, expect, it } from "vitest";

// The issue-#26 runners are plain .mjs harness scripts and are not part of the
// product build (tsconfig includes src/ only), so they are imported dynamically.
const harness = (await import("../scripts/e2e/lib/real-harness.mjs")) as unknown as {
  sessionNotFound: (result: unknown) => boolean;
  expectedCanariesFor: (turn: number, turns: number) => number;
};

describe("sessionNotFound", () => {
  it("accepts a 404 status", () => {
    expect(harness.sessionNotFound({ status: 404, value: undefined, parseFailed: false, timedOut: false })).toBe(true);
  });

  it("accepts a 404 carried in the parsed body", () => {
    expect(
      harness.sessionNotFound({ status: 0, value: { error: { statusCode: 404 } }, parseFailed: false, timedOut: false }),
    ).toBe(true);
  });

  it("accepts an explicit not-found message", () => {
    expect(
      harness.sessionNotFound({ status: 0, value: { error: { message: "Session not found" } }, parseFailed: false }),
    ).toBe(true);
  });

  it("rejects a timeout even though nothing came back", () => {
    expect(harness.sessionNotFound({ status: null, value: undefined, timedOut: true, parseFailed: false })).toBe(false);
  });

  it("rejects an unparseable reply", () => {
    expect(harness.sessionNotFound({ status: 0, value: undefined, parseFailed: true })).toBe(false);
  });

  it("rejects a server error", () => {
    expect(harness.sessionNotFound({ status: 1, value: { error: { message: "internal error" } } })).toBe(false);
  });

  it("rejects a session that is still returned", () => {
    expect(harness.sessionNotFound({ status: 0, value: { data: { id: "ses_still_here" } }, timedOut: false })).toBe(
      false,
    );
  });

  it("rejects a missing result", () => {
    expect(harness.sessionNotFound(null)).toBe(false);
  });
});

describe("expectedCanariesFor", () => {
  it("expects the single canary on a one-turn run", () => {
    expect(harness.expectedCanariesFor(0, 1)).toBe(1);
  });

  it("grows by one per turn and holds on the replay-only final turn", () => {
    const turns = 4;
    const expected = Array.from({ length: turns }, (_, turn) => harness.expectedCanariesFor(turn, turns));
    expect(expected).toEqual([1, 2, 3, 3]);
  });

  it("holds at turns-1 for the last two turns of a long run", () => {
    expect(harness.expectedCanariesFor(18, 20)).toBe(19);
    expect(harness.expectedCanariesFor(19, 20)).toBe(19);
  });

  it("never decreases", () => {
    const turns = 20;
    const values = Array.from({ length: turns }, (_, turn) => harness.expectedCanariesFor(turn, turns));
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]);
    }
  });
});

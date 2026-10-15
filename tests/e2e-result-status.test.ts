import { describe, expect, it } from "vitest";
import { resultExitCode } from "../scripts/e2e/result-status.mjs";

describe("E2E result exit status", () => {
  it.each([
    [[{ verdict: "pass" }], 0],
    [[{ verdict: "fail" }], 1],
    [[{ verdict: "error" }], 1],
    [[{ verdict: "pass" }, { verdict: "error" }], 1],
    [[{ verdict: "pass" }, { verdict: "fail" }], 1],
  ])("maps %j to exit %i", (results, expected) => {
    expect(resultExitCode(results)).toBe(expected);
  });
});

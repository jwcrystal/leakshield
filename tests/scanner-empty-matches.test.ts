import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));

describe("scanner progress after empty regex matches", () => {
  // A synchronous regex loop blocks Vitest's own timeout. Exercise the real
  // scanner in a child process so a regression is killed instead of hanging CI.
  it.each(["scanText", "redactText"])("%s terminates and preserves nonempty matches", (operation) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { GuardConfigSchema } from "./src/config/loader.ts";
      import { scanText, redactText } from "./src/scanner/engine.ts";
      import { allowlistSuppressions, resetAllowlistSuppressionsForTests } from "./src/scanner/allowlist.ts";

      const operation = ${JSON.stringify(operation)};
      function check(pattern, flags, text, expected, expectedRedacted = text, allow = undefined) {
        const config = GuardConfigSchema.parse({
          nda_keywords: [],
          custom_rules: [{ description: "synthetic-empty-match", pattern, flags, allow }],
        });
        const result = operation === "scanText" ? scanText(text, config) : redactText(text, config);
        const actual = result.findings.filter(f => f.description === "synthetic-empty-match")
          .map(f => [f.match_text, f.match_start, f.match_end]);
        assert.deepEqual(actual, expected);
        assert.ok(result.findings.every(f => f.match_end > f.match_start), "no zero-width findings");
        if (operation === "redactText") assert.equal(result.redacted, expectedRedacted);
      }

      // The reviewed bug: the new Unicode flag changes the same source from a
      // nonempty-only matcher into one that also returns empty matches.
      check(${JSON.stringify(String.raw`\p{ASCII}*`)}, "u", "abc", [["abc", 0, 3]], "[REDACTED_CUSTOM]");
      check(${JSON.stringify(String.raw`\p{ASCII}*`)}, "u", "abc😀def", [["abc", 0, 3], ["def", 5, 8]],
        "[REDACTED_CUSTOM]😀[REDACTED_CUSTOM]");

      // Do not break at the first empty match: later sensitive spans still need
      // scanning. Advancing by one UTF-16 unit under /u would rewind into the
      // same surrogate pair and hang, so include a non-BMP character.
      check("(?:^|FIXTURE)", "u", "😀FIXTURE FIXTURE", [["FIXTURE", 2, 9], ["FIXTURE", 10, 17]],
        "😀[REDACTED_CUSTOM] [REDACTED_CUSTOM]");
      check(".?", "u", "😀Z", [["😀", 0, 2], ["Z", 2, 3]], "[REDACTED_CUSTOM][REDACTED_CUSTOM]");

      for (const flags of ["", "u", "uy"]) {
        for (const pattern of ["(?:)", "^", "$", "(?=.)"]) {
          check(pattern, flags, "😀", []);
          check(pattern, flags, "", []);
        }
      }

      // Skip empty matches before validators/dedupe/allowlist handling. No
      // phantom finding, replacement, or suppression should be produced.
      resetAllowlistSuppressionsForTests();
      check("A*", "u", "AAA", [], "AAA", ["AAA"]);
      assert.equal(allowlistSuppressions(), 1);

      const config = GuardConfigSchema.parse({
        nda_keywords: [],
        custom_rules: [{ description: "synthetic-empty-match", pattern: "(?:)", flags: "u" }],
      });
      const secret = "sk-AAAAAAAAAAAAAAAAAAAA";
      const result = operation === "scanText" ? scanText(secret, config) : redactText(secret, config);
      assert.ok(result.findings.length > 0, "other rules must still detect the synthetic credential");
      if (operation === "redactText") assert.ok(!result.redacted.includes(secret));
      console.log("all progress and content assertions passed");
    `], { cwd: repo, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });

    expect(child.error, `${operation} must finish before the child timeout`).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("all progress and content assertions passed");
  }, 10000);
});

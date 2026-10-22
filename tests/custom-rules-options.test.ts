import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardConfigSchema, loadConfigWithFingerprint } from "../src/config/loader.js";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { allowlistSuppressions, resetAllowlistSuppressionsForTests } from "../src/scanner/allowlist.js";
import { scanText } from "../src/scanner/engine.js";
import { customRuleBoundaries, customRuleFlags, customRulePattern, customRuleSource } from "../src/rules/dynamic.js";
import type { GuardConfig } from "../src/types.js";

const parse = (input: unknown): GuardConfig => GuardConfigSchema.parse(input) as GuardConfig;

const scan = (text: string, config: GuardConfig) => scanText(text, config).findings;

describe("custom rule flags", () => {
  it("keeps case-insensitive matching as the default", () => {
    expect(customRuleFlags({})).toBe("gi");
  });

  it("always implies g", () => {
    expect(customRuleFlags({ flags: "s" })).toBe("gs");
    expect(customRuleFlags({ flags: "gims" })).toBe("gims");
  });

  it("deduplicates g when the user writes it", () => {
    expect(customRuleFlags({ flags: "gg" })).toBe("g");
  });

  it("rejects a flag outside gimsuy at config load", () => {
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "a", flags: "x" }] })).toThrow(/flags/);
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "a", flags: "d" }] })).toThrow(/flags/);
  });

  it("compiles with the final flags, so u-only errors fail the load", () => {
    // `\1` is tolerated without `u` and rejected with it; the load must judge
    // the pattern the scanner will actually run.
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "\\1" }] })).not.toThrow();
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "\\1", flags: "u" }] })).toThrow(/does not compile/);
  });

  it("applies flags to matching", () => {
    const insensitive = parse({ custom_rules: [{ description: "x", pattern: "myco" }] });
    expect(scan("MYCO", insensitive)).toHaveLength(1);
    const sensitive = parse({ custom_rules: [{ description: "x", pattern: "myco", flags: "" }] });
    expect(scan("MYCO", sensitive)).toHaveLength(0);
  });
});

describe("custom rule word boundaries", () => {
  it("wraps literal ASCII word edges", () => {
    expect(customRuleSource({ description: "x", pattern: "MYCO", word_boundary: true })).toBe("\\bMYCO\\b");
  });

  it("does not wrap a CJK edge, so the rule still matches inside Chinese text", () => {
    const source = customRuleSource({ description: "x", pattern: "機密", word_boundary: true });
    expect(source).toBe("機密");
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "x", pattern: "機密", word_boundary: true }],
    });
    expect(scan("這是機密文件", config)).toHaveLength(1);
  });

  it("stops matching inside a larger ASCII word", () => {
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "x", pattern: "MYCO", word_boundary: true }],
    });
    expect(scan("MYCO token", config)).toHaveLength(1);
    expect(scan("AMYCOB", config)).toHaveLength(0);
  });

  it("refuses a top-level alternation instead of mis-parenthesising it", () => {
    expect(() => customRuleSource({ description: "x", pattern: "foo|bar", word_boundary: true })).toThrow(
      /top-level alternation/,
    );
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "foo|bar", word_boundary: true }] })).toThrow(
      /does not compile/,
    );
  });

  it("adds no boundary where the edge is hidden, and reports it", () => {
    // A quantifier or group edge cannot take \b safely: the rule still loads,
    // but it is looser than it looks, so doctor warns instead of guessing.
    expect(customRuleSource({ description: "x", pattern: "EMP-\\d{6}", word_boundary: true })).toBe("\\bEMP-\\d{6}");
    expect(customRuleBoundaries({ pattern: "EMP-\\d{6}", word_boundary: true })).toEqual({
      lead: "added",
      trail: "hidden",
    });
    expect(customRuleBoundaries({ pattern: "(?:foo|bar)", word_boundary: true })).toEqual({
      lead: "hidden",
      trail: "hidden",
    });
  });

  it("respects a boundary the pattern already writes", () => {
    expect(customRuleSource({ description: "x", pattern: "\\bEMP-\\d{6}\\b", word_boundary: true })).toBe(
      "\\bEMP-\\d{6}\\b",
    );
    expect(customRuleSource({ description: "x", pattern: "^MYCO$", word_boundary: true })).toBe("^MYCO$");
  });

  it("leaves the pattern alone when word_boundary is off", () => {
    expect(customRulePattern({ description: "x", pattern: "MYCO", severity: "HIGH" }).source).toBe("MYCO");
  });
});

describe("allowlists", () => {
  it("suppresses an exact per-rule value and counts it", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({
      nda_keywords: [],
      custom_rules: [
        { description: "x", pattern: "MYCO_[A-Z]{4}", allow: ["MYCO_AAAA"] },
      ],
    });
    const findings = scan("MYCO_AAAA MYCO_BBBB", config);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.match_text).toBe("MYCO_BBBB");
    expect(allowlistSuppressions()).toBe(1);
  });

  it("does not suppress a value that merely shares a prefix", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "x", pattern: "MYCO_[A-Z]{4}", allow: ["MYCO_AAAA"] }],
    });
    expect(scan("MYCO_AAAB", config)).toHaveLength(1);
    expect(allowlistSuppressions()).toBe(0);
  });

  it("applies the global allowlist to built-in findings", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    expect(scan("contact user@example.com now", config)).toHaveLength(0);
    expect(allowlistSuppressions()).toBeGreaterThan(0);
  });

  it("still reports a different address", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const findings = scan("contact other@example.com now", config);
    expect(findings).toHaveLength(1);
  });

  it("caps the number of entries", () => {
    const many = Array.from({ length: 33 }, (_, index) => `value-${index}`);
    expect(() => parse({ custom_rules: [{ description: "x", pattern: "a", allow: many }] })).toThrow(/allow/);
    const global = Array.from({ length: 65 }, (_, index) => `value-${index}`);
    expect(() => parse({ settings: { allowlist: global } })).toThrow(/allowlist/);
  });

  it("caps the length of an entry", () => {
    const long = "x".repeat(201);
    expect(() => parse({ settings: { allowlist: [long] } })).toThrow(/allowlist/);
  });
});

describe("allowlist fingerprint", () => {
  it("changes the config fingerprint when an entry is added", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-allowlist-"));
    const plain = path.join(dir, "plain.yaml");
    const withEntry = path.join(dir, "entry.yaml");
    fs.writeFileSync(plain, "custom_rules: []\nsettings:\n  allowlist: []\n");
    fs.writeFileSync(withEntry, "custom_rules: []\nsettings:\n  allowlist:\n    - user@example.com\n");
    const a = loadConfigWithFingerprint(plain, dir);
    const b = loadConfigWithFingerprint(withEntry, dir);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(b.config.settings.allowlist).toEqual(["user@example.com"]);
    expect(a.config.settings.allowlist).toEqual([]);
  });
});

function makeDoctorFixture(guardConfig: GuardConfig, smokeScan: DoctorDeps["smokeScan"]) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-doctor-allow-"));
  const dist = path.join(tmp, "leakshield", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), "export {};");
  fs.writeFileSync(
    path.join(tmp, "opencode.json"),
    JSON.stringify({ plugins: [{ package: path.join(tmp, "leakshield", "dist") }] }, null, 2),
  );
  const deps: DoctorDeps = {
    opencodeVersion: () => "opencode v2.0.23",
    readIfExists(p) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    existsDir(p) {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    existsFile(p) {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    loadGuardConfig: () => guardConfig,
    smokeScan,
    cwd: tmp,
    home: tmp,
  };
  return deps;
}

const everythingFinds = (): { findings: number } => ({ findings: 1 });

describe("doctor allowlist reporting", () => {
  it("exercises every entry and reports the count", async () => {
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const deps = makeDoctorFixture(config, (text, active) => ({
      findings: text.startsWith("Smoke test only") ? 1 : active.settings.allowlist?.includes(text) ? 0 : 1,
    }));
    const report = await runDoctor(deps);
    const check = report.checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("ok");
    expect(check?.detail).toContain("1 allowlist entry");
    expect(check?.detail).toContain("exact match only");
  });

  it("warns about an entry that suppresses nothing", async () => {
    const config = parse({ settings: { allowlist: ["nobody-matches-me"] } });
    const deps = makeDoctorFixture(config, (text) => ({ findings: text.startsWith("Smoke test only") ? 1 : 0 }));
    const check = (await runDoctor(deps)).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("match nothing");
  });

  it("fails when an allowlisted value still produces a finding", async () => {
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const deps = makeDoctorFixture(config, everythingFinds);
    const check = (await runDoctor(deps)).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("fail");
  });

  it("warns that path scoping is accepted but not implemented", async () => {
    const config = parse({
      custom_rules: [{ description: "x", pattern: "MYCO", path: ["src/**"] }],
    });
    const check = (await runDoctor(makeDoctorFixture(config, everythingFinds))).checks.find(
      (entry) => entry.id === "custom-rule-paths",
    );
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("not implemented");
  });

  it("warns when word_boundary could not be applied at an edge", async () => {
    const config = parse({
      custom_rules: [{ description: "employee id", pattern: "EMP-\\d{6}", word_boundary: true }],
    });
    const check = (await runDoctor(makeDoctorFixture(config, everythingFinds))).checks.find(
      (entry) => entry.id === "custom-rule-boundaries",
    );
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("employee id");
  });
});

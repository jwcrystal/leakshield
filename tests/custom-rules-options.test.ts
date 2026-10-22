import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardConfigSchema, loadConfigWithFingerprint } from "../src/config/loader.js";
import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import { allowlistSuppressions, resetAllowlistSuppressionsForTests } from "../src/scanner/allowlist.js";
import { scanText, redactText } from "../src/scanner/engine.js";
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

  it("treats an escaped edge as hidden, so a non-word ending still matches", () => {
    // `\D` is not a literal "D": appending \b would require a word character
    // after it and drop `KEY!`.
    expect(customRuleSource({ description: "x", pattern: "KEY\\D", word_boundary: true })).toBe("\\bKEY\\D");
    expect(customRuleBoundaries({ pattern: "KEY\\D", word_boundary: true })).toEqual({ lead: "added", trail: "hidden" });
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "x", pattern: "KEY\\D", word_boundary: true }],
    });
    expect(scan("KEY!", config)).toHaveLength(1);
  });

  it("does not wrap an escaped CJK ending", () => {
    const pattern = "\\u6a5f\\u5bc6";
    expect(customRuleSource({ description: "x", pattern, word_boundary: true })).toBe(pattern);
    expect(customRuleBoundaries({ pattern, word_boundary: true })).toEqual({ lead: "hidden", trail: "hidden" });
    const config = parse({ nda_keywords: [], custom_rules: [{ description: "x", pattern, word_boundary: true }] });
    expect(scan("這是機密文件", config)).toHaveLength(1);
  });

  it("treats control and octal escapes as hidden edges", () => {
    // `\cA` and `\07` are one token each, and neither ends in a word character.
    expect(customRuleBoundaries({ pattern: "KEY\\cA", word_boundary: true })).toEqual({ lead: "added", trail: "hidden" });
    expect(customRuleBoundaries({ pattern: "KEY\\07", word_boundary: true })).toEqual({ lead: "added", trail: "hidden" });
    expect(customRuleSource({ description: "x", pattern: "KEY\\cA", word_boundary: true })).toBe("\\bKEY\\cA");
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

  it("does not let a suppressed short match hide another rule's longer match", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({
      nda_keywords: [],
      custom_rules: [
        { description: "prefix", pattern: "PUBLIC", allow: ["PUBLIC"] },
        { description: "real", pattern: "PUBLIC-[A-Z]{4}" },
      ],
    });
    const findings = scan("PUBLIC-REAL", config);
    expect(findings.map((finding) => finding.match_text)).toEqual(["PUBLIC-REAL"]);
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

  it("leaves an allowlisted value intact when redacting", () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const result = redactText("contact user@example.com", config);
    expect(result.redacted).toBe("contact user@example.com");
    expect(result.total_findings).toBe(0);
  });

  it("still redacts a different value", () => {
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const result = redactText("contact other@example.com", config);
    expect(result.redacted).toContain("[REDACTED_");
    expect(result.redacted).not.toContain("other@example.com");
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

function makeDoctorFixture(
  guardConfig: GuardConfig,
  options: { smokeScan?: DoctorDeps["smokeScan"]; probeScan?: DoctorDeps["probeScan"]; v1?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-doctor-allow-"));
  const dist = path.join(tmp, "leakshield", "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "index.js"), "export {};");
  fs.writeFileSync(path.join(dist, "opencode.js"), "export {};");
  const config = options.v1
    ? { plugin: [path.join(dist, "opencode.js")] }
    : { plugins: [{ package: dist }] };
  fs.writeFileSync(path.join(tmp, "opencode.json"), JSON.stringify(config, null, 2));
  const deps: DoctorDeps = {
    opencodeVersion: () => (options.v1 ? "opencode 1.18.29" : "opencode v2.0.23"),
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
    smokeScan: options.smokeScan ?? (() => ({ findings: 1 })),
    ...(options.probeScan ? { probeScan: options.probeScan } : {}),
    cwd: tmp,
    home: tmp,
  };
  return deps;
}


describe("doctor allowlist reporting", () => {
  it("uses the severity-agnostic probe, so a working MEDIUM entry is not called dead", async () => {
    // The email finding is MEDIUM; smokeScan counts HIGH only.
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("ok");
    expect(check?.detail).toContain("1 allowlist entry");
    expect(check?.detail).toContain("exact match only");
  });

  it("judges a per-rule entry against its own rule, not against a longer match elsewhere", async () => {
    resetAllowlistSuppressionsForTests();
    const config = parse({
      nda_keywords: [],
      custom_rules: [
        { description: "prefix", pattern: "PUBLIC", allow: ["PUBLIC"] },
        { description: "real", pattern: "PUBLIC-[A-Z]{4}" },
      ],
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("ok");
  });

  it("isolates a per-rule entry from built-in detectors", async () => {
    // The literal is also an email, so a scope that kept the built-in detector
    // would find a second exact match and wrongly call the filter broken.
    const config = parse({
      nda_keywords: [],
      custom_rules: [
        {
          description: "corp email",
          pattern: "corp-[a-z]+@example\\.com",
          allow: ["corp-qa@example.com"],
        },
      ],
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("ok");
  });

  it("ignores the standing Unicode warning when judging a per-rule entry", async () => {
    // A Cyrillic character makes an always-on homograph warning with the same
    // exact text; it is not a rule match, so it must not read as broken.
    const pattern = "KEY\u0430";
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "safe fixture", pattern, allow: [pattern] }],
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("ok");
  });

  it("does not claim suppression when the entry is not an exact matched span", async () => {
    const config = parse({
      nda_keywords: [],
      custom_rules: [{ description: "prefix", pattern: "PUBLIC" }],
      settings: { allowlist: ["PUBLIC-REAL"] },
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("could not be exercised");
  });

  it("does not call a context-dependent entry dead", async () => {
    const config = parse({ settings: { allowlist: ["nobody-matches-me"] } });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("could not be exercised");
  });

  it("fails, and reports BROKEN, when an allowlisted literal still produces a finding", async () => {
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const deps = makeDoctorFixture(config, {
      probeScan: () => ({ findings: 1, exact: [{ description: "x", unicodeWarning: false }] }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((entry) => entry.id === "allowlist");
    expect(check?.state).toBe("fail");
    expect(report.status).toBe("BROKEN");
  });

  it("reports BROKEN on a v1 host too", async () => {
    const config = parse({ settings: { allowlist: ["user@example.com"] } });
    const deps = makeDoctorFixture(config, { probeScan: () => ({ findings: 1, exact: [{ description: "x", unicodeWarning: false }] }), v1: true });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
  });

  it("warns that path scoping is accepted but not implemented", async () => {
    const config = parse({
      custom_rules: [{ description: "x", pattern: "MYCO", path: ["src/**"] }],
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find(
      (entry) => entry.id === "custom-rule-paths",
    );
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("not implemented");
  });

  it("warns when word_boundary could not be applied at an edge", async () => {
    const config = parse({
      custom_rules: [{ description: "employee id", pattern: "EMP-\\d{6}", word_boundary: true }],
    });
    const check = (await runDoctor(makeDoctorFixture(config))).checks.find(
      (entry) => entry.id === "custom-rule-boundaries",
    );
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain("employee id");
  });
});

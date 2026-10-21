/**
 * Dotted runs longer than four octets (issue #40).
 *
 * A regex over `(?:\d{1,3}\.){3}\d{1,3}` consumes the first four groups of
 * `10.1.2.3.4` and never retries the remainder, so the public `1.2.3.4`
 * inside it went undetected. The masker then saw that literal in the request
 * and refused the whole thing with residual_sensitive_content. The run is now
 * matched whole, which keeps detection consistent and lets the masker cover
 * every address it contains.
 */

import { describe, expect, it } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import type { GuardConfig } from "../src/types.js";

const base: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

const withPrivate = (extra: Partial<GuardConfig["settings"]> = {}): GuardConfig => ({
  ...base,
  settings: { ...base.settings, rule_overrides: { "private-ipv4": true }, ...extra },
});

function ipFindings(text: string, config: GuardConfig = base) {
  return scanText(text, config).findings.filter((finding) => finding.type === "PII_IP");
}

describe("IPv4 dotted runs", () => {
  it("reports a run whose only public window is a suffix", () => {
    const findings = ipFindings("connect 10.1.2.3.4 now");
    expect(findings).toHaveLength(1);
    // The whole run is reported, so masking cannot leave 1.2.3.4 behind.
    expect(findings[0].match_text).toBe("10.1.2.3.4");
    expect(findings[0].match_start).toBe(8);
    expect(findings[0].match_end).toBe(18);
  });

  it("reports a run of public addresses whole", () => {
    const findings = ipFindings("hosts 1.2.3.4.5");
    expect(findings).toHaveLength(1);
    expect(findings[0].match_text).toBe("1.2.3.4.5");
  });

  it("leaves a four-octet private address to the opt-in rule", () => {
    expect(ipFindings("10.1.2.3")).toHaveLength(0);
    const findings = ipFindings("10.1.2.3", withPrivate());
    expect(findings).toHaveLength(1);
    expect(findings[0].match_text).toBe("10.1.2.3");
  });

  it("reports a private run once when both rules see a window", () => {
    const findings = ipFindings("10.1.2.3.4", withPrivate());
    expect(findings).toHaveLength(1);
    expect(findings[0].match_text).toBe("10.1.2.3.4");
  });

  it("honours private_cidrs inside a run", () => {
    const config = withPrivate({ private_cidrs: ["10.0.0.0/8"] });
    const findings = ipFindings("10.0.0.1.99", config);
    expect(findings).toHaveLength(1);
    expect(findings[0].match_text).toBe("10.0.0.1.99");
    // 192.168/16 is no longer in the configured list.
    expect(ipFindings("192.168.0.1", config)).toHaveLength(0);
  });

  it("does not invent an address in a three-group run", () => {
    expect(ipFindings("version 1.2.3")).toHaveLength(0);
  });

  it("reports a run with an invalid octet only through a valid window", () => {
    expect(ipFindings("build 999.1.2.3.4")).toHaveLength(1);
    expect(ipFindings("build 1.2.3.999")).toHaveLength(0);
    expect(ipFindings("build 999.888.777.666")).toHaveLength(0);
  });
});

describe("masking a dotted run", () => {
  it("masks the whole run, not just its first four groups", () => {
    const created = createPseudonymizer(base);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = created.protectText("s_run", "connect 10.1.2.3.4 now");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("10.1.2.3");
    expect(result.text).not.toContain("1.2.3.4");
  });

  it("accepts a payload where the address also appears standalone (#40)", () => {
    const created = createPseudonymizer(base);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Before the fix this was refused with residual_sensitive_content: the
    // standalone address was masked, the same suffix inside the run was not.
    const result = created.protectJsonForModel("s_run_json", {
      messages: [
        { text: "example address 1.2.3.4" },
        { text: "range documentation 10.1.2.3.4" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("1.2.3.4");
    expect(serialized).not.toContain("10.1.2.3");
  });
});

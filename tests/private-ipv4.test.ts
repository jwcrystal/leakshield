/**
 * Opt-in private-range IPv4 detection (issue #31).
 *
 * The public-ipv4 rule deliberately drops RFC 1918, CGNAT and link-local
 * addresses, so internal topology was the one IPv4 shape the scanner could
 * never report. This rule fills that gap behind `rule_overrides`, with an
 * optional `private_cidrs` list so an organisation can narrow it to its real
 * VPN ranges. Every address here is private space or a public documentation
 * address used only as a boundary probe.
 */

import { describe, expect, it } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import { GuardConfigSchema } from "../src/config/loader.js";
import { containsAddress, parseCidr, parseCidrList } from "../src/scanner/cidr.js";
import type { GuardConfig } from "../src/types.js";

const base: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

const withRule = (extra: Partial<GuardConfig["settings"]> = {}): GuardConfig => ({
  ...base,
  settings: { ...base.settings, rule_overrides: { "private-ipv4": true }, ...extra },
});

function ipFindings(text: string, config: GuardConfig) {
  return scanText(text, config).findings.filter((finding) => finding.type === "PII_IP");
}

describe("private-ipv4 rule", () => {
  it("is off by default", () => {
    expect(scanText("db at 10.1.2.3 for testing", base).findings).toHaveLength(0);
  });

  it("stays off when the override is false", () => {
    const config: GuardConfig = {
      ...base,
      settings: { ...base.settings, rule_overrides: { "private-ipv4": false } },
    };
    expect(ipFindings("10.1.2.3", config)).toHaveLength(0);
  });

  it.each([
    ["RFC 1918 /8", "10.1.2.3"],
    ["RFC 1918 /8 upper edge", "10.255.255.255"],
    ["RFC 1918 /12 lower edge", "172.16.0.0"],
    ["RFC 1918 /12", "172.20.0.9"],
    ["RFC 1918 /12 upper edge", "172.31.255.255"],
    ["RFC 1918 /16", "192.168.1.10"],
    ["CGNAT /10 lower edge", "100.64.0.0"],
    ["CGNAT /10", "100.100.1.1"],
    ["CGNAT /10 upper edge", "100.127.255.255"],
    ["link-local", "169.254.1.1"],
  ])("reports %s", (_label, address) => {
    expect(ipFindings(`host ${address}`, withRule())).toHaveLength(1);
  });

  it.each([
    ["below 172.16/12", "172.15.255.255"],
    ["above 172.16/12", "172.32.0.0"],
    ["below 100.64/10", "100.63.255.255"],
    ["above 100.64/10", "100.128.0.0"],
    ["above link-local", "169.255.0.0"],
  ])("adds nothing for a public address %s", (_label, address) => {
    // These are public, so the always-on rule already reports them; the
    // opt-in rule must not change that count.
    expect(ipFindings(`host ${address}`, withRule())).toHaveLength(
      ipFindings(`host ${address}`, base).length,
    );
  });

  it("leaves the public-ipv4 rule as the only finding for a public address", () => {
    expect(ipFindings("host 93.184.216.34", withRule())).toHaveLength(1);
    expect(ipFindings("host 93.184.216.34", base)).toHaveLength(1);
  });

  it("never reports 8.8.8.8 as private as well as public", () => {
    const on = scanText("resolver 8.8.8.8", withRule()).findings;
    const off = scanText("resolver 8.8.8.8", base).findings;
    expect(on).toHaveLength(1);
    expect(on[0].match_text).toBe("8.8.8.8");
    // Same detector produced it with the opt-in rule on and off.
    expect(on[0].description).toBe(off[0].description);
  });

  it("narrows to the configured networks", () => {
    const config = withRule({ private_cidrs: ["10.0.0.0/8"] });
    expect(ipFindings("10.1.2.3", config)).toHaveLength(1);
    expect(ipFindings("192.168.1.10", config)).toHaveLength(0);
  });

  it("accepts a single-host prefix", () => {
    const config = withRule({ private_cidrs: ["10.0.0.5/32"] });
    expect(ipFindings("10.0.0.5", config)).toHaveLength(1);
    expect(ipFindings("10.0.0.6", config)).toHaveLength(0);
  });
});

describe("private_cidrs validation", () => {
  it.each([
    ["prefix above 32", "10.0.0.0/33"],
    ["missing prefix", "10.0.0.0"],
    ["hostname instead of address", "corp.internal/8"],
    ["octet above 255", "10.0.0.256/8"],
    ["two slashes", "10.0.0.0/8/8"],
  ])("rejects %s", (_label, cidr) => {
    expect(() => GuardConfigSchema.parse({ settings: { private_cidrs: [cidr] } })).toThrow();
  });

  it("accepts a valid list and defaults to empty", () => {
    const parsed = GuardConfigSchema.parse({ settings: { private_cidrs: ["10.0.0.0/8", "192.168.0.0/16"] } });
    expect(parsed.settings.private_cidrs).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(GuardConfigSchema.parse({}).settings.private_cidrs).toEqual([]);
  });
});

describe("cidr helpers", () => {
  it("classifies boundary addresses", () => {
    const defaults = parseCidrList(undefined);
    expect(containsAddress(defaults, "10.0.0.0")).toBe(true);
    expect(containsAddress(defaults, "10.255.255.255")).toBe(true);
    expect(containsAddress(defaults, "172.15.255.255")).toBe(false);
    expect(containsAddress(defaults, "172.16.0.0")).toBe(true);
    expect(containsAddress(defaults, "172.31.255.255")).toBe(true);
    expect(containsAddress(defaults, "172.32.0.0")).toBe(false);
    expect(containsAddress(defaults, "100.63.255.255")).toBe(false);
    expect(containsAddress(defaults, "100.64.0.0")).toBe(true);
    expect(containsAddress(defaults, "100.127.255.255")).toBe(true);
    expect(containsAddress(defaults, "100.128.0.0")).toBe(false);
    expect(containsAddress(defaults, "169.254.1.1")).toBe(true);
    expect(containsAddress(defaults, "169.255.0.0")).toBe(false);
  });

  it("handles the zero prefix", () => {
    const cidr = parseCidr("0.0.0.0/0");
    expect(cidr).not.toBeNull();
    expect(containsAddress([cidr!], "93.184.216.34")).toBe(true);
  });

  it("rejects non-addresses", () => {
    expect(parseCidr("not-an-address/8")).toBeNull();
    expect(containsAddress(parseCidrList(undefined), "not-an-address")).toBe(false);
  });
});

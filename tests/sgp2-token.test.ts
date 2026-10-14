/**
 * W1 (SGP2) acceptance tests — typed, low-false-positive v2 tokens.
 *
 * Covers the 2026-10-07 execution plan Phase A acceptance:
 * - Minted shape: `[SGP2:<CATEGORY>-<seg>-<seg>-<seg>]`, category derived
 *   from the scanner FindingType, letter-only 4-4-4 payload.
 * - Category correctness across detector families (exact-value, custom
 *   rules, built-in email/NDA, dynamic keyword).
 * - Payload properties: no digits at all (digit-based detector families
 *   cannot match), bounded hex-like runs (≤4), deterministic length per
 *   category.
 * - Mixed-version history: an owned v2 token restores exactly while a
 *   well-shaped foreign v1 token follows the P1 policy (strict refusal,
 *   display/model literal preservation) — never reinterpreted.
 * - Sticky-regex hygiene: repeated fail-then-succeed sequences produce
 *   identical results (no lastIndex pollution on early-return paths).
 * - False-positive corpus: a large sample of minted tokens across every
 *   category scans clean under the default and URL-opt-in profiles.
 */

import { describe, expect, it } from "vitest";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import { ExactValueDetector } from "../src/scanner/exact-values.js";
import { scanTextInternal } from "../src/scanner/engine.js";
import type { GuardConfig } from "../src/types.js";

const baseConfig: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true,
  },
};

const TOKEN_V2 = /\[SGP2:([A-Z][A-Z_]*)-([a-z]{4})-([a-z]{4})-([a-z]{4})\]/;
const FOREIGN_V1 = `[SGP1:${"deadbeef".repeat(4)}-00000001]`;

function makeService(config: GuardConfig = baseConfig) {
  const created = createPseudonymizer(config);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("static failure");
  return created;
}

function mintOne(input: string, config: GuardConfig = baseConfig): { token: string; original: string } {
  const ps = makeService(config);
  const result = ps.protectText("s", `x ${input} y`);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("protect failed");
  const match = TOKEN_V2.exec(result.text);
  expect(match).not.toBeNull();
  return { token: match![0], original: input };
}

describe("SGP2 minted shape and categories", () => {
  it("labels tokens with the scanner FindingType of the masked finding", () => {
    const cases: Array<{ input: string; category: string; config?: GuardConfig }> = [
      { input: "alice@example.com", category: "PII_EMAIL" },
      { input: "sk-QwertyuiopAsdfghjklZx", category: "API_KEY" },
      {
        input: "GB82WEST12345698765432",
        category: "PII_IBAN",
      },
      { input: "4111111111111111", category: "PII_CREDIT_CARD" },
      { input: "8.8.8.8", category: "PII_IP" },
      {
        input: "MarkerXY",
        category: "ENV_SECRET",
        config: { ...baseConfig, exact_value_detector: new ExactValueDetector(["MarkerXY"]) },
      },
      {
        input: "Qmark",
        category: "CUSTOM",
        config: {
          ...baseConfig,
          custom_rules: [{ description: "q-marker", pattern: "Qmark", severity: "LOW" }],
        },
      },
      {
        input: "project-bluebird",
        category: "NDA_KEYWORD",
        config: { ...baseConfig, nda_keywords: ["project-bluebird"] },
      },
    ];
    for (const { input, category, config } of cases) {
      const { token } = mintOne(input, config ?? baseConfig);
      expect(token.startsWith(`[SGP2:${category}-`)).toBe(true);
    }
  });

  it("picks the highest-severity category when overlapping findings union into one span", () => {
    // The email substring sits inside a custom LOW rule's span; the union
    // span carries the HIGH email label.
    const config: GuardConfig = {
      ...baseConfig,
      custom_rules: [{ description: "wide", pattern: "contact \\S+example", severity: "LOW" }],
    };
    const { token } = mintOne("contact alice@example.com now", config);
    expect(token.startsWith("[SGP2:PII_EMAIL-")).toBe(true);
  });

  it("keeps the payload letter-only with bounded runs and per-category length", () => {
    const markers = Array.from({ length: 300 }, (_, i) => `MarkerXY${i}`);
    const ps = makeService({
      ...baseConfig,
      exact_value_detector: new ExactValueDetector(markers),
    });
    const lengths = new Set<number>();
    for (const marker of markers) {
      const result = ps.protectText("s", marker);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const match = TOKEN_V2.exec(result.text);
      expect(match).not.toBeNull();
      if (!match) return;
      expect(match[2]).toMatch(/^[a-z]+$/);
      expect(match[3]).toMatch(/^[a-z]+$/);
      expect(match[4]).toMatch(/^[a-z]+$/);
      // Hex-like runs stay ≤4 in the REAL token (hyphens break runs).
      expect(match[0]).not.toMatch(/[a-f]{5}/);
      lengths.add(result.text.length);
    }
    // Same category ⇒ deterministic token length.
    expect(lengths.size).toBe(1);
  });

  it("reuses one stable token per original and keeps distinct originals distinct", () => {
    const ps = makeService();
    const first = ps.protectText("s", "use alice@example.com here");
    const second = ps.protectText("s", "elsewhere alice@example.com appears");
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const t1 = TOKEN_V2.exec(first.text)![0];
    const t2 = TOKEN_V2.exec(second.text)![0];
    expect(t1).toBe(t2);
    const other = ps.protectText("s", "bob@example.com too");
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(TOKEN_V2.exec(other.text)![0]).not.toBe(t1);
  });
});

describe("SGP2 / SGP1 mixed-version history", () => {
  it("restores an owned v2 token exactly beside a foreign v1 token (display path)", () => {
    const ps = makeService();
    const protectedText = ps.protectText("s", "mail alice@example.com");
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    const token = TOKEN_V2.exec(protectedText.text)![0];
    const mixed = `old ${FOREIGN_V1} new ${token}`;
    // Strict restore refuses the foreign v1 marker (no mapping).
    expect(ps.restoreText("s", mixed)).toEqual({ ok: false, reason: "unknown_token" });
    // Display restore replaces the owned v2 token and keeps v1 literal.
    const display = ps.restoreTextForDisplay("s", mixed);
    expect(display).toEqual({ ok: true, text: `old ${FOREIGN_V1} new alice@example.com` });
  });

  it("preserves a foreign v1 marker literally in model-facing protection", () => {
    const ps = makeService();
    const input = `history ${FOREIGN_V1} plus secret sk-QwertyuiopAsdfghjklZx`;
    const result = ps.protectTextForModel("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(FOREIGN_V1);
    expect(result.text).not.toContain("sk-QwertyuiopAsdfghjklZx");
    expect(result.text).toMatch(/\[SGP2:API_KEY-/);
  });

  it("never reinterprets a v1-shaped token as v2 or vice versa", () => {
    const ps = makeService();
    // A v2 payload cannot masquerade as a v1 epoch token: the strict shapes
    // differ, so a foreign v2 token is judged by the v2 grammar only.
    const foreignV2 = "[SGP2:PII_EMAIL-abcd-efgh-ijkl]";
    expect(ps.restoreText("s", `x ${foreignV2} y`)).toEqual({ ok: false, reason: "unknown_token" });
    expect(ps.restoreTextForDisplay("s", `x ${foreignV2} y`)).toEqual({
      ok: true,
      text: `x ${foreignV2} y`,
    });
  });
});

describe("SGP2 scanner hygiene", () => {
  it("repeated fail-then-succeed sequences stay deterministic (sticky regex lastIndex)", () => {
    const ps = makeService();
    const protectedText = ps.protectText("s", "alice@example.com");
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    const token = TOKEN_V2.exec(protectedText.text)![0];
    const malformed = "[SGP2:PII_EMAIL-abcd";
    for (let i = 0; i < 100; i += 1) {
      expect(ps.restoreText("s", `a ${malformed} b`)).toEqual({ ok: false, reason: "malformed_token" });
      expect(ps.restoreText("s", `a ${FOREIGN_V1} b`)).toEqual({ ok: false, reason: "unknown_token" });
      expect(ps.restoreText("s", `a ${token} b`)).toEqual({ ok: true, text: "a alice@example.com b" });
      expect(ps.isStructuralIdentifierSafe("s", `a ${token} b`)).toBe(true);
    }
  });

  it("scans a large multi-category token corpus clean under default and URL-opt-in profiles", () => {
    const inputs = [
      "alice@example.com",
      "sk-QwertyuiopAsdfghjklZx",
      "GB82WEST12345698765432",
      "4111111111111111",
      "8.8.8.8",
      "https://secret.example.com/panel",
      "project-bluebird",
    ];
    const perInput = 40;
    // Same corpus config but without the URL override, for the default-profile scan.
    const baseConfigWithNda = (): GuardConfig => ({ ...baseConfig, nda_keywords: ["project-bluebird"] });
    const corpusConfig: GuardConfig = {
      ...baseConfig,
      nda_keywords: ["project-bluebird"],
      settings: { ...baseConfig.settings, rule_overrides: { url: true } },
      exact_value_detector: new ExactValueDetector(
        Array.from({ length: 200 }, (_, i) => `SyntheticMarker${i}`),
      ),
    };
    const ps = makeService(corpusConfig);
    const tokens: string[] = [];
    for (const input of inputs) {
      for (let i = 0; i < perInput; i += 1) {
        const result = ps.protectText("s", `ctx${i} ${input}`);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        tokens.push(TOKEN_V2.exec(result.text)![0]);
      }
    }
    for (let i = 0; i < 200; i += 1) {
      const result = ps.protectText("s", `v${i} SyntheticMarker${i}`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      tokens.push(TOKEN_V2.exec(result.text)![0]);
    }
    expect(tokens.length).toBe(inputs.length * perInput + 200);
    const corpus = tokens.join(" ");
    // Both profiles scan the FULL token (category included) clean: default
    // (URL opt-in off) and URL-enabled.
    for (const config of [baseConfigWithNda(), corpusConfig]) {
      const scan = scanTextInternal(corpus, config, { honorIgnoreDirectives: false });
      expect(scan.safe).toBe(true);
      expect(scan.findings).toHaveLength(0);
    }
  });
});


describe("R-round: union severity and seed intake (F1.1/F1.2/F1.3)", () => {
  it("F1.1: a contained higher-severity finding relabels the union category", () => {
    // A LOW custom rule span fully CONTAINS a HIGH email span: the minted
    // token must carry the email category, not the custom one.
    const config: GuardConfig = {
      ...baseConfig,
      custom_rules: [
        { description: "low-wide", pattern: "contact\\s+\\S+@\\S+\\s+now", severity: "LOW" },
      ],
    };
    const { token } = mintOne("contact alice@example.com now", config);
    expect(token).toMatch(/^\[SGP2:PII_EMAIL-/);
  });

  it("F1.2: seed intake rejects well-shaped tokens with unknown categories", () => {
    const ps = makeService();
    const result = ps.seedSession("s_tamper", {
      epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      entries: [{ token: "[SGP2:NOT_A_CATEGORY-abcd-efgh-ijkl]", original: "alice@example.com" }],
    });
    expect(result).toEqual({ ok: false, reason: "malformed_token" });
    expect(ps.hasSession("s_tamper")).toBe(false);
  });

  it("F1.3: cheap size caps are judged BEFORE per-entry validation (memory guard)", () => {
    const created = createPseudonymizer(baseConfig, { maxEntriesPerSession: 2 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The third entry is ALSO malformed; entry_limit must win because the
    // size check precedes per-entry work — a hostile seed cannot make the
    // loop allocate before its size is judged.
    const result = created.seedSession("s_budget", {
      epoch: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
      entries: [
        { token: "[SGP2:PII_EMAIL-abcd-efgh-ijkl]", original: "a@example.com" },
        { token: "[SGP2:PII_EMAIL-mnop-qrst-uvwx]", original: "b@example.com" },
        { token: "[SGP2:BOGUS", original: "c@example.com" },
      ],
    });
    expect(result).toEqual({ ok: false, reason: "entry_limit" });
  });
});

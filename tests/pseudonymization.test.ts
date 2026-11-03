/**
 * Pseudonymization core behavior tests (issue #22 offline core).
 *
 * These tests exercise PUBLIC observable behavior of createPseudonymizer with
 * the real scanner and synthetic secrets only: mapping stability/distinction,
 * exact reversible roundtrips, session isolation, token-namespace validation,
 * fail-closed hazards (encoded/truncated/unicode/scanner errors), union
 * masking of overlapping findings (P1, 2026-10-06b), documented budgets with
 * atomic rollback, strict-JSON structural rules, and static-only failure
 * payloads. No private map layout or factory internals.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import type { PseudonymLimits } from "../src/decision/pseudonymization.js";
import { ExactValueDetector } from "../src/scanner/exact-values.js";
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

const KEY1 = "sk-Abcdef1234567890abcdef";
// Letters only after "sk-": digit runs can nest a PII_PHONE_TW finding inside
// the credential span, which the core must (and does) reject as an overlap.
const KEY2 = "sk-QwertyuiopAsdfghjklZx";
const KEY1_LOWER = "sk-abcdef1234567890abcdef";
const EMAIL1 = "alice@example.com";

const TOKEN_RE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;
const FOREIGN_TOKEN = `[SGP1:${"deadbeef".repeat(4)}-00000001]`;
const MALFORMED_TOKEN = "[SGP1:zz-1]";

function makeService(limits?: Partial<PseudonymLimits>) {
  const created = createPseudonymizer(baseConfig, limits);
  if (!created.ok) throw new Error("factory failed");
  return created;
}

function tokensIn(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

function configWith(overrides: Partial<GuardConfig["settings"]>, customRules?: GuardConfig["custom_rules"]): GuardConfig {
  return {
    ...baseConfig,
    custom_rules: customRules ?? [],
    settings: { ...baseConfig.settings, ...overrides },
  };
}

describe("factory", () => {
  it("separates literal markers in model text from strict restoration", () => {
    const created = makeService();
    const literal = `foreign ${FOREIGN_TOKEN} malformed ${MALFORMED_TOKEN}`;

    expect(created.protectText("s", literal)).toEqual({ ok: false, reason: "unknown_token" });
    const protectedText = created.protectTextForModel("s", `email ${EMAIL1} ${literal}`);
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    expect(protectedText.text).toContain(FOREIGN_TOKEN);
    expect(protectedText.text).toContain(MALFORMED_TOKEN);
    expect(protectedText.text).not.toContain(EMAIL1);

    expect(created.restoreText("s", FOREIGN_TOKEN)).toEqual({ ok: false, reason: "unknown_token" });
    expect(created.restoreTextForDisplay("s", FOREIGN_TOKEN)).toEqual({ ok: true, text: FOREIGN_TOKEN });
  });

  it("creates a service for a valid config", () => {
    const created = createPseudonymizer(baseConfig);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(typeof created.protectText).toBe("function");
      expect(typeof created.restoreText).toBe("function");
      expect(typeof created.protectJson).toBe("function");
      expect(typeof created.restoreJson).toBe("function");
      expect(typeof created.clearSession).toBe("function");
    }
  });

  it("fails statically for malformed config or limits", () => {
    expect(createPseudonymizer(null as never)).toEqual({ ok: false, reason: "STATIC_CODE" });
    expect(createPseudonymizer({} as never)).toEqual({ ok: false, reason: "STATIC_CODE" });
    expect(createPseudonymizer(configWith({ max_chars: 0 }))).toEqual({ ok: false, reason: "STATIC_CODE" });
    expect(createPseudonymizer(baseConfig, { maxSessions: 0 })).toEqual({ ok: false, reason: "STATIC_CODE" });
    expect(createPseudonymizer(baseConfig, { maxDepth: 1.5 } as never)).toEqual({ ok: false, reason: "STATIC_CODE" });
  });

  it("rejects invalid session ids and non-string text statically", () => {
    const ps = makeService();
    expect(ps.protectText("", KEY1)).toEqual({ ok: false, reason: "invalid_session" });
    expect(ps.protectText("x".repeat(300), KEY1)).toEqual({ ok: false, reason: "invalid_session" });
    expect(ps.protectText("s", 42 as never)).toEqual({ ok: false, reason: "invalid_input" });
    expect(ps.restoreText("s", null as never)).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("mapping semantics", () => {
  it("maps the same exact value to one stable token across operations", () => {
    const ps = makeService();
    const first = ps.protectText("s", `use ${KEY1} here`);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = ps.protectText("s", `elsewhere ${KEY1} appears`);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(tokensIn(first.text)).toHaveLength(1);
    expect(tokensIn(second.text)).toEqual(tokensIn(first.text));
    expect(first.text).not.toContain(KEY1);
  });

  it("maps repeated values in one text to the same token", () => {
    const ps = makeService();
    const result = ps.protectText("s", `${KEY1} and ${KEY1} again`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tokensIn(result.text)).toHaveLength(2);
    expect(new Set(tokensIn(result.text)).size).toBe(1);
  });

  it("keeps different values and case variants distinct with exact-case restoration", () => {
    const ps = makeService();
    const result = ps.protectText("s", `${KEY1} vs ${KEY2} vs ${KEY1_LOWER}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tokens = tokensIn(result.text);
    expect(new Set(tokens).size).toBe(3);
    const restored = ps.restoreText("s", result.text);
    expect(restored).toEqual({ ok: true, text: `${KEY1} vs ${KEY2} vs ${KEY1_LOWER}` });
  });

  it("roundtrips credentials and emails exactly", () => {
    const ps = makeService();
    const original = `Use ${KEY1} and mail ${EMAIL1} please.`;
    const protectedText = ps.protectText("s", original);
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    expect(protectedText.text).not.toContain(KEY1);
    expect(protectedText.text).not.toContain(EMAIL1);
    expect(tokensIn(protectedText.text)).toHaveLength(2);
    expect(ps.restoreText("s", protectedText.text)).toEqual({ ok: true, text: original });
  });

  it("isolates sessions: distinct tokens and no cross-session restore", () => {
    const ps = makeService();
    const a = ps.protectText("session-a", KEY1);
    const b = ps.protectText("session-b", KEY1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.text).not.toBe(b.text);
    const wrongSession = ps.restoreText("session-b", a.text);
    expect(wrongSession).toEqual({ ok: false, reason: "unknown_token" });
    expect(JSON.stringify(wrongSession)).not.toContain(KEY1);
    expect(ps.restoreText("session-a", a.text)).toEqual({ ok: true, text: KEY1 });
  });
});

describe("token namespace and idempotence", () => {
  it("re-protecting protected output is a no-op", () => {
    const ps = makeService();
    const first = ps.protectText("s", `ctx ${KEY1} ctx`);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(ps.protectText("s", first.text)).toEqual({ ok: true, text: first.text });
  });

  it("known tokens stay stable while neighbors are scanned and tokenized", () => {
    const ps = makeService();
    const first = ps.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const neighbor = ps.protectText("s", `${first.text} plus ${KEY2}`);
    expect(neighbor.ok).toBe(true);
    if (!neighbor.ok) return;
    expect(neighbor.text).toContain(first.text);
    expect(neighbor.text).not.toContain(KEY2);
    expect(tokensIn(neighbor.text)).toHaveLength(2);
    expect(ps.restoreText("s", neighbor.text)).toEqual({ ok: true, text: `${KEY1} plus ${KEY2}` });
  });

  it("rejects foreign, malformed, and expired reserved-prefix occurrences", () => {
    const ps = makeService();
    expect(ps.protectText("s", `see ${FOREIGN_TOKEN} ok`)).toEqual({ ok: false, reason: "unknown_token" });
    expect(ps.protectText("s", `see ${MALFORMED_TOKEN} ok`)).toEqual({ ok: false, reason: "malformed_token" });
    expect(ps.restoreText("s", FOREIGN_TOKEN)).toEqual({ ok: false, reason: "unknown_token" });
    expect(ps.restoreText("s", MALFORMED_TOKEN)).toEqual({ ok: false, reason: "malformed_token" });
    expect(ps.restoreText("ghost-session", FOREIGN_TOKEN)).toEqual({ ok: false, reason: "unknown_token" });
  });

  it("clearing invalidates old tokens and issues a fresh epoch", () => {
    const ps = makeService();
    const first = ps.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    ps.clearSession("s");
    expect(ps.restoreText("s", first.text)).toEqual({ ok: false, reason: "unknown_token" });
    expect(ps.protectText("s", first.text)).toEqual({ ok: false, reason: "unknown_token" });
    const second = ps.protectText("s", KEY1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).not.toBe(first.text);
    expect(ps.restoreText("s", second.text)).toEqual({ ok: true, text: KEY1 });
  });

  it("restore without tokens returns text unchanged without needing a session", () => {
    const ps = makeService();
    expect(ps.restoreText("ghost", "just plain text")).toEqual({ ok: true, text: "just plain text" });
  });

  it("exempts custom-rule findings wholly inside owned tokens while scanning neighbors", () => {
    // Rule 00000001 detects the issued counter digits in the token interior.
    const counterRule = { description: "counter-digits", pattern: "00000001", severity: "LOW" as const };
    const created = createPseudonymizer(configWith({}, [counterRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const neighbor = created.protectText("s", `${first.text} plus ${KEY2}`);
    expect(neighbor.ok).toBe(true);
    if (!neighbor.ok) return;
    expect(neighbor.text).toContain(first.text);
    expect(neighbor.text).not.toContain(KEY2);
    expect(tokensIn(neighbor.text)).toHaveLength(2);
    expect(created.restoreText("s", neighbor.text)).toEqual({ ok: true, text: `${KEY1} plus ${KEY2}` });
  });

  it("treats re-protecting an owned token as a no-op despite interior counter matches", () => {
    const counterRule = { description: "counter-digits", pattern: "00000001", severity: "LOW" as const };
    const created = createPseudonymizer(configWith({}, [counterRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(created.protectText("s", first.text)).toEqual({ ok: true, text: first.text });
  });

  it("still fails closed for findings crossing a token boundary", () => {
    // Pattern `\] plus` starts inside the token's closing bracket and ends
    // outside it: a crossing match, never wholly contained.
    const crossingRule = { description: "crossing", pattern: "\\] plus", severity: "LOW" as const };
    const created = createPseudonymizer(configWith({}, [crossingRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(created.protectText("s", `${first.text} plus ${KEY2}`))
      .toEqual({ ok: false, reason: "token_overlap" });
  });
});

describe("issued-token epochs and interior overlaps (deterministic crypto)", () => {
  // The 128-bit session epoch is the only randomness in this core. These
  // tests pin it IN TESTS ONLY via vi.doMock("node:crypto") on a separate
  // dynamically imported module instance: no public seed option, no
  // production test API, no scanner/detector behavior changes. Each test
  // builds its own service, so no mapping/epoch state crosses tests; the
  // statically imported createPseudonymizer used everywhere else keeps the
  // real crypto. Fixed epochs reproduce the oracle diagnosis: the token
  // epoch hex run is itself a hex/base64 decoding candidate, so decoding
  // issued-token interiors as user content rejects honest issuance.
  const EPOCH_HEX_DECODES_TO_MARKER = "5172638495a6b7c8d9eafb0c1d2e3f40"; // -> "Qrc…" (contains Q)
  const EPOCH_HEX_DECODES_TO_ZERO_WIDTH = "61616161616161616161616161e2808b"; // -> "a"*13 + U+200B
  const EPOCH_HEX_INERT = "61".repeat(16); // -> "a"*16, no finding under any config here
  const EPOCH_HEX_AA = "aa".repeat(16); // oracle-repro epoch: inert for the Q.*Z rules below
  let epochHex = EPOCH_HEX_INERT;
  let createWithEpoch: typeof createPseudonymizer;

  beforeAll(async () => {
    // resetModules forces the dynamic import below to re-evaluate the core
    // against the mocked node:crypto; without it the already-cached static
    // instance (real crypto) would be returned and the epochs would stay
    // random. The statically imported instance is unaffected.
    vi.resetModules();
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return { ...actual, randomBytes: () => Buffer.from(epochHex, "hex") };
    });
    ({ createPseudonymizer: createWithEpoch } = await import("../src/decision/pseudonymization.js"));
  });

  it("maps adversarial draw bytes into inert payload letters (bytes decode to a marker)", () => {
    // v2 (W1, 2026-10-07): the minted token carries a letter-only payload, so
    // draw bytes that would URL-decode to a marker are folded into the
    // alphabet and can never re-form percent runs inside the token.
    epochHex = EPOCH_HEX_DECODES_TO_MARKER;
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", "Q");
    expect(first).toEqual({ ok: true, text: expect.any(String) });
    if (!first.ok) return;
    expect(tokensIn(first.text)).toHaveLength(1);
    expect(tokensIn(first.text)[0]).toMatch(/^\[SGP2:CUSTOM-[a-z]{4}-[a-z]{4}-[a-z]{4}\]$/);
    // Re-protecting the token-bearing output is a no-op.
    expect(created.protectText("s", first.text)).toEqual({ ok: true, text: first.text });
    expect(created.restoreText("s", first.text)).toEqual({ ok: true, text: "Q" });
  });

  it("issues tokens when the epoch hex decodes to zero-width text (default config)", () => {
    epochHex = EPOCH_HEX_DECODES_TO_ZERO_WIDTH;
    const created = createWithEpoch(baseConfig);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedText = created.protectText("s", `use ${KEY1} now`);
    expect(protectedText).toEqual({ ok: true, text: expect.any(String) });
    if (!protectedText.ok) return;
    expect(created.restoreText("s", protectedText.text)).toEqual({ ok: true, text: `use ${KEY1} now` });
    const protectedJson = created.protectJson("s", { key: KEY1 });
    expect(protectedJson.ok).toBe(true);
    if (!protectedJson.ok) return;
    expect(created.restoreJson("s", protectedJson.value)).toEqual({ ok: true, value: { key: KEY1 } });
    // Re-protecting the committed JSON output is a no-op.
    expect(created.protectJson("s", protectedJson.value)).toEqual({ ok: true, value: protectedJson.value });
  });

  it("exempts overlapping interior findings inside owned tokens before overlap rejection", () => {
    // Draw bytes 0x78 fold to "q" (120 % 26 = 16), so the deterministic
    // payload is "qqqq-qqqq-qqqq". "qqqq" and "qqq" overlap wholly inside
    // the issued token: exemption must precede overlap rejection on both
    // the input scan and the output verification rescan.
    epochHex = "78".repeat(16);
    const rules = [
      { description: "payload-run", pattern: "qqqq", severity: "LOW" as const },
      { description: "payload-tail", pattern: "qqq", severity: "LOW" as const },
    ];
    const created = createWithEpoch(configWith({}, rules));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", KEY1);
    expect(first).toEqual({ ok: true, text: expect.any(String) });
    if (!first.ok) return;
    // Re-protecting the token with BOTH overlapping interior matches is a no-op.
    expect(created.protectText("s", first.text)).toEqual({ ok: true, text: first.text });
    // Neighbors are still scanned next to the token. The mocked draw is
    // constant, so a second distinct secret would mint a colliding payload
    // (v1 uniqueness came from the per-session counter); reuse KEY1 — the
    // interior-exemption seam under test is unaffected.
    const neighbor = created.protectText("s", `${first.text} again ${KEY1}`);
    expect(neighbor.ok).toBe(true);
    if (!neighbor.ok) return;
    expect(neighbor.text).toContain(first.text);
    expect(neighbor.text).not.toContain(KEY1);
    expect(created.restoreText("s", neighbor.text)).toEqual({ ok: true, text: `${KEY1} again ${KEY1}` });
  });

  it("masks genuine encoded content adjacent to an owned token (#48)", () => {
    epochHex = EPOCH_HEX_INERT;
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const first = created.protectText("s", "Q");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A contiguous 32-hex-char run next to the token decodes to sixteen
    // Qs (passes the detector's 10-char minimum; \x51 escapes decode to a
    // single char per candidate and stay under it). Its source span is the
    // whole hex run, so it is masked instead of refused.
    const run = "51".repeat(16);
    const masked = created.protectText("s", `${first.text} ${run}`);
    expect(masked.ok).toBe(true);
    if (!masked.ok) return;
    expect(masked.text).not.toContain(run);
    expect(tokensIn(masked.text)).toHaveLength(2);
    expect(created.restoreText("s", masked.text)).toEqual({ ok: true, text: `Q ${run}` });
    // The token itself stays restorable.
    expect(created.restoreText("s", first.text)).toEqual({ ok: true, text: "Q" });
  });

  it("detects URL-decoded context crossing an owned token and rejects encoded content (text)", () => {
    epochHex = EPOCH_HEX_AA;
    const qzRule = { description: "q-through-z", pattern: "Q.*Z", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qzRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = created.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    expect(t).toBeTruthy();
    // %51 decodes to "Q" before the token, literal Z after: the URL-context
    // window around the percent run reassembles to Q + token + Z, a Q.*Z
    // match crossing the token. Segment decoding alone cannot see it.
    expect(created.protectText("s", `%51${t}Z`)).toEqual({ ok: false, reason: "encoded_content" });
    // Literal Q before the token, %5A -> "Z" after: the mirrored crossing.
    expect(created.protectText("s", `Q${t}%5A`)).toEqual({ ok: false, reason: "encoded_content" });
    // Guard: the literal (undecoded) crossing keeps failing token_overlap.
    expect(created.protectText("s", `Q${t}Z`)).toEqual({ ok: false, reason: "token_overlap" });
    // The refusals committed nothing; the token stays restorable.
    expect(created.restoreText("s", issued.text)).toEqual({ ok: true, text: KEY1 });
  });

  it("detects URL-decoded context crossing an owned token in JSON values and keys", () => {
    epochHex = EPOCH_HEX_AA;
    const qzRule = { description: "q-through-z", pattern: "Q.*Z", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qzRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = created.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    expect(created.protectJson("s", { note: `%51${t}Z` }))
      .toEqual({ ok: false, reason: "encoded_content" });
    expect(created.protectJson("s", { [`%51${t}Z`]: "value" }))
      .toEqual({ ok: false, reason: "encoded_content" });
    expect(created.restoreJson("s", { note: t })).toEqual({ ok: true, value: { note: KEY1 } });
  });

  it("rejects a replacement-introduced token-prefix crossing in the rescan and rolls back", () => {
    epochHex = EPOCH_HEX_AA;
    // On the INPUT the M{80} marker clips out of the %51 window (only 40 of
    // 80 Ms fit), so no URL hazard fires and M{80} stages a token. The
    // substituted output places that token INSIDE the same window, where
    // Q.*\[SGP2: crosses from the decoded Q into the retained token
    // fragment: the output rescan must refuse encoded_content and roll the
    // whole staged transaction back.
    const rules = [
      { description: "m-marker", pattern: "M{80}", severity: "HIGH" as const },
      { description: "q-to-token", pattern: "Q.*\\[SGP2:", severity: "HIGH" as const },
    ];
    const created = createWithEpoch(configWith({}, rules), {
      maxUnitsPerOperation: 1000,
      maxSessions: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const payload = `%51${"x".repeat(10)}${"M".repeat(80)}`;
    expect(created.protectText("a", payload)).toEqual({ ok: false, reason: "encoded_content" });
    // Rollback proof: with maxSessions 1, session "a" never committed (a
    // committed "a" would refuse "b" with session_limit instead).
    const fresh = created.protectText("b", "M".repeat(80));
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(tokensIn(fresh.text)).toHaveLength(1);
    expect(tokensIn(fresh.text)[0]).toMatch(/^\[SGP2:CUSTOM-[a-z]{4}-[a-z]{4}-[a-z]{4}\]$/);
    expect(created.restoreText("b", fresh.text)).toEqual({ ok: true, text: "M".repeat(80) });
  });

  it("keeps safe URL windows with clipped owned fragments exempt for overlapping interiors", () => {
    // Draw bytes 0x78 fold to "q": the deterministic payload tail is
    // "qqqq", where the two payload rules overlap. The window around the
    // %41 run clips the token's first character; both findings sit wholly
    // inside the validated owned fragment and must be exempt BEFORE overlap
    // handling; the trailing decoded piece adds no finding, so protection
    // succeeds.
    epochHex = "78".repeat(16);
    const rules = [
      { description: "payload-run", pattern: "qqqq", severity: "LOW" as const },
      { description: "payload-tail", pattern: "qqq", severity: "LOW" as const },
    ];
    const created = createWithEpoch(configWith({}, rules));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = created.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    const payload = `${t}yyy%41`;
    expect(created.protectText("s", payload)).toEqual({ ok: true, text: payload });
    expect(created.restoreText("s", payload)).toEqual({ ok: true, text: `${KEY1}yyy%41` });
  });

  it("skips a URL candidate whose window piece is malformed, like the existing decoder", () => {
    epochHex = EPOCH_HEX_AA;
    const qzRule = { description: "q-through-z", pattern: "Q.*Z", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qzRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = created.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    // %zz is not a valid escape: decoding the window's leading piece throws
    // URIError, so the WHOLE candidate is skipped (tryDecodeUrl semantics),
    // even though it would otherwise decode to the crossing Q + token + Z.
    const payload = `%zz%51${t}Z`;
    expect(created.protectText("s", payload)).toEqual({ ok: true, text: payload });
  });

  it("does not let a malformed percent outside the candidate window suppress a valid crossing", () => {
    epochHex = EPOCH_HEX_AA;
    const qzRule = { description: "q-through-z", pattern: "Q.*Z", severity: "HIGH" as const };
    const created = createWithEpoch(configWith({}, [qzRule]));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const issued = created.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    // The %zz tail forms no percent run and sits outside the %51 window's
    // 50-char after-context: it cannot skip the candidate that reassembles
    // to a crossing Q + token + Z.
    const payload = `%51${t}Z${" ".repeat(60)}%zz`;
    expect(created.protectText("s", payload)).toEqual({ ok: false, reason: "encoded_content" });
  });
});

describe("fail-closed content hazards", () => {
  it("masks encoded sensitive content regardless of the encoding flag (#48)", () => {
    const encoded = Buffer.from(KEY1).toString("base64");
    const withEncoding = createPseudonymizer(configWith({ encoding_detection: true }));
    const withoutEncoding = createPseudonymizer(configWith({ encoding_detection: false }));
    for (const created of [withEncoding, withoutEncoding]) {
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      const input = `deploy ${encoded} now`;
      const result = created.protectText("s", input);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.text).not.toContain(encoded);
      expect(result.text).toMatch(/^deploy \[SGP2:ENCODED-[a-z]{4}-[a-z]{4}-[a-z]{4}\] now$/);
      expect(created.restoreText("s", result.text)).toEqual({ ok: true, text: input });
    }
  });

  it("reports truncated strings as unscannable without creating mappings", () => {
    const config = configWith({ max_chars: 10 });
    const created = createPseudonymizer(config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    config.settings.max_chars = 200000;
    expect(created.isTextSafe("safe")).toBe(true);
    expect(created.isTextSafe("x".repeat(11))).toBe(false);
  });

  it("rejects content beyond the scanner per-string limit", () => {
    const created = createPseudonymizer(configWith({ max_chars: 32 }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.protectText("s", `${KEY1}${"x".repeat(40)}`)).toEqual({ ok: false, reason: "truncated_content" });
  });

  it("refuses zero-width characters only when they hide a finding", () => {
    const ps = makeService();
    const hidden = `note ${KEY1.slice(0, 10)}\u200B${KEY1.slice(10)}`;
    expect(ps.protectText("s", hidden)).toEqual({ ok: false, reason: "unicode_evasion" });

    const harmless = ps.protectText("s", `note\u200B ${KEY1}`);
    expect(harmless.ok).toBe(true);
    if (harmless.ok) {
      expect(harmless.text).not.toContain(KEY1);
      expect(harmless.text.startsWith("note\u200B [SGP2:API_KEY-")).toBe(true);
    }
    const longUnicode = `\u200B${"y".repeat(80)}`;
    expect(ps.protectText("s", longUnicode)).toEqual({ ok: true, text: longUnicode });
  });

  it("refuses look-alike letters only when they hide a finding (#46)", () => {
    const ps = makeService();
    const locale = 'export const ru = { apiKey: "Неверный ключ API", token: "Токен истёк" };';
    expect(ps.protectText("s", locale)).toEqual({ ok: true, text: locale });

    const disguised = `note s\u03BA${KEY1.slice(2)}`;
    expect(ps.protectText("s", disguised)).toEqual({ ok: false, reason: "unicode_evasion" });
  });

  it("refuses an encoded secret disguised with a look-alike letter (#46)", () => {
    const ps = makeService();
    const encoded = Buffer.from(`api key ${KEY1}`).toString("base64");
    const index = encoded.indexOf("a", 12);
    const disguised = `${encoded.slice(0, index)}\u0430${encoded.slice(index + 1)}`;
    expect(ps.protectText("s", `api key: ${disguised}`).ok).toBe(false);
  });

  it.each([
    ["a Luhn-shaped number followed by a BigInt suffix", "birthtimeMs: 1318289051000.1,\natimeMs: 1318289051000n,", "1318289051000"],
    ["a public IPv4 glued to a leading digit", 'ipv4.parse("1213.174.246.205");\nipv6.parse("213.174.246.205");', "213.174.246.205"],
    ["an email the remote-URL classifier skips", "// username@hostname.com:user/repo\n// proto://username@hostname.com:user/repo", "username@hostname.com"],
  ])("masks undetected repeats of a detected value instead of refusing: %s (#52)", (_name, text, value) => {
    const ps = makeService();
    const result = ps.protectText("s", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain(value);
    const tokens = tokensIn(result.text);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tokens).size).toBe(1);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text });
  });

  it.each([
    ["the detected string comes first", ["ipv6.parse(\"213.174.246.205\")", "ipv4.parse(\"1213.174.246.205\")"]],
    ["the undetected repeat comes first", ["ipv4.parse(\"1213.174.246.205\")", "ipv6.parse(\"213.174.246.205\")"]],
  ])("masks undetected repeats across strings of one JSON request when %s (#52)", (_name, parts) => {
    const ps = makeService();
    const input = { messages: parts.map((content) => ({ role: "user", content })) };
    const result = ps.protectJsonForModel("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("213.174.246.205");
    expect(new Set(tokensIn(serialized)).size).toBe(1);
    expect(ps.restoreJson("s", result.value)).toEqual({ ok: true, value: input });
  });

  it("refuses an encoded secret split by zero-width characters", () => {
    const ps = makeService();
    const encoded = Buffer.from(`api key ${KEY1}`).toString("base64");
    const split = `${encoded.slice(0, 12)}\u200B${encoded.slice(12)}`;
    const result = ps.protectText("s", `data: ${split}`);
    expect(result.ok).toBe(false);
  });

  it("dedups identical spans from different rules and unions real overlaps", () => {
    const overlapping = createPseudonymizer(
      configWith({}, [{ description: "overlap-inner", pattern: "Abcdef1234567890", severity: "LOW" }]),
    );
    expect(overlapping.ok).toBe(true);
    if (overlapping.ok) {
      // P1 (2026-10-06b): overlapping findings union-mask — one token covers
      // both spans; no refusal, no partially-covered tail left behind.
      const result = overlapping.protectText("s", KEY1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(tokensIn(result.text)).toHaveLength(1);
        expect(result.text).not.toContain(KEY1);
        expect(result.text).not.toContain("Abcdef1234567890");
      }
    }
    const identical = createPseudonymizer(
      configWith({}, [{ description: "same-span", pattern: "sk-[A-Za-z0-9\\-_]{20,120}", severity: "LOW" }]),
    );
    expect(identical.ok).toBe(true);
    if (!identical.ok) return;
    const result = identical.protectText("s", `use ${KEY1} now`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(tokensIn(result.text)).toHaveLength(1);
      expect(result.text).not.toContain(KEY1);
    }
  });

  it("maps scanner exceptions to a static failure without leaking details", () => {
    const throwingDetector = {
      fingerprint: "synthetic-throwing",
      findAll(): never {
        throw new Error("boom-sensitive-detail");
      },
    };
    const created = createPseudonymizer({
      ...baseConfig,
      exact_value_detector: throwingDetector as unknown as GuardConfig["exact_value_detector"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = created.protectText("s", `plain ${KEY1} text`);
    expect(result).toEqual({ ok: false, reason: "scanner_failure" });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("boom-sensitive-detail");
    expect(serialized).not.toContain(KEY1);
  });

  it("failure results contain only the static reason", () => {
    const ps = makeService();
    const result = ps.protectText("s", `see ${FOREIGN_TOKEN} ok`);
    expect(JSON.stringify(result)).toBe('{"ok":false,"reason":"unknown_token"}');
  });
});

describe("budgets and atomicity", () => {
  it("does not consume sessions for safe plaintext", () => {
    const ps = makeService({ maxSessions: 1 });
    expect(ps.protectText("one", KEY1).ok).toBe(true);
    expect(ps.protectText("two", "completely safe text").ok).toBe(true);
    expect(ps.protectText("two", "still safe").ok).toBe(true);
    const exhausted = ps.protectText("two", KEY2);
    expect(exhausted).toEqual({ ok: false, reason: "session_limit" });
    ps.clearSession("one");
    expect(ps.protectText("two", KEY2).ok).toBe(true);
  });

  it("enforces per-session entry limits without evicting live mappings", () => {
    const ps = makeService({ maxEntriesPerSession: 2 });
    expect(ps.protectText("s", KEY1).ok).toBe(true);
    expect(ps.protectText("s", KEY2).ok).toBe(true);
    expect(ps.protectText("s", KEY1).ok).toBe(true); // idempotent, no new entry
    const third = ps.protectText("s", "sk-ThirdkeyAaaBbbCccDddEe");
    expect(third).toEqual({ ok: false, reason: "entry_limit" });
    const roundtrip = ps.protectText("s", `${KEY1} ${KEY2}`);
    expect(roundtrip.ok).toBe(true);
    if (roundtrip.ok) {
      expect(ps.restoreText("s", roundtrip.text)).toEqual({ ok: true, text: `${KEY1} ${KEY2}` });
    }
  });

  it("enforces per-session unit capacity", () => {
    // One entry charges 27 + 49 + 64 = 140 units; the second exceeds 150.
    const ps = makeService({ maxSessionUnits: 150 });
    expect(ps.protectText("s", KEY1).ok).toBe(true);
    expect(ps.protectText("s", KEY2)).toEqual({ ok: false, reason: "session_capacity" });
  });

  it("enforces aggregate entry capacity across sessions", () => {
    const ps = makeService({ maxEntriesTotal: 3 });
    expect(ps.protectText("a", KEY1).ok).toBe(true);
    expect(ps.protectText("a", KEY2).ok).toBe(true);
    expect(ps.protectText("b", KEY1).ok).toBe(true);
    expect(ps.protectText("b", KEY2)).toEqual({ ok: false, reason: "aggregate_capacity" });
    const again = ps.protectText("a", KEY1);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(ps.restoreText("a", again.text)).toEqual({ ok: true, text: KEY1 });
    }
  });

  it("enforces per-operation unit limits", () => {
    const ps = makeService({ maxUnitsPerOperation: 64 });
    const result = ps.protectText("s", `call ${KEY1} now`);
    expect(result).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("refuses oversized text expansion with operation_limit before building or rescanning output", () => {
    // Oracle repro: custom Q rule, scanner limit 100, operation limit 100.
    // Forty Qs separated by spaces are a 79-unit input whose prospective
    // substituted output is 79 + 40*(48-1) = 1,959 units. Building the
    // output first would hit the scanner limit and report
    // truncated_content; the pre-allocation guard must report
    // operation_limit without ever materializing the expansion.
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createPseudonymizer(configWith({ max_chars: 100 }, [qRule]), {
      maxUnitsPerOperation: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const payload = Array.from({ length: 40 }, () => "Q").join(" ");
    expect(payload).toHaveLength(79);
    expect(created.protectText("s", payload)).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("rolls back the text transaction refused by the protect pre-allocation guard", () => {
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createPseudonymizer(configWith({ max_chars: 100 }, [qRule]), {
      maxUnitsPerOperation: 100,
      maxSessions: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oversized = Array.from({ length: 40 }, () => "Q").join(" ");
    expect(created.protectText("a", oversized)).toEqual({ ok: false, reason: "operation_limit" });
    // The refused operation must not commit its staged session or
    // capacity: with maxSessions 1 a fresh session still fits.
    const fresh = created.protectText("b", "Q");
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(tokensIn(fresh.text)).toHaveLength(1);
    expect(tokensIn(fresh.text)[0]).toMatch(/^\[SGP2:CUSTOM-[a-z]{4}-[a-z]{4}-[a-z]{4}\]$/);
    expect(created.restoreText("b", fresh.text)).toEqual({ ok: true, text: "Q" });
  });

  it("refuses JSON token expansion against the remaining aggregate budget before construction", () => {
    // Oracle repro: scanner limit 40, operation limit 100. Before the
    // second string's output the aggregate charge is 95 units, leaving 5 —
    // not enough for the 48-unit token. The refusal must happen before the
    // token output is built and rescanned (which would report
    // truncated_content under the 40-unit scanner limit).
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createPseudonymizer(configWith({ max_chars: 40 }, [qRule]), {
      maxUnitsPerOperation: 100,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.protectJson("s", ["x".repeat(35), "Q"]))
      .toEqual({ ok: false, reason: "operation_limit" });
  });

  it("rolls back the JSON transaction refused by the protect pre-allocation guard", () => {
    const qRule = { description: "q-marker", pattern: "Q", severity: "HIGH" as const };
    const created = createPseudonymizer(configWith({ max_chars: 100 }, [qRule]), {
      maxUnitsPerOperation: 100,
      maxSessions: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.protectJson("a", ["x".repeat(35), "Q"]))
      .toEqual({ ok: false, reason: "operation_limit" });
    // "a" never committed (maxSessions 1).
    const fresh = created.protectJson("b", "Q");
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(String(fresh.value)).toMatch(/^\[SGP2:CUSTOM-[a-z]{4}-[a-z]{4}-[a-z]{4}\]$/);
    expect(created.restoreJson("b", fresh.value)).toEqual({ ok: true, value: "Q" });
  });

  it("rolls back a failed multi-mapping text operation atomically", () => {
    const ps = makeService({ maxSessions: 1, maxEntriesPerSession: 1 });
    const both = ps.protectText("a", `x ${KEY1} y ${KEY2} z`);
    expect(both).toEqual({ ok: false, reason: "entry_limit" });
    // If "a" had been committed, session b would now hit session_limit.
    expect(ps.protectText("b", KEY1).ok).toBe(true);
  });

  it("rolls back a failed JSON operation after an earlier node staged mappings", () => {
    const ps = makeService({ maxSessions: 1 });
    const input = {
      first: KEY1,
      bad: {} as Record<string, string>,
    };
    Object.defineProperty(input.bad, "boom", {
      get(): string {
        throw new Error("never invoked");
      },
      enumerable: true,
    });
    const result = ps.protectJson("a", input);
    expect(result).toEqual({ ok: false, reason: "unsafe_structure" });
    expect(ps.protectText("b", KEY1).ok).toBe(true);
  });

  it("bounds restored output growth", () => {
    const longSecret = `KNOWN${"a".repeat(4000)}`;
    const created = createPseudonymizer(
      { ...baseConfig, exact_value_detector: new ExactValueDetector([longSecret]) },
      { maxUnitsPerOperation: 10000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedOnce = created.protectText("s", `v ${longSecret}`);
    expect(protectedOnce.ok).toBe(true);
    if (!protectedOnce.ok) return;
    const token = tokensIn(protectedOnce.text)[0];
    expect(token).toBeTruthy();
    const repeated = Array.from({ length: 30 }, () => token).join(" ");
    const restored = created.restoreText("s", repeated);
    expect(restored).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("refuses oversized restore expansion before materializing it", () => {
    // Oracle repro shape: 4,005-unit original, 30 token repetitions, 10,000 budget.
    const longSecret = `KNOWN${"a".repeat(4000)}`;
    const created = createPseudonymizer(
      { ...baseConfig, exact_value_detector: new ExactValueDetector([longSecret]) },
      { maxUnitsPerOperation: 10000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedOnce = created.protectText("s", `v ${longSecret}`);
    expect(protectedOnce.ok).toBe(true);
    if (!protectedOnce.ok) return;
    const token = tokensIn(protectedOnce.text)[0];
    expect(token).toBeTruthy();
    const repeated = Array.from({ length: 30 }, () => token).join(" ");
    // Early-refusal seam: piece charging breaches the budget BEFORE the
    // scan loop reaches the trailing malformed token, so the failure is
    // operation_limit. A join-then-check implementation would complete the
    // loop and report malformed_token instead.
    expect(created.restoreText("s", `${repeated} ${MALFORMED_TOKEN}`))
      .toEqual({ ok: false, reason: "operation_limit" });
    // Without budget pressure the malformed token is still reported.
    expect(created.restoreText("s", `ok ${MALFORMED_TOKEN}`))
      .toEqual({ ok: false, reason: "malformed_token" });
  });

  it("propagates the remaining JSON aggregate budget and refuses growth before materializing it", () => {
    const longSecret = `KNOWN${"a".repeat(4000)}`;
    const created = createPseudonymizer(
      { ...baseConfig, exact_value_detector: new ExactValueDetector([longSecret]) },
      { maxUnitsPerOperation: 10000 },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedOnce = created.protectText("s", longSecret);
    expect(protectedOnce.ok).toBe(true);
    if (!protectedOnce.ok) return;
    const token = tokensIn(protectedOnce.text)[0];
    expect(token).toBeTruthy();
    // The first node's restored output fits the aggregate budget alone.
    expect(created.restoreJson("s", [token])).toEqual({ ok: true, value: [longSecret] });
    // Earlier strings consumed the budget: the second node's expansion is
    // refused while charging pieces, before its malformed suffix is scanned
    // (a per-string-only check would report malformed_token here).
    const second = `${token} ${token} ${token} ${MALFORMED_TOKEN}`;
    expect(created.restoreJson("s", [token, second]))
      .toEqual({ ok: false, reason: "operation_limit" });
  });

  it("charges token-free restore output combined with the input", () => {
    const tight = makeService({ maxUnitsPerOperation: 10 });
    expect(tight.restoreText("s", "abcdef")).toEqual({ ok: false, reason: "operation_limit" }); // 6+6 > 10
    const boundary = makeService({ maxUnitsPerOperation: 12 });
    expect(boundary.restoreText("s", "abcdef")).toEqual({ ok: true, text: "abcdef" }); // exact boundary
    // UTF-16 code-unit accounting: astral characters count two units each.
    const astral = makeService({ maxUnitsPerOperation: 12 });
    expect(astral.restoreText("s", "\u{1F600}".repeat(6)))
      .toEqual({ ok: false, reason: "operation_limit" }); // 12 units in, 12 out
    expect(astral.restoreText("s", "\u{1F600}".repeat(3)))
      .toEqual({ ok: true, text: "\u{1F600}".repeat(3) }); // 6 + 6 = 12
  });

  it("restores a shrinking marker at the exact combined text budget", () => {
    // Oracle: an 8-unit exact marker becomes a category-labelled v2 token
    // whose length varies with the label, so the exact combined budget is
    // derived from a probe mint (the label is deterministic). Charging the
    // unchanged input length as output would demand marker+token both ways.
    const MARKER = "MarkerXY";
    const detector = () => new ExactValueDetector([MARKER]);
    const probe = createPseudonymizer({ ...baseConfig, exact_value_detector: detector() });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const probed = probe.protectText("probe", MARKER);
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    expect(probed.text).toMatch(/^\[SGP2:/);
    const tokenUnits = probed.text.length; // the whole output is the token
    const exact = MARKER.length + tokenUnits;
    const created = createPseudonymizer(
      { ...baseConfig, exact_value_detector: detector() },
      { maxUnitsPerOperation: exact },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedText = created.protectText("s", MARKER);
    expect(protectedText.ok).toBe(true);
    if (!protectedText.ok) return;
    expect(protectedText.text).toHaveLength(tokenUnits);
    expect(created.restoreText("s", protectedText.text)).toEqual({ ok: true, text: MARKER });
    // One unit below the boundary the same protection is refused.
    const below = createPseudonymizer(
      { ...baseConfig, exact_value_detector: detector() },
      { maxUnitsPerOperation: exact - 1 },
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.protectText("s", MARKER)).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("roundtrips a shrinking scalar JSON string at the exact aggregate budget", () => {
    // Scalar root: 8 (node overhead) + token input leaves exactly the
    // 8-unit original within the derived budget. The v2 token length varies
    // with its category label, so the exact budget comes from a probe mint.
    const MARKER = "MarkerXY";
    const probe = createPseudonymizer({
      ...baseConfig,
      exact_value_detector: new ExactValueDetector([MARKER]),
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    const probed = probe.protectText("probe", MARKER);
    expect(probed.ok).toBe(true);
    if (!probed.ok) return;
    const tokenUnits = probed.text.length;
    const exact = 8 + tokenUnits + MARKER.length;
    const created = createPseudonymizer(
      { ...baseConfig, exact_value_detector: new ExactValueDetector([MARKER]) },
      { maxUnitsPerOperation: exact },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const protectedScalar = created.protectJson("s", MARKER);
    expect(protectedScalar.ok).toBe(true);
    if (!protectedScalar.ok) return;
    expect(String(protectedScalar.value)).toMatch(/^\[SGP2:/);
    expect(created.restoreJson("s", protectedScalar.value)).toEqual({ ok: true, value: MARKER });
    // One unit lower, the same scalar protection is refused.
    const below = createPseudonymizer(
      { ...baseConfig, exact_value_detector: new ExactValueDetector([MARKER]) },
      { maxUnitsPerOperation: exact - 1 },
    );
    expect(below.ok).toBe(true);
    if (!below.ok) return;
    expect(below.protectJson("s", MARKER)).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("aggregates JSON plaintext output charges across nodes exactly once", () => {
    // ["ab"]: 8 (array node) + 8 + 2 (string node + input) + 2 (output) = 20.
    const single = makeService({ maxUnitsPerOperation: 20 });
    expect(single.restoreJson("s", ["ab"])).toEqual({ ok: true, value: ["ab"] });
    const singleOver = makeService({ maxUnitsPerOperation: 19 });
    expect(singleOver.restoreJson("s", ["ab"])).toEqual({ ok: false, reason: "operation_limit" });
    // ["ab","cd"]: 8 + (8+2+2) + (8+2+2) = 32 — the second node's output
    // charge is what crosses 31, proving multi-node aggregation.
    const multi = makeService({ maxUnitsPerOperation: 32 });
    expect(multi.restoreJson("s", ["ab", "cd"])).toEqual({ ok: true, value: ["ab", "cd"] });
    const multiOver = makeService({ maxUnitsPerOperation: 31 });
    expect(multiOver.restoreJson("s", ["ab", "cd"])).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("keeps unrelated sessions usable after another session hits a limit", () => {
    const ps = makeService({ maxSessions: 2 });
    expect(ps.protectText("a", KEY1).ok).toBe(true);
    expect(ps.protectText("b", KEY2).ok).toBe(true);
    expect(ps.protectText("c", KEY1)).toEqual({ ok: false, reason: "session_limit" });
    const stillFine = ps.protectText("a", `${KEY1} again`);
    expect(stillFine.ok).toBe(true);
    if (stillFine.ok) {
      expect(ps.restoreText("a", stillFine.text)).toEqual({ ok: true, text: `${KEY1} again` });
    }
  });
});

describe("strict JSON operations", () => {
  it("protects and restores nested keys and values atomically", () => {
    const ps = makeService();
    const input = {
      [EMAIL1]: `reaches ${KEY1}`,
      nested: { list: [KEY2, "safe", { deep: EMAIL1 }] },
    };
    const snapshot = structuredClone(input);
    const protectedJson = ps.protectJson("s", input);
    expect(protectedJson.ok).toBe(true);
    if (!protectedJson.ok) return;
    expect(JSON.stringify(protectedJson.value)).not.toContain(KEY1);
    expect(JSON.stringify(protectedJson.value)).not.toContain(KEY2);
    expect(JSON.stringify(protectedJson.value)).not.toContain(EMAIL1);
    const restored = ps.restoreJson("s", protectedJson.value);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });

  it("handles scalar roots and passes finite numbers through", () => {
    const ps = makeService();
    expect(ps.protectJson("s", `plain ${KEY1}`)).toMatchObject({ ok: true });
    const numProtected = ps.protectJson("s", 42);
    expect(numProtected).toEqual({ ok: true, value: 42 });
    expect(ps.restoreJson("s", 42)).toEqual({ ok: true, value: 42 });
    expect(ps.protectJson("s", KEY1)).toMatchObject({ ok: true });
  });

  it("treats __proto__ as a safe own key without polluting prototypes", () => {
    const ps = makeService();
    const input = JSON.parse('{"__proto__": "x sk-Abcdef1234567890abcdef y"}');
    const protectedJson = ps.protectJson("s", input);
    expect(protectedJson.ok).toBe(true);
    if (!protectedJson.ok) return;
    const output = protectedJson.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    const descriptor = Object.getOwnPropertyDescriptor(output, "__proto__");
    expect(descriptor?.enumerable).toBe(true);
    expect(String(descriptor?.value)).not.toContain(KEY1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const restored = ps.restoreJson("s", output);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(Object.getOwnPropertyDescriptor(restored.value as object, "__proto__")?.value)
      .toBe("x sk-Abcdef1234567890abcdef y");
  });

  it("accepts null-prototype objects", () => {
    const ps = makeService();
    const input = Object.assign(Object.create(null), { note: KEY1 });
    const protectedJson = ps.protectJson("s", input);
    expect(protectedJson.ok).toBe(true);
    if (!protectedJson.ok) return;
    const output = protectedJson.value as Record<string, unknown>;
    expect(String(output.note)).not.toContain(KEY1);
    const restored = ps.restoreJson("s", output);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect((restored.value as Record<string, unknown>).note).toBe(KEY1);
  });

  it("detects key collisions when distinct keys tokenize to the same output key", () => {
    const ps = makeService();
    const first = ps.protectText("s", KEY1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const tokenKey = first.text; // exactly the issued token
    expect(ps.protectJson("s", { [KEY1]: "v", [tokenKey]: "w" }))
      .toEqual({ ok: false, reason: "key_collision" });
    expect(ps.restoreJson("s", { [tokenKey]: 1, [KEY1]: 2 }))
      .toEqual({ ok: false, reason: "key_collision" });
  });

  it("rejects sparse arrays and arrays with unexpected properties", () => {
    const ps = makeService();
    const sparse = [KEY1, KEY2];
    delete sparse[0];
    expect(ps.protectJson("s", sparse)).toEqual({ ok: false, reason: "unsafe_structure" });
    const withExtra = [KEY1] as unknown as Record<string, string> & string[];
    withExtra.extra = "unexpected";
    expect(ps.protectJson("s", withExtra)).toEqual({ ok: false, reason: "unsafe_structure" });
  });

  it("rejects cycles but clones shared non-cyclic references", () => {
    const ps = makeService();
    const cyclic: Record<string, unknown> = { note: KEY1 };
    cyclic.self = cyclic;
    expect(ps.protectJson("s", cyclic)).toEqual({ ok: false, reason: "unsafe_structure" });

    const shared: Record<string, unknown> = { v: KEY1 };
    const input = { a: shared, b: shared };
    const snapshot = structuredClone(input);
    const protectedJson = ps.protectJson("s", input);
    expect(protectedJson.ok).toBe(true);
    if (!protectedJson.ok) return;
    const output = protectedJson.value as Record<string, unknown>;
    expect(output.a).not.toBe(output.b);
    expect(output.a).toEqual(output.b);
    const restored = ps.restoreJson("s", output);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });

  it("rejects accessors and proxies without invoking their traps", () => {
    const ps = makeService();
    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, "x", {
      get(): string {
        throw new Error("getter must not run");
      },
      enumerable: true,
    });
    expect(ps.protectJson("s", withGetter)).toEqual({ ok: false, reason: "unsafe_structure" });

    const proxyTarget: Record<string, unknown> = { x: KEY1 };
    const proxied = new Proxy(proxyTarget, {
      get(): never {
        throw new Error("trap must not run");
      },
      getPrototypeOf(): never {
        throw new Error("trap must not run");
      },
      ownKeys(): never {
        throw new Error("trap must not run");
      },
    });
    expect(ps.protectJson("s", proxied)).toEqual({ ok: false, reason: "unsafe_structure" });
    expect(ps.restoreJson("s", proxied)).toEqual({ ok: false, reason: "unsafe_structure" });
  });

  it("rejects symbol keys and unsupported value types", () => {
    const ps = makeService();
    const withSymbol: Record<string, unknown> = { ok: KEY1 };
    (withSymbol as Record<PropertyKey, unknown>)[Symbol("hidden")] = KEY1;
    expect(ps.protectJson("s", withSymbol)).toEqual({ ok: false, reason: "unsafe_structure" });

    for (const unsupported of [
      undefined,
      NaN,
      Infinity,
      1n,
      () => "fn",
      Symbol("standalone"),
      new Date(0),
      new Map(),
    ]) {
      expect(ps.protectJson("s", unsupported)).toEqual({ ok: false, reason: "unsafe_structure" });
      expect(ps.restoreJson("s", unsupported)).toEqual({ ok: false, reason: "unsafe_structure" });
    }
  });

  it("enforces depth and node budgets", () => {
    const shallow = makeService({ maxDepth: 3 });
    expect(shallow.protectJson("s", { a: { b: { c: 1 } } }).ok).toBe(true);
    expect(shallow.protectJson("s", { a: { b: { c: { d: 1 } } } }))
      .toEqual({ ok: false, reason: "operation_limit" });

    const tiny = makeService({ maxNodes: 5 });
    const wide = { p1: "a", p2: "b", p3: "c", p4: "d", p5: "e", p6: "f" };
    expect(tiny.protectJson("s", wide)).toEqual({ ok: false, reason: "operation_limit" });
  });

  it("fails a whole restore when any nested string or key holds an unknown token", () => {
    const ps = makeService();
    const okFirst = ps.protectJson("s", { a: KEY1 });
    expect(okFirst.ok).toBe(true);
    const payload = {
      safe: "text",
      nested: { list: ["fine", { deep: FOREIGN_TOKEN }] },
    };
    const result = ps.restoreJson("s", payload);
    expect(result).toEqual({ ok: false, reason: "unknown_token" });
    const keyPayload = { [FOREIGN_TOKEN]: "value" };
    expect(ps.restoreJson("s", keyPayload)).toEqual({ ok: false, reason: "unknown_token" });
  });

  it("keeps protect input unchanged on failure and success", () => {
    const ps = makeService();
    const failing = { a: KEY1, bad: new Date(0) };
    const failingSnapshot = { a: failing.a, bad: failing.bad };
    expect(ps.protectJson("s", failing)).toEqual({ ok: false, reason: "unsafe_structure" });
    expect(failing).toEqual(failingSnapshot);
  });
});

describe("durable validated configuration", () => {
  it("ignores post-construction settings mutation (max_chars = NaN)", () => {
    const config = configWith({ max_chars: 64 });
    const created = createPseudonymizer(config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    config.settings.max_chars = Number.NaN;
    // With a caller-owned config this mutation makes the length bound a NaN
    // comparison and the raw credential sails through; the snapshot keeps
    // rejecting it as truncated.
    expect(created.protectText("s", `${KEY1}${"x".repeat(40)}`))
      .toEqual({ ok: false, reason: "truncated_content" });
    expect(created.protectText("s", KEY1).ok).toBe(true);
  });

  it("keeps rules active after the caller removes or rewrites them", () => {
    const config = configWith(
      {},
      [{ description: "marker", pattern: "CorpConfidentialMarker99", severity: "HIGH" as const }],
    );
    const created = createPseudonymizer(config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    config.custom_rules.length = 0;
    const afterRemoval = created.protectText("s", "share CorpConfidentialMarker99 now");
    expect(afterRemoval.ok).toBe(true);
    if (afterRemoval.ok) {
      expect(afterRemoval.text).not.toContain("CorpConfidentialMarker99");
    }
    config.custom_rules.push({ description: "marker", pattern: "CorpConfidentialMarker99", severity: "HIGH" });
    config.custom_rules[0].pattern = "willnotmatchanything";
    const afterRewrite = created.protectText("s", "share CorpConfidentialMarker99 now");
    expect(afterRewrite.ok).toBe(true);
    if (afterRewrite.ok) {
      expect(afterRewrite.text).not.toContain("CorpConfidentialMarker99");
    }
  });

  it("does not adopt rules pushed after construction", () => {
    const config = configWith({});
    const created = createPseudonymizer(config);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    config.custom_rules.push({ description: "late", pattern: "LateArrivalMarker77", severity: "HIGH" });
    // The snapshot has no such rule, so the marker is plain safe text.
    expect(created.protectText("s", "LateArrivalMarker77 stays"))
      .toEqual({ ok: true, text: "LateArrivalMarker77 stays" });
  });

  it("keeps exact-value detection after post-construction instance and prototype detector patches", () => {
    const MARKER = "OfflineDetectorOnlyMarkerXYZ";
    const detector = new ExactValueDetector([MARKER]);
    const created = createPseudonymizer({ ...baseConfig, exact_value_detector: detector });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Cold: instance patch before any operation ever runs.
    detector.findAll = () => [];
    const cold = created.protectText("s", `v ${MARKER} v`);
    expect(cold.ok).toBe(true);
    if (!cold.ok) return;
    expect(cold.text).not.toContain(MARKER);
    expect(tokensIn(cold.text)).toHaveLength(1);

    // Warm: the same patched instance after mappings have committed.
    const warm = created.protectText("s", `w ${MARKER} w`);
    expect(warm.ok).toBe(true);
    if (!warm.ok) return;
    expect(warm.text).not.toContain(MARKER);
    expect(tokensIn(warm.text)).toHaveLength(1);

    // Prototype patch after creation, with the instance patch removed so
    // prototype lookup is the live path for an un-snapshotted detector.
    Reflect.deleteProperty(detector, "findAll");
    const original = ExactValueDetector.prototype.findAll;
    try {
      ExactValueDetector.prototype.findAll = function (): [] {
        return [];
      };
      const protoPatched = created.protectText("s", `p ${MARKER} p`);
      expect(protoPatched.ok).toBe(true);
      if (!protoPatched.ok) return;
      expect(protoPatched.text).not.toContain(MARKER);
      expect(tokensIn(protoPatched.text)).toHaveLength(1);
    } finally {
      ExactValueDetector.prototype.findAll = original;
    }
  });

  it("fails statically when the detector has no callable scanner-facing findAll", () => {
    const broken = { fingerprint: "synthetic-without-findAll" };
    expect(createPseudonymizer({
      ...baseConfig,
      exact_value_detector: broken as unknown as GuardConfig["exact_value_detector"],
    })).toEqual({ ok: false, reason: "STATIC_CODE" });
  });
});

// ─── P1 (2026-10-06b): union masking + whole-marker replacement ──────────────

describe("P1 best-effort masking (2026-10-06b policy revision)", () => {
  it("unions partially overlapping findings into one covering token with exact roundtrip", () => {
    const svc = createPseudonymizer(
      configWith({}, [
        { description: "rule-a", pattern: "SUBJECT-ONE-REGION", severity: "LOW" },
        { description: "rule-b", pattern: "ONE-REGION-END", severity: "LOW" },
      ]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const result = svc.protectText("s", "pre SUBJECT-ONE-REGION-END post");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One token covers the union [rule-a.start, rule-b.end); no tail dropped.
    expect(tokensIn(result.text)).toHaveLength(1);
    expect(result.text).not.toContain("SUBJECT-ONE-REGION");
    expect(result.text).not.toContain("ONE-REGION-END");
    const token = tokensIn(result.text)[0];
    expect(svc.restoreText("s", token)).toEqual({
      ok: true,
      text: "SUBJECT-ONE-REGION-END",
    });
  });

  it("keeps the outer span for containment overlaps", () => {
    const svc = createPseudonymizer(
      configWith({}, [
        { description: "outer", pattern: "SECRET-CONTAINER-TEXT", severity: "LOW" },
        { description: "inner", pattern: "CONTAINER", severity: "LOW" },
      ]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const result = svc.protectText("s", "x SECRET-CONTAINER-TEXT y");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tokensIn(result.text)).toHaveLength(1);
    expect(result.text).not.toContain("SECRET-CONTAINER-TEXT");
    expect(result.text).not.toContain("CONTAINER");
  });

  it("merges transitively overlapping chains into one span", () => {
    const svc = createPseudonymizer(
      configWith({}, [
        { description: "chain-a", pattern: "AAA-BBB", severity: "LOW" },
        { description: "chain-b", pattern: "BBB-CCC", severity: "LOW" },
        { description: "chain-c", pattern: "CCC-DDD", severity: "LOW" },
      ]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const result = svc.protectText("s", "x AAA-BBB-CCC-DDD y");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tokensIn(result.text)).toHaveLength(1);
    expect(result.text).not.toContain("AAA-BBB");
    expect(result.text).not.toContain("BBB-CCC");
    expect(result.text).not.toContain("CCC-DDD");
    const token = tokensIn(result.text)[0];
    expect(svc.restoreText("s", token)).toEqual({ ok: true, text: "AAA-BBB-CCC-DDD" });
  });

  it("replaces a whole preserved marker when a finding touches its payload (no nesting)", () => {
    // A prefix is not proof of trust: the payload still scans, and a hit
    // replaces the ENTIRE marker as one unit — never a token nested inside
    // the marker text (the corruption seen in the 02:23 replay).
    const svc = createPseudonymizer(
      configWith({}, [{ description: "hex-payload", pattern: "deadbeefdeadbeef", severity: "LOW" }]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const result = svc.protectTextForModel("s", `keep ${FOREIGN_TOKEN} here`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(tokensIn(result.text)).toHaveLength(1);
    expect(result.text).not.toContain(FOREIGN_TOKEN);
    expect(result.text).not.toContain("deadbeefdeadbeef");
    // No nested-marker corruption ([SGP1:…[SGP1:…]): exactly one flat token.
    expect(result.text).not.toMatch(/\[SGP1:[^\]]*\[SGP1:/);
    const token = tokensIn(result.text)[0];
    expect(svc.restoreTextForDisplay("s", token)).toEqual({ ok: true, text: FOREIGN_TOKEN });
  });

  it("still masks secrets after a bare prefix with no closing bracket", () => {
    // Malformed/bare-prefix text is ordinary text: no exemption for what
    // follows the unterminated prefix (P1: 不因缺少結尾而豁免後續文字).
    const svc = createPseudonymizer(
      configWith({}, [{ description: "hex-payload", pattern: "deadbeefdeadbeef", severity: "LOW" }]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const result = svc.protectTextForModel(
      "s",
      "note [SGP1:deadbeefdeadbeef and plain deadbeefdeadbeef too",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("deadbeefdeadbeef");
    expect(result.text).toContain("[SGP1:");
    expect(tokensIn(result.text)).toHaveLength(2);
  });

  it("passes a seq-1332 shaped replay: overlapping findings no longer fail the request", () => {
    const svc = createPseudonymizer(
      configWith({}, [
        { description: "cred", pattern: "sk-[A-Za-z0-9\\-_]{20,120}", severity: "HIGH" },
        { description: "kw-overlap", pattern: "KEYWORD-OVERLAP-sk", severity: "LOW" },
      ]),
    );
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const text = "leak KEYWORD-OVERLAP-sk-QwertyuiopAsdfghjklZx tail";
    const result = svc.protectTextForModel("s", text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("KEYWORD-OVERLAP");
    expect(result.text).not.toContain("sk-QwertyuiopAsdfghjklZx");
    expect(tokensIn(result.text)).toHaveLength(1);
  });
});

describe("encoded runs are masked when their source span is attributable (#48)", () => {
  const ENCODED_TOKEN = /\[SGP2:ENCODED-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;

  it("masks a percent-encoded email and restores the exact original", () => {
    const ps = makeService();
    const result = ps.protectText("s", "user%40example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(/^\[SGP2:ENCODED-[a-z]{4}-[a-z]{4}-[a-z]{4}\]$/);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: "user%40example.com" });
    // The plain form still masks under its own category.
    const plain = ps.protectText("s", EMAIL1);
    expect(plain.ok && tokensIn(plain.text)[0]).toMatch(/^\[SGP2:PII_EMAIL-/);
  });

  it("masks only the encoded value inside a URL query string", () => {
    const ps = makeService();
    const input = "GET https://app.test/path?next=%2Fhome&mail=user%40example.com&page=2 HTTP/1.1";
    const result = ps.protectText("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith("GET https://app.test/path?next=%2Fhome&mail=[SGP2:ENCODED-")).toBe(true);
    expect(result.text.endsWith("]&page=2 HTTP/1.1")).toBe(true);
    expect(result.text).not.toContain("example.com");
    expect(result.text.match(ENCODED_TOKEN)).toHaveLength(1);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: input });
  });

  it("masks a plus-tagged local part in full, with no residual prefix", () => {
    const ps = makeService();
    const input = "mail=alice.smith+tag%40example.com!";
    const result = ps.protectText("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("alice");
    expect(result.text).not.toContain("tag");
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: input });
  });

  it("masks a local part longer than the 50-unit window in full, with no residual prefix", () => {
    const ps = makeService();
    const input = `mail=${"u".repeat(60)}%40example.com!`;
    const result = ps.protectText("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("uuuu");
    expect(result.text).not.toContain("example");
    expect(result.text.startsWith("mail=[SGP2:ENCODED-")).toBe(true);
    expect(result.text.endsWith("]!")).toBe(true);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: input });
  });

  it("masks the whole Base64 run of a key and restores exactly", () => {
    const ps = makeService();
    const encoded = Buffer.from(KEY1).toString("base64");
    const input = `blob=${encoded};end`;
    const result = ps.protectText("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toMatch(/^blob=\[SGP2:ENCODED-[a-z]{4}-[a-z]{4}-[a-z]{4}\];end$/);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: input });
  });

  it("masks the whole raw hex run of a key and restores exactly", () => {
    const ps = makeService();
    const hex = Buffer.from(KEY1).toString("hex");
    const input = `dump ${hex} end`;
    const result = ps.protectText("s", input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain(hex);
    expect(result.text.startsWith("dump [SGP2:")).toBe(true);
    expect(result.text.endsWith("] end")).toBe(true);
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: input });
  });

  it("leaves percent text that decodes to nothing sensitive unchanged", () => {
    const ps = makeService();
    const input = "q=hello%20world%21&path=%2Fusr%2Flocal";
    expect(ps.protectText("s", input)).toEqual({ ok: true, text: input });
  });

  it("masks an encoded email within 50 units of an owned token instead of refusing", () => {
    const ps = makeService();
    const issued = ps.protectText("s", KEY1);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const t = tokensIn(issued.text)[0];
    const result = ps.protectText("s", `${t} then user%40example.com`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.startsWith(`${t} then [SGP2:ENCODED-`)).toBe(true);
    expect(result.text).not.toContain("example.com");
    expect(ps.restoreText("s", result.text)).toEqual({ ok: true, text: `${KEY1} then user%40example.com` });
  });

  it("gives the same encoded value the same token", () => {
    const ps = makeService();
    const result = ps.protectText("s", "a=user%40example.com b=user%40example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tokens = tokensIn(result.text);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[0]).toMatch(/^\[SGP2:ENCODED-/);
  });

  it("still refuses an encoded run hidden by zero-width characters", () => {
    const ps = makeService();
    const encoded = Buffer.from(`api key ${KEY1}`).toString("base64");
    const split = `${encoded.slice(0, 12)}​${encoded.slice(12)}`;
    expect(ps.protectText("s", `data: ${split}`)).toEqual({ ok: false, reason: "encoded_content" });
  });

  it("still refuses an encoded run hidden by a look-alike letter", () => {
    const ps = makeService();
    const encoded = Buffer.from(`api key ${KEY1}`).toString("base64");
    const index = encoded.indexOf("a", 12);
    const disguised = `${encoded.slice(0, index)}а${encoded.slice(index + 1)}`;
    expect(ps.protectText("s", `api key: ${disguised}`)).toEqual({ ok: false, reason: "encoded_content" });
  });

  it("still refuses structural identifiers that carry an encoded secret", () => {
    const ps = makeService();
    const base64 = Buffer.from(KEY1).toString("base64");
    // Structural positions are never masked, so they are judged strictly.
    for (const value of ["user%40example.com", `k=${base64}`]) {
      expect(ps.isTextSafe(value)).toBe(false);
      expect(ps.isStructuralIdentifierSafe("s", value)).toBe(false);
    }
    expect(ps.isTextSafe("hello%20world")).toBe(true);
    // The same text as a JSON key is protected content and gets masked.
    const keyed = ps.protectJson("s", { "user%40example.com": "v" });
    expect(keyed.ok).toBe(true);
    if (keyed.ok) expect(Object.keys(keyed.value as object)[0]).toMatch(/^\[SGP2:ENCODED-/);
  });

  it("commits no mapping when a transaction that masked an encoded run is refused", () => {
    const created = createPseudonymizer(baseConfig, { maxSessions: 1 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const encoded = Buffer.from(`api key ${KEY1}`).toString("base64");
    const split = `${encoded.slice(0, 12)}​${encoded.slice(12)}`;
    const refused = created.protectText("a", `user%40example.com ${split}`);
    expect(refused.ok).toBe(false);
    // maxSessions 1: a committed session "a" would refuse "b" with session_limit.
    expect(created.protectText("b", "user%40example.com").ok).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyDeidentify,
  createSessionKey,
  deidentifyText,
  DEIDENTIFY_MARKER_PREFIX,
  ISSUED_PLACEHOLDER_LIMIT,
  placeholderFor,
} from "../src/decision/deidentify.js";
import { scanText } from "../src/scanner/engine.js";
import type { Finding, GuardConfig } from "../src/types.js";

const config: GuardConfig = {
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

const redactOptions = { mode: "redact" as const, context: "message text" };
const highKey = "sk-Abcdef1234567890abcdef";

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function emailFinding(text: string, start: number): Finding {
  return {
    type: "PII_EMAIL",
    severity: "MEDIUM",
    preview: "****",
    description: "Email 地址",
    match_start: start,
    match_end: start + text.length,
    match_text: text,
  };
}

describe("email de-identification (deidentifyText)", () => {
  it("maps the same address to one identical placeholder within a session", () => {
    const sessionKey = createSessionKey();
    const result = deidentifyText(
      "Contact alice@example.com today and alice@example.com again tomorrow.",
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    const placeholder = placeholderFor("alice@example.com", sessionKey);
    expect(countOccurrences(result.text, placeholder)).toBe(2);
    expect(result.text).not.toContain("alice@example.com");
    expect(result.totalFindings).toBe(2);
  });

  it("maps two different addresses to two different placeholders", () => {
    const sessionKey = createSessionKey();
    const result = deidentifyText(
      "alice@example.com and bob@example.com",
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    const alice = placeholderFor("alice@example.com", sessionKey);
    const bob = placeholderFor("bob@example.com", sessionKey);
    expect(alice).not.toBe(bob);
    expect(result.text).toContain(alice);
    expect(result.text).toContain(bob);
    expect(result.text).not.toContain("alice@example.com");
    expect(result.text).not.toContain("bob@example.com");
  });

  it("normalizes case variants of one address to the same placeholder", () => {
    const sessionKey = createSessionKey();
    const result = deidentifyText(
      "Alice@Example.COM wrote to alice@example.com.",
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    const placeholder = placeholderFor("alice@example.com", sessionKey);
    expect(countOccurrences(result.text, placeholder)).toBe(2);
    expect(result.text).not.toContain("Alice@Example.COM");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("redacts HIGH keys while de-identifying emails in the same unit", () => {
    const sessionKey = createSessionKey();
    const result = deidentifyText(
      `rotate ${highKey} then mail alice@example.com`,
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    expect(result.text).toContain("[REDACTED_API_KEY]");
    expect(result.text).toContain(placeholderFor("alice@example.com", sessionKey));
    expect(result.text).not.toContain(highKey);
    expect(result.text).not.toContain("alice@example.com");
  });

  it("blocks the whole unit when the scan is truncated", () => {
    const sessionKey = createSessionKey();
    const tinyConfig: GuardConfig = {
      ...config,
      settings: { ...config.settings, max_chars: 10 },
    };
    const result = deidentifyText("mail alice@example.com soon", tinyConfig, sessionKey, redactOptions);

    expect(result.action).toBe("block");
    expect(result.text).toContain("Sensitive Guard blocked");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("blocks the whole unit when any finding required encoding detection", () => {
    const sessionKey = createSessionKey();
    const encoded = Buffer.from(`token=${highKey}`, "utf8").toString("base64");
    const result = deidentifyText(
      `mail alice@example.com about ${encoded}`,
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("block");
    expect(result.text).toContain("Sensitive Guard blocked");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("delegates to protectText semantics for text without emails", () => {
    const sessionKey = createSessionKey();

    expect(deidentifyText("nothing sensitive here", config, sessionKey, redactOptions)).toEqual({
      action: "allow",
      text: "nothing sensitive here",
      totalFindings: 0,
    });

    const blocked = deidentifyText(`token=${highKey}`, config, sessionKey, {
      mode: "block",
      context: "message text",
    });
    expect(blocked.action).toBe("block");
    expect(blocked.text).not.toContain(highKey);
  });

  it("uses different placeholders for the same address across sessions", () => {
    const sessionKeyA = createSessionKey();
    const sessionKeyB = createSessionKey();

    expect(placeholderFor("alice@example.com", sessionKeyA)).not.toBe(
      placeholderFor("alice@example.com", sessionKeyB),
    );
  });

  it("does not reintroduce an address that sits inside another finding's match", () => {
    const sessionKey = createSessionKey();
    const wrapConfig: GuardConfig = {
      ...config,
      custom_rules: [
        {
          description: "contact line",
          pattern: "contact [a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}",
          severity: "MEDIUM",
        },
      ],
    };
    const result = deidentifyText(
      "please contact alice@example.com now",
      wrapConfig,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("applies placeholders even when the unit carries an in-text ignore directive (no model-boundary bypass)", () => {
    const sessionKey = createSessionKey();
    const email = "alice.canary@example-test.invalid";
    const result = deidentifyText(
      `reach ${email} // sg-ignore`,
      config,
      sessionKey,
      redactOptions,
    );

    expect(result.action).toBe("redact");
    expect(result.text).not.toContain(email);
    expect(result.text).toContain(placeholderFor(email, sessionKey));
  });

  it("blocks when a custom rule makes the marker shape itself scan-unsafe (rescan branch)", () => {
    const sessionKey = createSessionKey();
    // The placeholder prefix gets redacted to [REDACTED_CUSTOM], which the same
    // rule still matches: the verifier exempts findings inside its own
    // [REDACTED_*] markers, but deidentifyText's independent rescan must not.
    const markerConfig: GuardConfig = {
      ...config,
      custom_rules: [
        {
          description: "flags de-identify markers",
          pattern: "\\[SG-EMAIL-|\\[REDACTED_",
          severity: "HIGH",
        },
      ],
    };
    const result = deidentifyText("mail alice@example.com now", markerConfig, sessionKey, redactOptions);

    expect(result.action).toBe("block");
    expect(result.text).toContain("Sensitive Guard blocked");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("blocks when redaction verification comes back unverified (placeholder growth past max_chars)", () => {
    const sessionKey = createSessionKey();
    // "mail a@b.co ok" (14 chars) fits the limit, but substituting the
    // 26-char placeholder grows the unit past max_chars, so redactAndVerify
    // reports unverified and the whole unit must block.
    const boundaryConfig: GuardConfig = {
      ...config,
      settings: { ...config.settings, max_chars: 20 },
    };
    const result = deidentifyText("mail a@b.co ok", boundaryConfig, sessionKey, redactOptions);

    expect(result.action).toBe("block");
    expect(result.text).not.toContain("a@b.co");
  });

  it("blocks an unowned reserved marker instead of partially rewriting it", () => {
    const sessionKey = createSessionKey();
    const registry = new Set<string>();
    // Never issued by this session; its hex body embeds a phone-shaped run.
    const lookalike = "[SG-EMAIL-09469432970958a6]";

    const result = deidentifyText(`x ${lookalike} y`, config, sessionKey, redactOptions, registry);

    expect(result.action).toBe("block");
    expect(result.text).not.toContain(lookalike);
    expect(result.text).not.toContain("[REDACTED_");
  });

  it("fails closed instead of issuing a marker beyond the registry capacity", () => {
    const sessionKey = createSessionKey();
    const registry = new Set<string>();
    for (let index = 0; index < ISSUED_PLACEHOLDER_LIMIT; index++) {
      registry.add(`[SG-EMAIL-${index.toString(16).padStart(16, "0")}]`);
    }

    const result = deidentifyText("mail alice@example.com now", config, sessionKey, redactOptions, registry);

    expect(result.action).toBe("block");
    expect(result.text).not.toContain("alice@example.com");
  });

  it("does not consume registry capacity when the unit is blocked", () => {
    const sessionKey = createSessionKey();
    // A custom rule flags the marker shape, so verification fails and the unit
    // blocks — but ownership must not have been retained.
    const markerConfig: GuardConfig = {
      ...config,
      custom_rules: [{ description: "flags markers", pattern: "\\[SG-EMAIL-", severity: "HIGH" }],
    };
    const registry = new Set<string>();

    const result = deidentifyText("mail alice@example.com now", markerConfig, sessionKey, redactOptions, registry);

    expect(result.action).toBe("block");
    expect(registry.size).toBe(0);
  });

  it("blocks instead of half-registering when the unit would exceed the registry", () => {
    const sessionKey = createSessionKey();
    const registry = new Set<string>();
    for (let index = 0; index < ISSUED_PLACEHOLDER_LIMIT - 1; index++) {
      registry.add(`[SG-EMAIL-${index.toString(16).padStart(16, "0")}]`);
    }

    // Two new addresses cannot both be retained, so nothing is registered.
    const result = deidentifyText("mail a@b.co and c@d.co now", config, sessionKey, redactOptions, registry);

    expect(result.action).toBe("block");
    expect(registry.size).toBe(ISSUED_PLACEHOLDER_LIMIT - 1);
  });
});

describe("placeholder shape safety", () => {
  it("scans safe against builtin rules and is not a redaction-verifier marker", () => {
    const sessionKey = createSessionKey();
    const placeholder = placeholderFor("alice@example.com", sessionKey);

    expect(placeholder.startsWith(DEIDENTIFY_MARKER_PREFIX)).toBe(true);
    expect(placeholder).toMatch(/^\[SG-EMAIL-[0-9a-f]{16}\]$/);
    expect(scanText(placeholder, config).safe).toBe(true);
    expect(scanText(`before ${placeholder} after`, config).safe).toBe(true);
    // The redaction verifier exempts findings inside its own [REDACTED_\w+]
    // marker shape — our placeholder must never be mistaken for one.
    expect(placeholder).not.toMatch(/\[REDACTED_\w+\]/);
  });
});

describe("applyDeidentify gates (fail-closed)", () => {
  const text = "mail alice@example.com and bob@example.com now";
  const aliceStart = text.indexOf("alice@example.com");
  const bobStart = text.indexOf("bob@example.com");
  const alice = emailFinding("alice@example.com", aliceStart);
  const bob = emailFinding("bob@example.com", bobStart);

  it("substitutes non-overlapping email spans with stable placeholders", () => {
    const sessionKey = createSessionKey();
    const applied = applyDeidentify(text, [alice, bob], sessionKey);

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const alicePlaceholder = placeholderFor("alice@example.com", sessionKey);
    expect(countOccurrences(applied.text, alicePlaceholder)).toBe(1);
    expect(countOccurrences(applied.text, placeholderFor("bob@example.com", sessionKey))).toBe(1);
    expect(applied.text).not.toContain("alice@example.com");
    expect(applied.text).not.toContain("bob@example.com");
  });

  it("rejects findings carrying encoding metadata", () => {
    const applied = applyDeidentify(
      text,
      [{ ...alice, encoding_detected: { type: "Base64", confidence: 0.9 } }],
      createSessionKey(),
    );

    expect(applied.ok).toBe(false);
  });

  it("rejects email findings without usable span metadata", () => {
    const { match_start: _ms, match_end: _me, match_text: _mt, ...stripped } = alice;
    const applied = applyDeidentify(text, [stripped], createSessionKey());

    expect(applied.ok).toBe(false);
  });

  it("rejects overlapping email spans", () => {
    const overlap = emailFinding("alice@example.com and", aliceStart);
    const applied = applyDeidentify(text, [alice, overlap], createSessionKey());

    expect(applied.ok).toBe(false);
  });

  it("rejects spans whose match_text does not match the covered slice", () => {
    const shifted = emailFinding("bob@example.com", aliceStart);
    const applied = applyDeidentify(text, [shifted], createSessionKey());

    expect(applied.ok).toBe(false);
  });
});

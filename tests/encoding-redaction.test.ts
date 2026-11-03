import { describe, it, expect } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import { redactAndVerify } from "../src/scanner/redaction-verifier.js";
import { toDecisionResult } from "../src/decision/model.js";
import { filterBySeverity } from "../src/transports/cli.js";
import type { GuardConfig } from "../src/types.js";

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

const KEY = "sk-proj-test1234567890abcdef";
const b64 = (value: string): string => Buffer.from(value).toString("base64");
const decide = (text: string, cfg: GuardConfig = config) => toDecisionResult(scanText(text, cfg), text, cfg);

describe("encoded findings are masked at their source span", () => {
  it("masks the whole Base64 run", () => {
    const run = "c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg==";
    const result = decide(run);
    expect(result.redactedContent).toBe("[REDACTED_API_KEY]");
    expect(result.safePreview).toBe("[REDACTED_API_KEY]");
  });

  it("masks a raw hex run", () => {
    const run = Buffer.from(KEY).toString("hex");
    const result = decide(run);
    expect(result.redactedContent).toBe("[REDACTED_API_KEY]");
    expect(result.safePreview).toBe("[REDACTED_API_KEY]");
  });

  it("masks a fully percent-encoded run", () => {
    const run = [...Buffer.from(KEY)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
    const result = decide(run);
    expect(result.redactedContent).toBe("[REDACTED_API_KEY]");
    expect(result.safePreview).toBe("[REDACTED_API_KEY]");
  });

  it("masks a percent-encoded assignment without leaving its tail", () => {
    const result = decide("password%3Dsecret123");
    expect(result.redactedContent).toBe("[REDACTED_PASSWORD]");
    expect(result.redactedContent).not.toContain("23");
  });

  it("keeps a long harmless prefix and suffix intact and removes the run", () => {
    const run = b64(KEY);
    const prefix = "harmless prefix text. ".repeat(12);
    const suffix = " harmless suffix text.".repeat(12);
    const result = decide(`${prefix}${run}${suffix}`);
    expect(result.redactedContent).toBe(`${prefix}[REDACTED_API_KEY]${suffix}`);
    expect(result.safePreview).not.toContain(run.slice(0, 12));
    expect(result.safePreview).not.toContain(run.slice(-12));
    expect(result.safePreview).toContain("[REDACTED_API_KEY]");
  });

  it("masks the same secret encoded twice", () => {
    const run = b64(KEY);
    const hex = Buffer.from(KEY).toString("hex");
    const result = decide(`a ${run} b ${hex} c`);
    expect(result.redactedContent).toBe("a [REDACTED_API_KEY] b [REDACTED_API_KEY] c");
  });

  it("masks two identical Base64 runs", () => {
    const run = b64(KEY);
    const result = decide(`${run}\n${run}`);
    expect(result.redactedContent).toBe("[REDACTED_API_KEY]\n[REDACTED_API_KEY]");
  });

  it("reports both a direct key at offset 0 and a same-length encoded key", () => {
    const direct = "sk-proj-test1234567890abcdef";
    const other = "sk-proj-other1234567890abcde"; // same length as the direct key
    expect(other.length).toBe(direct.length);
    const run = b64(other);
    const text = `${direct}${run}`;
    const scan = scanText(text, config);
    expect(scan.total_findings).toBeGreaterThanOrEqual(2);
    // Adjacent spans merge into one placeholder; neither the key nor the run survives.
    const result = toDecisionResult(scan, text, config);
    expect(result.redactedContent).toBe("[REDACTED_API_KEY]");
    expect(result.safePreview).toBe("[REDACTED_API_KEY]");
  });

  it("fails closed when a zero-width character sits inside the run", () => {
    const run = b64(KEY);
    const text = `${run.slice(0, 20)}​${run.slice(20)}`;
    const result = decide(text);
    expect(result.redactedContent).toBeUndefined();
    expect(result.safePreview).toBeUndefined();
  });

  it("fails closed when a hidden run's decoded offsets collide with a direct finding", () => {
    const hidden = b64(KEY);
    const text = `${KEY} ${hidden.slice(0, 20)}\u200b${hidden.slice(20)}`;
    const result = decide(text);
    expect(result.redactedContent).toBeUndefined();
    expect(result.safePreview).toBeUndefined();
  });

  it("still reports the encoding in the preview without plaintext", () => {
    const scan = scanText(b64(KEY), config);
    for (const finding of scan.findings) expect(finding.preview).toBe("****");
  });
});

describe("--redact contract", () => {
  it("does not verify a Base64 value it cannot rewrite", () => {
    const result = redactAndVerify("c2stcHJvai10ZXN0MTIzNDU2Nzg5MGFiY2RlZg==", config);
    expect(result.verified).toBe(false);
  });
});

describe("filterBySeverity keeps the scan warnings", () => {
  const run = b64(KEY);

  it("keeps the encoding warning with --min-severity low", () => {
    const filtered = filterBySeverity(scanText(run, config), "low");
    expect(filtered.summary).toContain("編碼檢測: Base64");
    expect(filtered.summary).toContain("[WARNING:");
  });

  it("keeps the encoding warning when filtering to high", () => {
    const filtered = filterBySeverity(scanText(run, config), "high");
    expect(filtered.summary).toContain("編碼檢測: Base64");
  });

  it("keeps the truncation warning", () => {
    const small: GuardConfig = { ...config, settings: { ...config.settings, max_chars: 20 } };
    const filtered = filterBySeverity(scanText(`${KEY} ${"x".repeat(100)}`, small), "low");
    expect(filtered.summary).toContain("內容截斷");
  });

  it("keeps the truncation warning with encoding detection off", () => {
    const small: GuardConfig = { ...config, settings: { ...config.settings, max_chars: 20, encoding_detection: false } };
    const filtered = filterBySeverity(scanText(`${KEY} ${"x".repeat(100)}`, small), "low");
    expect(filtered.summary).toContain("內容截斷");
  });

  it("adds no suffix when there is no warning", () => {
    const filtered = filterBySeverity(scanText(`token=${KEY}`, { ...config, settings: { ...config.settings, encoding_detection: false } }), "low");
    expect(filtered.summary).not.toContain("[WARNING:");
  });
});

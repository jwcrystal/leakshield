import { describe, it, expect } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import type { GuardConfig } from "../src/types.js";

const defaultConfig: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL"],
  private_domains: ["internal.corp.com"],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: true, // 啟用編碼檢測
  },
};

describe("編碼檢測故障排除", () => {
  it("應檢測短 Base64 編碼的 API Key", () => {
    // "sk-proj-abc123def456789012" (25 chars) in Base64
    // API Key pattern requires: sk- + 20+ chars = 23+ chars total
    const base64Key = "c2stcHJvai1hYmMxMjNkZWY0NTY3ODkwMTI=";
    const result = scanText(base64Key, defaultConfig);

    console.log("Base64 Key scan result:");
    console.log("  Safe:", result.safe);
    console.log("  Findings:", result.findings.length);
    console.log("  Types:", result.findings.map(f => f.type).join(", "));
    console.log("  Summary:", result.summary);

    expect(result.safe).toBe(false);
    expect(result.findings.some(f => f.type === "API_KEY")).toBe(true);
  });

  it("應檢測 URL 編碼的 password", () => {
    const urlEncoded = "password%3Dsecret123";
    const result = scanText(urlEncoded, defaultConfig);

    console.log("\nURL encoded scan result:");
    console.log("  Safe:", result.safe);
    console.log("  Findings:", result.findings.length);
    console.log("  Types:", result.findings.map(f => f.type).join(", "));

    expect(result.safe).toBe(false);
    expect(result.findings.some(f =>
      f.description.toLowerCase().includes("password")
    )).toBe(true);
  });

  it("應檢測混合 Base64 和正常文字", () => {
    // "sk-proj-abc123def456789012" (25 chars) in Base64
    const text = "API key is: c2stcHJvai1hYmMxMjNkZWY0NTY3ODkwMTI=";
    const result = scanText(text, defaultConfig);

    console.log("\nMixed content scan result:");
    console.log("  Safe:", result.safe);
    console.log("  Findings:", result.findings.length);

    expect(result.safe).toBe(false);
  });
});

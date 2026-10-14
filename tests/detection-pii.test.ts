import { describe, it, expect } from "vitest";
import { scanText, redactText } from "../src/scanner/engine.js";
import type { GuardConfig } from "../src/types.js";

const config: GuardConfig = {
  nda_keywords: [],
  private_domains: [],
  custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, preview_length: 60 },
};

const types = (text: string) => scanText(text, config).findings.map((f) => f.type);

// ─── PII_CREDIT_CARD（Luhn）───────────────────────────────────────────────────

describe("PII_CREDIT_CARD（Luhn 驗證）", () => {
  it("命中 Luhn 有效的卡號（緊湊）", () => {
    expect(types("card 4111111111111111 ok")).toContain("PII_CREDIT_CARD");
  });

  it("命中 Luhn 有效的卡號（空格分隔）", () => {
    expect(types("card 4111 1111 1111 1111 ok")).toContain("PII_CREDIT_CARD");
  });

  it("Luhn 無效的相近數字不命中", () => {
    expect(types("id 4111111111111112 x")).not.toContain("PII_CREDIT_CARD");
  });

  it("12 位以下不命中", () => {
    expect(types("num 411111111111 x")).not.toContain("PII_CREDIT_CARD");
  });
});

// ─── PII_IBAN（mod-97）───────────────────────────────────────────────────────

describe("PII_IBAN（mod-97 驗證）", () => {
  it("命中有效 IBAN（緊湊）", () => {
    expect(types("iban GB82WEST12345698765432 ok")).toContain("PII_IBAN");
  });

  it("命中有效 IBAN（第二組樣本）", () => {
    expect(types("iban DE89370400440532013000 ok")).toContain("PII_IBAN");
  });

  it("命中有效 IBAN（四字一空格）", () => {
    expect(types("iban GB82 WEST 1234 5698 7654 32 ok")).toContain("PII_IBAN");
  });

  it("檢查碼錯一位不命中", () => {
    expect(types("iban GB82WEST12345698765433 x")).not.toContain("PII_IBAN");
  });
});

// ─── PII_IP（公共 IPv4）──────────────────────────────────────────────────────

describe("PII_IP（公共 IPv4）", () => {
  it("公共 IP 命中", () => {
    expect(types("dns 8.8.8.8 x")).toContain("PII_IP");
  });

  it("私有／回環／鏈路本地／CGNAT／保留段不命中", () => {
    for (const ip of ["192.168.1.1", "10.0.0.1", "127.0.0.1", "0.0.0.0", "169.254.1.1", "172.16.0.1", "100.64.0.1", "224.0.0.1"]) {
      expect(types(`host ${ip} x`)).not.toContain("PII_IP");
    }
  });

  it("octet 超過 255 不命中", () => {
    expect(types("v 999.1.1.1 x")).not.toContain("PII_IP");
  });
});

// ─── redactText 整合（validate 貫通遮罩路徑）─────────────────────────────────

describe("redactText 整合", () => {
  it("有效卡號被遮罩、Luhn 無效數字原樣保留", () => {
    const r = redactText("a 4111111111111111 b 4111111111111112 c", config);
    expect(r.redacted).toContain("[REDACTED_PII_CREDIT_CARD]");
    expect(r.redacted).not.toContain("4111111111111111");
    expect(r.redacted).toContain("4111111111111112");
  });
});

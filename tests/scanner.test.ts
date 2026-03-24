import { describe, it, expect } from "vitest";
import { scanText } from "../src/scanner/engine.js";
import type { GuardConfig } from "../src/types.js";

const defaultConfig: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL"],
  private_domains: ["internal.corp.com"],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

// ─── 乾淨文字 ─────────────────────────────────────────────────────────────────

describe("scanText() — 乾淨文字", () => {
  it("一般文字應回傳 safe=true，無 findings", () => {
    const result = scanText("Hello, this is a safe message.", defaultConfig);
    expect(result.safe).toBe(true);
    expect(result.total_findings).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("summary 應包含安全提示文字", () => {
    const result = scanText("safe content", defaultConfig);
    expect(result.summary).toContain("✅");
  });
});

// ─── 含敏感資訊 ───────────────────────────────────────────────────────────────

describe("scanText() — API Key 偵測", () => {
  it("OpenAI API Key 應被偵測為 API_KEY / HIGH", () => {
    const result = scanText(
      "const key = 'sk-abcdefghij1234567890abcde';",
      defaultConfig
    );
    expect(result.safe).toBe(false);
    const finding = result.findings.find((f) => f.type === "API_KEY");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("HIGH");
  });

  it("finding 的 preview 應遮罩真實值", () => {
    const result = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    const finding = result.findings.find((f) => f.type === "API_KEY");
    expect(finding?.preview).not.toContain("abcdefghij1234567890");
    expect(finding?.preview).toContain("****");
  });
});

describe("scanText() — PII 偵測", () => {
  it("Email 應被偵測為 PII_EMAIL / MEDIUM", () => {
    const result = scanText("聯絡我：user@example.com", defaultConfig);
    const finding = result.findings.find((f) => f.type === "PII_EMAIL");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("MEDIUM");
  });

  it("台灣身份證字號應被偵測為 PII_ID_TW / HIGH", () => {
    const result = scanText("身份證：A123456789", defaultConfig);
    const finding = result.findings.find((f) => f.type === "PII_ID_TW");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("HIGH");
  });

  it("台灣手機號碼應被偵測為 PII_PHONE_TW", () => {
    const result = scanText("電話：0912345678", defaultConfig);
    const finding = result.findings.find((f) => f.type === "PII_PHONE_TW");
    expect(finding).toBeDefined();
  });
});

describe("scanText() — DB 連線字串偵測", () => {
  it("postgres URL 應被偵測為 DB_CONNECTION / HIGH", () => {
    const result = scanText(
      "postgresql://admin:secret123@localhost:5432/mydb",
      defaultConfig
    );
    const finding = result.findings.find((f) => f.type === "DB_CONNECTION");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("HIGH");
  });
});

describe("scanText() — NDA / 私有域名（動態規則）", () => {
  it("NDA 關鍵字應被偵測為 NDA_KEYWORD", () => {
    const result = scanText("This is CONFIDENTIAL data.", defaultConfig);
    const finding = result.findings.find((f) => f.type === "NDA_KEYWORD");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("HIGH");
  });

  it("私有域名應被偵測為 PRIVATE_DOMAIN", () => {
    const result = scanText(
      "endpoint: https://internal.corp.com/api",
      defaultConfig
    );
    const finding = result.findings.find((f) => f.type === "PRIVATE_DOMAIN");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("MEDIUM");
  });
});

// ─── 行號 / 欄號 ──────────────────────────────────────────────────────────────

describe("scanText() — 行號與欄號", () => {
  it("show_line_numbers=true 時 finding 應含 line/column", () => {
    const result = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    const finding = result.findings[0];
    expect(finding?.line).toBeTypeOf("number");
    expect(finding?.column).toBeTypeOf("number");
  });

  it("show_line_numbers=false 時 line/column 應為 undefined", () => {
    const config: GuardConfig = {
      ...defaultConfig,
      settings: { ...defaultConfig.settings, show_line_numbers: false },
    };
    const result = scanText("sk-abcdefghij1234567890abcde", config);
    const finding = result.findings[0];
    expect(finding?.line).toBeUndefined();
    expect(finding?.column).toBeUndefined();
  });

  it("多行文字中 API Key 在第 3 行應正確回報行號", () => {
    const text = "line1\nline2\nsk-abcdefghij1234567890abcde";
    const result = scanText(text, defaultConfig);
    const finding = result.findings.find((f) => f.type === "API_KEY");
    expect(finding?.line).toBe(3);
    expect(finding?.column).toBe(1);
  });
});

// ─── 截斷行為 ─────────────────────────────────────────────────────────────────

describe("scanText() — max_chars 截斷", () => {
  it("超過 max_chars 的部分不應被掃描", () => {
    const config: GuardConfig = {
      ...defaultConfig,
      settings: { ...defaultConfig.settings, max_chars: 10 },
    };
    // API Key 放在第 11 個字元後，應不被偵測
    const text = "0123456789" + "sk-abcdefghij1234567890";
    const result = scanText(text, config);
    expect(result.findings.find((f) => f.type === "API_KEY")).toBeUndefined();
  });
});

// ─── 去重 ─────────────────────────────────────────────────────────────────────

describe("scanText() — 去重機制", () => {
  it("同位置同類型的命中不應重複計算", () => {
    // 短文字中只有一個 API key，total_findings 應 = 1（不因多條規則重疊而翻倍）
    const result = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    const apiKeyFindings = result.findings.filter((f) => f.type === "API_KEY");
    expect(apiKeyFindings).toHaveLength(1);
  });
});

// ─── summary / recommendation ─────────────────────────────────────────────────

describe("scanText() — summary 與 recommendation", () => {
  it("有 findings 時 summary 應含數量資訊", () => {
    const result = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    expect(result.summary).toContain("🚨");
    expect(result.summary).toContain("1");
  });

  it("total_findings 應與 findings.length 一致", () => {
    const result = scanText(
      "sk-abcdefghij1234567890abcde user@example.com",
      defaultConfig
    );
    expect(result.total_findings).toBe(result.findings.length);
  });
});

import { describe, it, expect } from "vitest";
import { redactText, scanText } from "../src/scanner/engine.js";
import type { GuardConfig } from "../src/types.js";

const defaultConfig: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL"],
  private_domains: ["internal.corp.com"],
  custom_rules: [],
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

  it("finding 的 preview 應完整遮罩，不含任何原始值片段", () => {
    const result = scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    const finding = result.findings.find((f) => f.type === "API_KEY");
    expect(finding?.preview).toBe("****");
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

  it("台灣手機號碼應被偵測為 PII_PHONE_TW（opt-in 開啟時）", () => {
    const phoneOn: GuardConfig = {
      ...defaultConfig,
      settings: { ...defaultConfig.settings, rule_overrides: { "phone-tw": true } },
    };
    const result = scanText("電話：0912345678", phoneOn);
    const finding = result.findings.find((f) => f.type === "PII_PHONE_TW");
    expect(finding).toBeDefined();
  });

  it("電話規則預設關閉（P2，2026-10-06 決策；漏真電話風險見 README）", () => {
    const result = scanText("電話：0912345678 或 +14155552671", defaultConfig);
    expect(result.findings.some((f) => f.type === "PII_PHONE_TW" || f.type === "PII_PHONE_INTL")).toBe(false);
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

// ─── Inline ignore ────────────────────────────────────────────────────────────

describe("scanText() — sensitive-guard-ignore", () => {
  it("同行有 ignore 標記時 finding 應被抑制", () => {
    const text = "const key = 'sk-abcdefghij1234567890abcde'; // sensitive-guard-ignore";
    expect(scanText(text, defaultConfig).safe).toBe(true);
  });

  it("ignore 在其他行時不影響當前行的 finding", () => {
    const text = [
      "const key = 'sk-abcdefghij1234567890abcde';",
      "// sensitive-guard-ignore",
    ].join("\n");
    // ignore 在第 2 行，API key 在第 1 行，不應被抑制
    expect(scanText(text, defaultConfig).safe).toBe(false);
  });

  it("同行有多個 findings 時全部被抑制", () => {
    const text = "user@example.com sk-abcdefghij1234567890abcde // sensitive-guard-ignore";
    expect(scanText(text, defaultConfig).safe).toBe(true);
  });

  it("# 風格 ignore 也有效", () => {
    const text = "API_KEY = 'sk-abcdefghij1234567890abcde' # sensitive-guard-ignore";
    expect(scanText(text, defaultConfig).safe).toBe(true);
  });

  it("只抑制被標記的行，其他行仍正常偵測", () => {
    const text = [
      "const a = 'sk-abcdefghij1234567890abcde'; // sensitive-guard-ignore",
      "const b = 'sk-abcdefghij1234567890abcde';",
    ].join("\n");
    const result = scanText(text, defaultConfig);
    expect(result.safe).toBe(false);
    expect(result.total_findings).toBe(1);
  });
});

// ─── 多次呼叫穩定性 ────────────────────────────────────────────────────────────

describe("scanText() — 多次呼叫結果一致（無 RegExp 狀態殘留）", () => {
  it("連續呼叫三次結果應完全相同", () => {
    const text = "sk-abcdefghij1234567890abcde user@example.com";
    const r1 = scanText(text, defaultConfig);
    const r2 = scanText(text, defaultConfig);
    const r3 = scanText(text, defaultConfig);
    expect(r2.total_findings).toBe(r1.total_findings);
    expect(r3.total_findings).toBe(r1.total_findings);
    expect(r2.findings.map((f) => f.type)).toEqual(r1.findings.map((f) => f.type));
  });

  it("掃描後 BUILTIN_RULES 的 pattern.lastIndex 不應被改動", async () => {
    const { BUILTIN_RULES } = await import("../src/rules/builtin.js");
    scanText("sk-abcdefghij1234567890abcde", defaultConfig);
    for (const rule of BUILTIN_RULES) {
      expect(rule.pattern.lastIndex).toBe(0);
    }
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

// ─── Match metadata for deterministic replacement ────────────────────────────

describe("scanText() — match metadata (match_start, match_end, match_text)", () => {
  it("finding 應包含 match_start, match_end, match_text", () => {
    const text = "key = sk-abcdefghij1234567890abcde;";
    const result = scanText(text, defaultConfig);
    const finding = result.findings.find((f) => f.type === "API_KEY");
    expect(finding).toBeDefined();
    expect(finding!.match_start).toBe(6);
    expect(finding!.match_end).toBe(34);
    expect(finding!.match_text).toBe("sk-abcdefghij1234567890abcde");
  });

  it("match_start + match_end 長度應與 match_text 長度一致", () => {
    const text = "sk-abcdefghij1234567890abcde user@example.com";
    const result = scanText(text, defaultConfig);
    for (const f of result.findings) {
      expect(f.match_end! - f.match_start!).toBe(f.match_text!.length);
    }
  });

  it("match_start / match_end 可用於從原始文字精確擷取 match_text", () => {
    const text = "before sk-abcdefghij1234567890abcde after";
    const result = scanText(text, defaultConfig);
    const f = result.findings.find((fi) => fi.type === "API_KEY")!;
    expect(text.slice(f.match_start!, f.match_end!)).toBe(f.match_text);
  });

  it("多行文字中 match_start/match_end 為整體偏移量，非行內偏移", () => {
    const text = "aaa\nbbb\nsk-abcdefghij1234567890abcde";
    const result = scanText(text, defaultConfig);
    const f = result.findings.find((fi) => fi.type === "API_KEY")!;
    // "aaa\nbbb\n" = 8 chars, so match_start should be 8
    expect(f.match_start).toBe(8);
    expect(f.match_end).toBe(36);
  });
});

// ─── honorIgnoreDirectives 選項（模型邊界不得尊重行內 ignore） ────────────────

describe("scanText() — honorIgnoreDirectives 選項", () => {
  const text = "bob.canary@example-test.invalid // sg-ignore";
  const encodingConfig: GuardConfig = {
    ...defaultConfig,
    settings: { ...defaultConfig.settings, encoding_detection: true },
  };

  it("預設行為不變：ignore 標記仍抑制 finding（CLI/Web 契約）", () => {
    expect(
      scanText(text, defaultConfig).findings.some((f) => f.type === "PII_EMAIL"),
    ).toBe(false);
    expect(
      scanText(text, encodingConfig).findings.some((f) => f.type === "PII_EMAIL"),
    ).toBe(false);
  });

  it("{honorIgnoreDirectives:false} 時 PII_EMAIL 必須被回報（含編碼偵測路徑）", () => {
    expect(
      scanText(text, defaultConfig, { honorIgnoreDirectives: false }).findings.some(
        (f) => f.type === "PII_EMAIL",
      ),
    ).toBe(true);
    expect(
      scanText(text, encodingConfig, { honorIgnoreDirectives: false }).findings.some(
        (f) => f.type === "PII_EMAIL",
      ),
    ).toBe(true);
  });
});

describe("redactText() — honorIgnoreDirectives 選項", () => {
  const text = "bob.canary@example-test.invalid // sg-ignore";

  it("預設行為不變：ignore 標記仍抑制替換", () => {
    expect(redactText(text, defaultConfig).redacted).toContain(
      "bob.canary@example-test.invalid",
    );
  });

  it("{honorIgnoreDirectives:false} 時必須替換為 [REDACTED_PII_EMAIL]", () => {
    const result = redactText(text, defaultConfig, { honorIgnoreDirectives: false });
    expect(result.redacted).not.toContain("bob.canary@example-test.invalid");
    expect(result.redacted).toContain("[REDACTED_PII_EMAIL]");
  });
});

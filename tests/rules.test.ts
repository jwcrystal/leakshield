import { describe, it, expect } from "vitest";
import { BUILTIN_RULES, buildDynamicRules } from "../src/index.js";
import type { GuardConfig } from "../src/index.js";

// 輔助：測試某條規則是否命中
function matches(pattern: RegExp, text: string): boolean {
  const re = new RegExp(pattern.source, pattern.flags);
  re.lastIndex = 0;
  return re.test(text);
}

function ruleFor(description: string) {
  const rule = BUILTIN_RULES.find((r) => r.description === description);
  if (!rule) throw new Error(`找不到規則：${description}`);
  return rule.pattern;
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

describe("OpenAI API Key", () => {
  const pat = ruleFor("OpenAI API Key");

  it("應命中舊格式（純英數）", () => {
    expect(matches(pat, "sk-abcdefghij1234567890")).toBe(true);
  });

  it("太短不命中", () => {
    expect(matches(pat, "sk-short")).toBe(false);
  });

  // 已知缺口：新版 sk-proj-xxx 格式含連字號，現有規則 [A-Za-z0-9]{20,60} 無法命中
  // 重構時應將 pattern 更新為 /sk-[A-Za-z0-9\-]{20,60}/g
  it("【已知缺口】sk-proj- 新格式目前不命中", () => {
    expect(matches(pat, "sk-proj-abcdefghijklmnopqrstuvwxyz012345")).toBe(false);
  });
});

describe("Anthropic API Key", () => {
  const pat = ruleFor("Anthropic API Key");

  it("應命中標準格式", () => {
    expect(matches(pat, "sk-ant-api03-abcdefghijklmnopqrst12345678")).toBe(true);
  });

  it("一般 sk- 不命中", () => {
    expect(matches(pat, "sk-abcdefghij1234567890")).toBe(false);
  });
});

describe("Google API Key", () => {
  const pat = ruleFor("Google API Key");

  it("應命中 AIza 開頭 39 字元", () => {
    expect(matches(pat, "AIzaSyAbcdefghijklmnopqrstuvwxyz01234567")).toBe(true);
  });

  it("AIza 開頭但太短不命中", () => {
    expect(matches(pat, "AIzaShort")).toBe(false);
  });
});

describe("GitHub Personal Access Token", () => {
  const pat = ruleFor("GitHub Personal Access Token");

  it("應命中 ghp_ 開頭接 36 個英數字元", () => {
    // ghp_ 後需恰好 36 字元
    expect(matches(pat, "ghp_ABCDEFGHIJ12345678901234567890123456")).toBe(true);
  });

  it("ghp_ 後太短不命中", () => {
    expect(matches(pat, "ghp_short")).toBe(false);
  });
});

describe("GitHub OAuth / App Token", () => {
  const pat = ruleFor("GitHub OAuth / App Token");

  it("應命中 gho_ 開頭接 36 個英數字元", () => {
    expect(matches(pat, "gho_ABCDEFGHIJ12345678901234567890123456")).toBe(true);
  });

  it("應命中 ghs_ 開頭接 36 個英數字元", () => {
    expect(matches(pat, "ghs_ABCDEFGHIJ12345678901234567890123456")).toBe(true);
  });
});

describe("JWT Token", () => {
  const pat = ruleFor("JWT Token");
  const sampleJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

  it("應命中標準 JWT 格式", () => {
    expect(matches(pat, sampleJwt)).toBe(true);
  });

  it("不含兩個點的字串不命中", () => {
    expect(matches(pat, "eyJhbGciOiJub3RhcmVhbHRva2VufQ")).toBe(false);
  });
});

describe("Generic Bearer Token", () => {
  const pat = ruleFor("Generic Bearer Token（長度 ≥ 32 的字串）");

  it("應命中 bearer 後接 ≥32 字元", () => {
    expect(matches(pat, "bearer abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(matches(pat, "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456")).toBe(true);
  });

  it("bearer 後太短不命中", () => {
    expect(matches(pat, "bearer shorttoken")).toBe(false);
  });
});

describe("Generic Secret / Password 賦值", () => {
  const pat = ruleFor("Generic Secret / Password 賦值");

  it("應命中常見賦值格式", () => {
    expect(matches(pat, `password = "mysecretpassword123"`)).toBe(true);
    expect(matches(pat, `secret: "my-super-secret-key"`)).toBe(true);
    expect(matches(pat, `client_secret = "abc123def456"`)).toBe(true);
  });

  it("值太短不命中（< 8 字元）", () => {
    expect(matches(pat, `password = "short"`)).toBe(false);
  });
});

// ─── PII ──────────────────────────────────────────────────────────────────────

describe("Email 地址", () => {
  const pat = ruleFor("Email 地址");

  it("應命中標準 email", () => {
    expect(matches(pat, "user@example.com")).toBe(true);
    expect(matches(pat, "test.user+tag@company.co.uk")).toBe(true);
  });

  it("缺少 @ 不命中", () => {
    expect(matches(pat, "notanemail.com")).toBe(false);
  });
});

describe("台灣手機號碼", () => {
  const pat = ruleFor("台灣手機號碼");

  it("應命中 09xx 格式", () => {
    expect(matches(pat, "0912345678")).toBe(true);
    expect(matches(pat, "0912-345-678")).toBe(true);
  });

  it("應命中 +886 格式", () => {
    expect(matches(pat, "+886912345678")).toBe(true);
  });

  it("一般市話不命中", () => {
    expect(matches(pat, "0212345678")).toBe(false);
  });
});

describe("台灣身份證字號", () => {
  const pat = ruleFor("台灣身份證字號");

  it("應命中 A+1/2+8碼 格式", () => {
    expect(matches(pat, "A123456789")).toBe(true);
    expect(matches(pat, "Z200000001")).toBe(true);
  });

  it("小寫開頭不命中", () => {
    expect(matches(pat, "a123456789")).toBe(false);
  });

  it("數字開頭不命中", () => {
    expect(matches(pat, "1123456789")).toBe(false);
  });
});

// ─── DB 連線字串 ──────────────────────────────────────────────────────────────

describe("資料庫連線字串（含密碼）", () => {
  const pat = ruleFor("資料庫連線字串（含密碼）");

  it("應命中標準 mongodb:// URL", () => {
    expect(
      matches(pat, "mongodb://user:password@cluster.example.com/db")
    ).toBe(true);
  });

  // 已知缺口：mongodb+srv:// 格式不在規則 pattern 內，重構時應補上
  it("【已知缺口】mongodb+srv:// 目前不命中", () => {
    expect(
      matches(pat, "mongodb+srv://user:password@cluster.mongodb.net/db")
    ).toBe(false);
  });

  it("應命中 postgres URL", () => {
    expect(
      matches(pat, "postgresql://admin:secret@localhost:5432/mydb")
    ).toBe(true);
  });

  it("應命中 mysql URL", () => {
    expect(matches(pat, "mysql://root:pass@127.0.0.1/mydb")).toBe(true);
  });

  it("沒有密碼的 URL 不命中", () => {
    expect(matches(pat, "mongodb://localhost/mydb")).toBe(false);
  });
});

// ─── buildDynamicRules() ─────────────────────────────────────────────────────

describe("buildDynamicRules()", () => {
  const baseConfig: GuardConfig = {
    nda_keywords: [],
    private_domains: [],
    settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
  };

  it("NDA 關鍵字生成大小寫不敏感規則", () => {
    const config = { ...baseConfig, nda_keywords: ["CONFIDENTIAL"] };
    const rules = buildDynamicRules(config);
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe("NDA_KEYWORD");
    expect(rules[0].severity).toBe("HIGH");

    const pat = rules[0].pattern;
    expect(matches(pat, "this is CONFIDENTIAL info")).toBe(true);
    expect(matches(pat, "this is confidential info")).toBe(true);
    expect(matches(pat, "this is safe")).toBe(false);
  });

  it("NDA 關鍵字特殊字元會被 escape", () => {
    const config = { ...baseConfig, nda_keywords: ["Project (Alpha)"] };
    const rules = buildDynamicRules(config);
    // 應正常建立規則，不因括號而 throw
    expect(rules).toHaveLength(1);
    expect(matches(rules[0].pattern, "Project (Alpha) document")).toBe(true);
  });

  it("私有域名生成 PRIVATE_DOMAIN 規則", () => {
    const config = { ...baseConfig, private_domains: ["internal.corp.com"] };
    const rules = buildDynamicRules(config);
    expect(rules).toHaveLength(1);
    expect(rules[0].type).toBe("PRIVATE_DOMAIN");
    expect(rules[0].severity).toBe("MEDIUM");
    expect(matches(rules[0].pattern, "call internal.corp.com/api")).toBe(true);
  });

  it("無設定時回傳空陣列", () => {
    const rules = buildDynamicRules(baseConfig);
    expect(rules).toHaveLength(0);
  });
});

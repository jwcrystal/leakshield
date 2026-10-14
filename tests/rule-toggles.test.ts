import { describe, it, expect } from "vitest";
import { scanText, redactText } from "../src/scanner/engine.js";
import { BUILTIN_RULES, BUILTIN_RULE_IDS } from "../src/rules/builtin.js";
import { GuardConfigSchema } from "../src/config/loader.js";
import type { GuardConfig } from "../src/types.js";

function makeConfig(overrides?: Record<string, boolean>): GuardConfig {
  return {
    nda_keywords: [],
    private_domains: [],
    custom_rules: [],
    settings: {
      max_chars: 200000,
      show_line_numbers: false,
      preview_length: 60,
      ...(overrides ? { rule_overrides: overrides } : {}),
    },
  };
}

const types = (text: string, config: GuardConfig) => scanText(text, config).findings.map((f) => f.type);

// ─── 規則 id 完整性 ──────────────────────────────────────────────────────────

describe("builtin 規則 id", () => {
  it("每條 builtin 都有 id（未來新增規則不可漏，否則無法被 toggle）", () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.id, `規則缺少 id：${rule.description}`).toBeDefined();
    }
  });

  it("id 不重複", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("BUILTIN_RULE_IDS 涵蓋全部規則", () => {
    expect(BUILTIN_RULE_IDS.size).toBe(BUILTIN_RULES.length);
  });
});

// ─── opt-in 規則（url）───────────────────────────────────────────────────────

describe("url 規則（opt-in、預設關閉）", () => {
  it("預設不啟用：URL 不產生 finding", () => {
    expect(types("see https://api.example.com/v1 x", makeConfig())).not.toContain("PII_URL");
  });

  it("rule_overrides.url: true 啟用", () => {
    expect(types("see https://api.example.com/v1 x", makeConfig({ url: true }))).toContain("PII_URL");
  });

  it("啟用時句尾標點不吞入遮罩範圍", () => {
    const f = scanText("go https://example.com.", makeConfig({ url: true })).findings.find(
      (x) => x.type === "PII_URL",
    );
    expect(f?.match_text).toBe("https://example.com");
  });

  it("redactText 貫通：啟用後遮罩為 placeholder", () => {
    const r = redactText("go https://secret.example.com/x now", makeConfig({ url: true }));
    expect(r.redacted).toContain("[REDACTED_PII_URL]");
    expect(r.redacted).not.toContain("secret.example.com");
  });
});

// ─── 關閉既有 builtin ────────────────────────────────────────────────────────

describe("關閉既有 builtin", () => {
  it("rule_overrides.email: false 之後 email 不偵測", () => {
    expect(types("mail alice@example.com x", makeConfig())).toContain("PII_EMAIL");
    expect(types("mail alice@example.com x", makeConfig({ email: false }))).not.toContain("PII_EMAIL");
  });

  it("其他規則不受單一 override 影響", () => {
    const t = types("mail alice@example.com 4111111111111111", makeConfig({ email: false }));
    expect(t).toContain("PII_CREDIT_CARD");
    expect(t).not.toContain("PII_EMAIL");
  });
});

// ─── 配置驗證（fail-closed）─────────────────────────────────────────────────

describe("rule_overrides 配置驗證", () => {
  it("未知 id 拒絕 parse（拼字錯誤不得靜默通過）", () => {
    expect(() =>
      GuardConfigSchema.parse({ settings: { rule_overrides: { urll: true } } }),
    ).toThrow(/unknown builtin rule id/);
  });

  it("非 boolean 值拒絕 parse", () => {
    expect(() =>
      GuardConfigSchema.parse({ settings: { rule_overrides: { url: "yes" } } }),
    ).toThrow();
  });

  it("空字串 id 拒絕 parse", () => {
    expect(() =>
      GuardConfigSchema.parse({ settings: { rule_overrides: { "": true } } }),
    ).toThrow();
  });

  it("合法配置正常 parse 且預設值補齊", () => {
    const parsed = GuardConfigSchema.parse({ settings: { rule_overrides: { url: true } } });
    expect(parsed.settings.rule_overrides).toEqual({ url: true });
    expect(parsed.settings.max_chars).toBe(200000);
  });

  it("無 rule_overrides 時預設為空物件", () => {
    const parsed = GuardConfigSchema.parse({});
    expect(parsed.settings.rule_overrides).toEqual({});
  });
});

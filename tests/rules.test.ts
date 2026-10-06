import { describe, it, expect } from "vitest";
import { BUILTIN_RULES } from "../src/rules/builtin.js";
import { buildDynamicRules } from "../src/rules/dynamic.js";
import type { GuardConfig } from "../src/types.js";

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

  it("應命中 sk-proj- 新格式（含連字號）", () => {
    expect(matches(pat, "sk-proj-abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
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

  it("遮罩值不命中（全 * 字元）", () => {
    expect(matches(pat, `password = ********`)).toBe(false);
    expect(matches(pat, `secret = ****************`)).toBe(false);
  });

  it("環境變數參照不命中（\${VAR} 格式）", () => {
    expect(matches(pat, `secret = \${MY_SECRET_VAR}`)).toBe(false);
    expect(matches(pat, `password = "\${DB_PASSWORD}"`)).toBe(false);
  });

  it("模板語法不命中（<%= %> 格式）", () => {
    expect(matches(pat, `password = <%= @password %>`)).toBe(false);
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

  it("應命中 mongodb+srv:// 格式", () => {
    expect(
      matches(pat, "mongodb+srv://user:password@cluster.mongodb.net/db")
    ).toBe(true);
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

// ─── AWS Access Key ID ────────────────────────────────────────────────────────

describe("AWS Access Key ID", () => {
  const pat = ruleFor("AWS Access Key ID");

  it("應命中 AKIA 開頭 20 字元（大寫英數）", () => {
    expect(matches(pat, "AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("應命中 ASIA 開頭（STS 臨時憑證）", () => {
    expect(matches(pat, "ASIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("嵌入較長字串中不命中（word boundary）", () => {
    expect(matches(pat, "PREFIXAKIA1234567890ABCDEF")).toBe(false);
  });

  it("後接更多字元不命中（非標準長度）", () => {
    expect(matches(pat, "AKIAIOSFODNN7EXAMPLEMORE")).toBe(false);
  });
});

// ─── AWS Secret Access Key ────────────────────────────────────────────────────

describe("AWS Secret Access Key", () => {
  const pat = ruleFor("AWS Secret Access Key");

  it("應命中 aws 前綴後接 40 字元金鑰", () => {
    expect(
      matches(pat, `aws_secret_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"`)
    ).toBe(true);
    expect(
      matches(pat, `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`)
    ).toBe(true);
  });

  it("缺少 aws 前綴不命中", () => {
    expect(
      matches(pat, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
    ).toBe(false);
  });
});

// ─── GitHub Fine-Grained PAT ──────────────────────────────────────────────────

describe("GitHub Fine-Grained Personal Access Token", () => {
  const pat = ruleFor("GitHub Fine-Grained Personal Access Token");

  it("應命中 github_pat_ 開頭接 82 字元", () => {
    const token =
      "github_pat_" + "A".repeat(11) + "_" + "B".repeat(70);
    expect(matches(pat, token)).toBe(true);
  });

  it("ghp_ 開頭不命中此規則", () => {
    expect(matches(pat, "ghp_ABCDEFGHIJ12345678901234567890123456")).toBe(false);
  });

  it("太短不命中", () => {
    expect(matches(pat, "github_pat_short")).toBe(false);
  });
});

// ─── Stripe ──────────────────────────────────────────────────────────────────

describe("Stripe Live Secret Key", () => {
  const pat = ruleFor("Stripe Live Secret Key");

  it("應命中 sk_live_ 開頭接 ≥24 字元", () => {
    expect(matches(pat, "sk_live_AbCdEfGhIjKlMnOpQrStUvWx")).toBe(true);
  });

  it("測試環境 sk_test_ 不命中", () => {
    expect(matches(pat, "sk_test_AbCdEfGhIjKlMnOpQrStUvWx")).toBe(false);
  });

  it("太短不命中", () => {
    expect(matches(pat, "sk_live_short")).toBe(false);
  });
});

describe("Stripe Live Publishable Key", () => {
  const pat = ruleFor("Stripe Live Publishable Key");

  it("應命中 pk_live_ 開頭接 ≥24 字元", () => {
    expect(matches(pat, "pk_live_AbCdEfGhIjKlMnOpQrStUvWx")).toBe(true);
  });

  it("測試環境 pk_test_ 不命中", () => {
    expect(matches(pat, "pk_test_AbCdEfGhIjKlMnOpQrStUvWx")).toBe(false);
  });
});

// ─── Slack ───────────────────────────────────────────────────────────────────

describe("Slack Bot Token", () => {
  const pat = ruleFor("Slack Bot Token");

  it("應命中 xoxb- 開頭接 ≥40 字元", () => {
    expect(
      matches(pat, "xoxb-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt")
    ).toBe(true);
  });

  it("xoxp- 開頭不命中此規則", () => {
    expect(
      matches(pat, "xoxp-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt")
    ).toBe(false);
  });

  it("太短不命中", () => {
    expect(matches(pat, "xoxb-short")).toBe(false);
  });
});

describe("Slack User / App Token", () => {
  const pat = ruleFor("Slack User / App Token");

  it("應命中 xoxp- 開頭", () => {
    expect(
      matches(pat, "xoxp-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt")
    ).toBe(true);
  });

  it("應命中 xoxa- 開頭", () => {
    expect(
      matches(pat, "xoxa-123456789012-123456789012-AbCdEfGhIjKlMnOpQrSt")
    ).toBe(true);
  });
});

// ─── Hugging Face ─────────────────────────────────────────────────────────────

describe("Hugging Face API Token", () => {
  const pat = ruleFor("Hugging Face API Token");

  it("應命中 hf_ 開頭接 ≥34 字元", () => {
    expect(
      matches(pat, "hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh")
    ).toBe(true);
  });

  it("太短不命中", () => {
    expect(matches(pat, "hf_short")).toBe(false);
  });
});

// ─── PEM Private Key ─────────────────────────────────────────────────────────

describe("PEM Private Key", () => {
  const pat = ruleFor("PEM Private Key");

  it("應命中 RSA PRIVATE KEY header", () => {
    expect(matches(pat, "-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
  });

  it("應命中 EC PRIVATE KEY header", () => {
    expect(matches(pat, "-----BEGIN EC PRIVATE KEY-----")).toBe(true);
  });

  it("應命中 DSA PRIVATE KEY 標頭", () => {
    expect(matches(pat, "-----BEGIN DSA PRIVATE KEY-----")).toBe(true);
  });

  it("應命中 OPENSSH PRIVATE KEY header", () => {
    expect(matches(pat, "-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
  });

  it("應命中無前綴 PRIVATE KEY header", () => {
    expect(matches(pat, "-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("PUBLIC KEY 不命中", () => {
    expect(matches(pat, "-----BEGIN PUBLIC KEY-----")).toBe(false);
  });
});

describe("國際電話號碼", () => {
  const pat = ruleFor("國際電話號碼");

  it("應命中 +1 美國號碼", () => {
    expect(matches(pat, "+14155552671")).toBe(true);
  });

  it("應命中 +44 英國號碼", () => {
    expect(matches(pat, "+447911123456")).toBe(true);
  });

  it("不含 + 號不命中", () => {
    expect(matches(pat, "14155552671")).toBe(false);
  });
});

// ─── ADO Connection String ───────────────────────────────────────────────────

describe("DB Connection String（ADO 格式）", () => {
  const pat = ruleFor("DB Connection String（ADO 格式）");

  it("應命中 Data Source + Password 格式", () => {
    expect(
      matches(
        pat,
        "Data Source=myServer;Initial Catalog=myDB;Password=mySecret123;"
      )
    ).toBe(true);
  });

  it("應命中 Server + Pwd 格式", () => {
    expect(
      matches(pat, "Server=myServer;Database=myDB;Pwd=myPassword;")
    ).toBe(true);
  });

  it("只有 Server 無密碼不命中", () => {
    expect(matches(pat, "Server=myServer;Database=myDB;")).toBe(false);
  });
});

// ─── buildDynamicRules() ─────────────────────────────────────────────────────

describe("buildDynamicRules()", () => {
  const baseConfig: GuardConfig = {
    nda_keywords: [],
    private_domains: [],
    custom_rules: [],
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

// ─── PEM Private Key（完整區塊保護） ────────────────────────────────────────

describe("PEM Private Key", () => {
  const pat = ruleFor("PEM Private Key");

  const PEM_BODY =
    "MIIEowIBAAKCAQEA0Z3VSZSJdyyY8wzwLS0cSBMubeJ6h1LpZfK0hVfX4mW2pQ9zRrTnXyBvGcE7dNaU5fHiJkOlM";
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`;

  it("完整區塊：match 覆蓋 header、body 與 END 行", () => {
    const re = new RegExp(pat.source, pat.flags);
    const hit = re.exec(pem);
    expect(hit).not.toBeNull();
    expect(hit![0].startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(hit![0].endsWith("-----END RSA PRIVATE KEY-----")).toBe(true);
    expect(hit![0]).toContain(PEM_BODY);
  });

  it("截斷區塊（無 END）：仍命中 header", () => {
    expect(matches(pat, `-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}`)).toBe(true);
  });

  it("多把 key：逐一完整匹配", () => {
    const re = new RegExp(pat.source, pat.flags);
    const two = `${pem}\nmiddle text\n${pem}`;
    const hits = [...two.matchAll(re)];
    expect(hits).toHaveLength(2);
    expect(hits[0][0]).toBe(pem);
    expect(hits[1][0]).toBe(pem);
  });

  it("EC / DSA / 無前綴變體同樣完整匹配", () => {
    for (const kind of ["EC", "DSA", ""]) {
      const label = kind === "" ? "PRIVATE KEY" : `${kind} PRIVATE KEY`;
      const block = `-----BEGIN ${label}-----\n${PEM_BODY}\n-----END ${label}-----`;
      const re = new RegExp(pat.source, pat.flags);
      const hit = re.exec(block);
      expect(hit?.[0]).toBe(block);
    }
  });
});

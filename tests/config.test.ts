import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { GuardConfigSchema, loadConfig, loadConfigWithFingerprint } from "../src/config/loader.js";

// The ESM namespace of fs cannot be spied on directly; a transparent spread
// of the actual module keeps everything real while the single-read test can
// intercept readFileSync as seen by the loader.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

// ─── 使用預設搜尋路徑（repo 不附 config/guard.config.yaml）──────────────────────

describe("loadConfig() — 讀取真實設定檔", () => {
  it("應回傳含三個頂層 key 的物件", () => {
    const config = loadConfig();
    expect(config).toHaveProperty("nda_keywords");
    expect(config).toHaveProperty("private_domains");
    expect(config).toHaveProperty("settings");
  });

  it("nda_keywords 應為字串陣列，允許明確停用", () => {
    const config = loadConfig();
    expect(Array.isArray(config.nda_keywords)).toBe(true);
    config.nda_keywords.forEach((kw) => expect(typeof kw).toBe("string"));
  });

  it("settings 欄位型別正確", () => {
    const { settings } = loadConfig();
    expect(typeof settings.max_chars).toBe("number");
    expect(settings.max_chars).toBeGreaterThan(0);
    expect(typeof settings.show_line_numbers).toBe("boolean");
    expect(typeof settings.preview_length).toBe("number");
  });
});

// ─── 找不到設定檔 → 回傳預設值 ───────────────────────────────────────────────

describe("loadConfig() — 明確指定的路徑不存在", () => {
  // An explicit path (OpenCode configPath, pi LEAKSHIELD_CONFIG, proxy --config)
  // that does not exist must fail the load: falling back to the built-in defaults
  // would silently drop the user's keywords, domains, rules and env_files.
  it("指定的路徑不存在時丟出錯誤並寫出路徑，不回傳預設值", () => {
    expect(() => loadConfig("/nonexistent/path/guard.config.yaml")).toThrow(
      "guard config file not found: /nonexistent/path/guard.config.yaml",
    );
  });

  it("內建預設值本身不變", () => {
    const config = GuardConfigSchema.parse({});
    expect(config.nda_keywords).toContain("CONFIDENTIAL");
    expect(config.nda_keywords).toContain("NDA");
    expect(config.private_domains).toHaveLength(0);
    expect(config.settings.max_chars).toBe(200000);
    expect(config.settings.show_line_numbers).toBe(true);
    expect(config.settings.preview_length).toBe(60);
  });
});

// ─── 自訂 YAML 內容解析 ───────────────────────────────────────────────────────

describe("loadConfig() — 自訂 YAML 解析", () => {
  let tmpFile: string;

  afterEach(() => {
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  function writeTmp(content: string): string {
    tmpFile = path.join(os.tmpdir(), `guard-test-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, content, "utf-8");
    return tmpFile;
  }

  it("應正確載入自訂 NDA 關鍵字", () => {
    const p = writeTmp(`
nda_keywords:
  - TOP SECRET
  - INTERNAL USE ONLY
private_domains: []
settings:
  max_chars: 200000
  show_line_numbers: true
  preview_length: 60
`);
    const config = loadConfig(p);
    expect(config.nda_keywords).toContain("TOP SECRET");
    expect(config.nda_keywords).toContain("INTERNAL USE ONLY");
  });

  it("應正確載入私有域名", () => {
    const p = writeTmp(`
nda_keywords: []
private_domains:
  - secret.corp.example.com
settings:
  max_chars: 200000
  show_line_numbers: true
  preview_length: 60
`);
    const config = loadConfig(p);
    expect(config.private_domains).toContain("secret.corp.example.com");
  });

  it("NDA 關鍵字超過 200 字元時應拋出錯誤", () => {
    const longKeyword = "A".repeat(201);
    const p = writeTmp(`
nda_keywords:
  - "${longKeyword}"
private_domains: []
settings:
  max_chars: 200000
  show_line_numbers: true
  preview_length: 60
`);
    expect(() => loadConfig(p)).toThrow(/too_big|max/i);
  });

  it("私有域名超過 255 字元時應拋出錯誤", () => {
    const longDomain = "a".repeat(256);
    const p = writeTmp(`
nda_keywords: []
private_domains:
  - "${longDomain}"
settings:
  max_chars: 200000
  show_line_numbers: true
  preview_length: 60
`);
    expect(() => loadConfig(p)).toThrow(/too_big|max/i);
  });

  it("正常長度的 NDA 關鍵字和域名仍可正常載入", () => {
    const p = writeTmp(`
nda_keywords:
  - "NORMAL KEYWORD"
private_domains:
  - "internal.example.com"
settings:
  max_chars: 200000
  show_line_numbers: true
  preview_length: 60
`);
    const config = loadConfig(p);
    expect(config.nda_keywords).toContain("NORMAL KEYWORD");
    expect(config.private_domains).toContain("internal.example.com");
  });

  it("應正確載入自訂 settings", () => {
    const p = writeTmp(`
nda_keywords: []
private_domains: []
settings:
  max_chars: 50000
  show_line_numbers: false
  preview_length: 30
`);
    const config = loadConfig(p);
    expect(config.settings.max_chars).toBe(50000);
    expect(config.settings.show_line_numbers).toBe(false);
    expect(config.settings.preview_length).toBe(30);
  });

  it("custom_rules 的 pattern 無法編譯時應拋出錯誤並指出規則（#33）", () => {
    const p = writeTmp(`
custom_rules:
  - description: "ok rule"
    pattern: "EMP-\\\\d{6}"
  - description: "typo rule"
    pattern: "SECRETVALUE["
`);
    expect(() => loadConfig(p)).toThrow(/custom_rules\[1\] \\?"typo rule\\?": pattern does not compile/);
    try {
      loadConfig(p);
    } catch (error) {
      // The pattern may itself be a protected literal; the error must not echo it.
      expect((error as Error).message).not.toContain("SECRETVALUE");
    }
  });

  it("可編譯的 custom_rules pattern 照常載入", () => {
    const p = writeTmp(`
custom_rules:
  - description: "employee id"
    pattern: "\\\\bEMP-\\\\d{6}\\\\b"
    severity: MEDIUM
`);
    const config = loadConfig(p);
    expect(config.custom_rules).toEqual([{ description: "employee id", pattern: "\\bEMP-\\d{6}\\b", severity: "MEDIUM" }]);
  });
});

// ─── 單次讀取：config 與指紋來自同一次檔案讀取 ──────────────────────────────────

describe("loadConfigWithFingerprint() — 單次讀取綁定", () => {
  let tmpFile: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  function writeTmp(content: string): string {
    tmpFile = path.join(os.tmpdir(), `guard-test-${Date.now()}.yaml`);
    fs.writeFileSync(tmpFile, content, "utf-8");
    return tmpFile;
  }

  it("fingerprint 等於設定檔位元組的 sha256", () => {
    const p = writeTmp("settings:\n  max_chars: 50000\n");
    const loaded = loadConfigWithFingerprint(p);
    const bytes = fs.readFileSync(p, "utf-8");
    expect(loaded.fingerprint).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(loaded.configPath).toBe(p);
    expect(loaded.config.settings.max_chars).toBe(50000);
  });

  it("config 與 fingerprint 來自同一次讀取（讀取設定檔恰好一次）", () => {
    const p = writeTmp("settings:\n  max_chars: 50000\n");
    const readSpy = vi.spyOn(fs, "readFileSync");
    loadConfigWithFingerprint(p);
    const readsOfConfig = readSpy.mock.calls.filter(
      ([file]) => String(file) === p,
    );
    expect(readsOfConfig).toHaveLength(1);
  });

  it("明確指定的路徑不存在時丟出錯誤，不以 absent 繼續", () => {
    expect(() => loadConfigWithFingerprint("/nonexistent/path/guard.config.yaml")).toThrow(
      "guard config file not found",
    );
  });

  it("loadConfig() 委派至單次讀取載入器", () => {
    const p = writeTmp("settings:\n  max_chars: 50000\n");
    const viaDelegate = loadConfig(p);
    const viaLoader = loadConfigWithFingerprint(p).config;
    expect(viaDelegate.settings.max_chars).toBe(viaLoader.settings.max_chars);
    expect(viaDelegate.nda_keywords).toEqual(viaLoader.nda_keywords);
  });
});

// ─── zod 4 遷移：預設值、非 mapping 輸入、上限、錯誤不洩漏 ──────────────────────

describe("loadConfig() — zod 4 嚴格性", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function load(content: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-zod4-"));
    const file = path.join(dir, "guard.config.yaml");
    fs.writeFileSync(file, content, "utf-8");
    return loadConfig(file, dir);
  }

  const SETTINGS_DEFAULTS = {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: false,
    env_files: [],
    rule_overrides: {},
    private_cidrs: [],
    allowlist: [],
  };

  it("省略 settings 時內層預設值仍然生效", () => {
    const config = GuardConfigSchema.parse({});
    expect(config.settings).toEqual(SETTINGS_DEFAULTS);
    expect(load("nda_keywords:\n  - X\n").settings).toEqual(SETTINGS_DEFAULTS);
  });

  it("settings: {} 時內層預設值仍然生效", () => {
    expect(GuardConfigSchema.parse({ settings: {} }).settings).toEqual(SETTINGS_DEFAULTS);
    expect(load("settings: {}\n").settings).toEqual(SETTINGS_DEFAULTS);
  });

  it("省略 nda_keywords 保留 4 個預設值；custom_rules: null 得到 []", () => {
    const config = GuardConfigSchema.parse({ custom_rules: null });
    expect(config.nda_keywords).toHaveLength(4);
    expect(config.custom_rules).toEqual([]);
  });

  it.each([
    ["settings 為 YAML 時間戳", "settings: 2024-01-01\n"],
    ["根節點為 YAML 時間戳", "2024-01-01\n"],
    ["settings 為 !!binary", "settings: !!binary aGVsbG8=\n"],
    ["空 YAML", ""],
    ["根節點為純量", "hello\n"],
    ["根節點為清單", "- a\n- b\n"],
  ])("載入失敗（fail-closed）：%s", (_name, content) => {
    expect(() => load(content)).toThrow();
  });

  it("根節點為 Date 時拋出 ZodError（path []），不是 TypeError", () => {
    const result = GuardConfigSchema.safeParse(new Date());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([]);
      expect(result.error.issues[0].message).toBe("expected a mapping");
    }
    let thrown: unknown;
    try {
      GuardConfigSchema.parse(new Date());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(z.ZodError);
  });

  it("null 原型物件（js-yaml !!set 等）仍被接受", () => {
    const settings = Object.assign(Object.create(null), { max_chars: 10 });
    expect(GuardConfigSchema.parse({ settings }).settings.max_chars).toBe(10);
  });

  describe("集合上限", () => {
    const rule = { description: "d", pattern: "p" };
    it("恰好在上限內可接受", () => {
      expect(GuardConfigSchema.safeParse({ nda_keywords: Array(4096).fill("k") }).success).toBe(true);
      expect(GuardConfigSchema.safeParse({ private_domains: Array(4096).fill("a.com") }).success).toBe(true);
      expect(GuardConfigSchema.safeParse({ custom_rules: Array(1024).fill(rule) }).success).toBe(true);
    });
    it("多一筆即拒絕", () => {
      expect(GuardConfigSchema.safeParse({ nda_keywords: Array(4097).fill("k") }).success).toBe(false);
      expect(GuardConfigSchema.safeParse({ private_domains: Array(4097).fill("a.com") }).success).toBe(false);
      expect(GuardConfigSchema.safeParse({ custom_rules: Array(1025).fill(rule) }).success).toBe(false);
    });
  });

  describe("錯誤訊息不洩漏被拒絕的值", () => {
    const SENTINEL = "sk-LEAKCHECK-value";
    const long = SENTINEL + "x".repeat(300);
    const cases: Array<[string, unknown]> = [
      ["rule_overrides 值", { settings: { rule_overrides: { "aws-access-key": SENTINEL } } }],
      ["severity", { custom_rules: [{ description: "d", pattern: "p", severity: SENTINEL }] }],
      ["flags", { custom_rules: [{ description: "d", pattern: "p", flags: SENTINEL }] }],
      ["過長的 nda_keywords 項目", { nda_keywords: [long] }],
      ["過長的 pattern", { custom_rules: [{ description: "d", pattern: long }] }],
    ];

    it.each(cases)("%s", (_name, input) => {
      const result = GuardConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).not.toContain(SENTINEL);
        expect(result.error.message).not.toContain('"input"');
      }
    });

    it("無法編譯的 pattern 訊息不含 pattern 本身", () => {
      const pattern = "(" + SENTINEL;
      const result = GuardConfigSchema.safeParse({ custom_rules: [{ description: "d", pattern }] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("does not compile");
        expect(result.error.message).not.toContain(SENTINEL);
      }
    });
  });

  it("未知 rule_overrides id 與不合法的 private_cidrs 仍被拒絕", () => {
    const unknown = GuardConfigSchema.safeParse({ settings: { rule_overrides: { "no-such-rule": true } } });
    expect(unknown.success).toBe(false);
    if (!unknown.success) expect(unknown.error.message).toContain("unknown builtin rule id");
    const cidr = GuardConfigSchema.safeParse({ settings: { private_cidrs: ["not-a-cidr"] } });
    expect(cidr.success).toBe(false);
    if (!cidr.success) expect(cidr.error.message).toContain("is not a valid IPv4 CIDR");
  });
});

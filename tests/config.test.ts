import { describe, it, expect, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig, loadConfigWithFingerprint } from "../src/config/loader.js";

// The ESM namespace of fs cannot be spied on directly; a transparent spread
// of the actual module keeps everything real while the single-read test can
// intercept readFileSync as seen by the loader.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

// ─── 使用真實設定檔（config/guard.config.yaml）────────────────────────────────

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

describe("loadConfig() — 預設值 fallback", () => {
  it("路徑不存在時應回傳內建預設值", () => {
    const config = loadConfig("/nonexistent/path/guard.config.yaml");
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

  it("沒有設定檔時 fingerprint 為 absent 且回傳預設值", () => {
    const loaded = loadConfigWithFingerprint("/nonexistent/path/guard.config.yaml");
    expect(loaded.fingerprint).toBe("absent");
    expect(loaded.configPath).toBeUndefined();
    expect(loaded.config.settings.max_chars).toBe(200000);
  });

  it("loadConfig() 委派至單次讀取載入器", () => {
    const p = writeTmp("settings:\n  max_chars: 50000\n");
    const viaDelegate = loadConfig(p);
    const viaLoader = loadConfigWithFingerprint(p).config;
    expect(viaDelegate.settings.max_chars).toBe(viaLoader.settings.max_chars);
    expect(viaDelegate.nda_keywords).toEqual(viaLoader.nda_keywords);
  });
});

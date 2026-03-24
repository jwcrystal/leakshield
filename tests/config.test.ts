import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadConfig } from "../src/config/loader.js";

// ─── 使用真實設定檔（config/guard.config.yaml）────────────────────────────────

describe("loadConfig() — 讀取真實設定檔", () => {
  it("應回傳含三個頂層 key 的物件", () => {
    const config = loadConfig();
    expect(config).toHaveProperty("nda_keywords");
    expect(config).toHaveProperty("private_domains");
    expect(config).toHaveProperty("settings");
  });

  it("nda_keywords 應為非空字串陣列", () => {
    const config = loadConfig();
    expect(Array.isArray(config.nda_keywords)).toBe(true);
    expect(config.nda_keywords.length).toBeGreaterThan(0);
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
});

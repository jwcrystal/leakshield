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
    encoding_detection: false, // 預設關閉
  },
};

describe("編碼檢測功能", () => {
  describe("encoding_detection=false (預設)", () => {
    it("不應檢測 Base64 編碼的 API Key", () => {
      const config = { ...defaultConfig };
      const base64Key = Buffer.from("sk-proj-abc123def456").toString("base64");
      const result = scanText(base64Key, config);
      expect(result.safe).toBe(true);
    });
  });

  describe("encoding_detection=true", () => {
    const configWithEncoding: GuardConfig = {
      ...defaultConfig,
      settings: {
        ...defaultConfig.settings,
        encoding_detection: true,
      },
    };

    it("正常文字應正常工作（無編碼）", () => {
      const text = "This is safe content with no encoding";
      const result = scanText(text, configWithEncoding);
      expect(result.safe).toBe(true);
    });

    it("直接出現的 API Key 仍應被檢測", () => {
      const text = "sk-proj-abc123def4567890123456789";
      const result = scanText(text, configWithEncoding);
      expect(result.safe).toBe(false);
      expect(result.findings.some(f => f.type === "API_KEY")).toBe(true);
    });

    it("應檢測明文的 password 關鍵字", () => {
      const text = "password = secret123";
      const result = scanText(text, configWithEncoding);
      expect(result.safe).toBe(false);
      const hasPasswordFinding = result.findings.some(f =>
        f.description.toLowerCase().includes("password")
      );
      expect(hasPasswordFinding).toBe(true);
    });
  });

  describe("配置覆蓋", () => {
    it("應能動態啟用編碼檢測", () => {
      const baseConfig = { ...defaultConfig };
      const runtimeConfig: GuardConfig = {
        ...baseConfig,
        settings: {
          ...baseConfig.settings,
          encoding_detection: true,
        },
      };

      const text = "sk-proj-abc123def4567890123456789";
      const result = scanText(text, runtimeConfig);
      expect(result.safe).toBe(false);
    });
  });

  describe("邊界情況", () => {
    const configWithEncoding: GuardConfig = {
      ...defaultConfig,
      settings: {
        ...defaultConfig.settings,
        encoding_detection: true,
      },
    };

    it("空字串應安全", () => {
      const result = scanText("", configWithEncoding);
      expect(result.safe).toBe(true);
    });

    it("無效輸入不應導致錯誤", () => {
      const invalidBase64 = "!!!invalid-base64!!!";
      const result = scanText(invalidBase64, configWithEncoding);
      // 應該正常處理，不拋出錯誤
      expect(result).toBeDefined();
    });
  });
});

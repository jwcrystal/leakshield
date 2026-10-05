/**
 * Encoding Detection Performance Benchmark
 *
 * 測試編碼檢測功能對掃描效能的影響
 */

import { describe, it } from "vitest";
import { scanText } from "../../src/scanner/engine.js";
import type { GuardConfig } from "../../src/types.js";
import { performance } from "perf_hooks";

const defaultConfig: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL"],
  private_domains: ["internal.corp.com"],
  custom_rules: [],
  settings: {
    max_chars: 200000,
    show_line_numbers: true,
    preview_length: 60,
    encoding_detection: false,
  },
};

const configWithEncoding: GuardConfig = {
  ...defaultConfig,
  settings: {
    ...defaultConfig.settings,
    encoding_detection: true,
  },
};

// 測試內容樣本
const testCases = {
  small: {
    name: "小內容 (1KB)",
    content: "Lorem ipsum dolor sit amet ".repeat(20) + "sk-proj-abc123def456",
    size: "~1KB",
  },
  medium: {
    name: "中等內容 (10KB)",
    content: "Lorem ipsum dolor sit amet ".repeat(200) + "sk-proj-abc123def456",
    size: "~10KB",
  },
  large: {
    name: "大內容 (50KB)",
    content: "Lorem ipsum dolor sit amet ".repeat(1000) + "sk-proj-abc123def456",
    size: "~50KB",
  },
  base64Only: {
    name: "Base64 編碼內容",
    content: "c2stcHJvai1hYmMxMjNkZWY0NTY=".repeat(100),
    size: "~8KB",
  },
  mixed: {
    name: "混合編碼內容",
    content: `
      Normal text: sk-proj-abc123
      Base64: c2stcHJvai1hYmMxMjNkZWY0NTY=
      URL: api_key%3Dsk-proj-xyz
      Normal: password123
    `.repeat(10),
    size: "~5KB",
  },
};

function benchmark(name: string, fn: () => void): number {
  const start = performance.now();
  fn();
  const end = performance.now();
  const duration = end - start;
  console.log(`  ${name}: ${duration.toFixed(2)}ms`);
  return duration;
}

describe("編碼檢測效能基準", () => {
  it("應產生效能報告", () => {
    console.log("\n📊 編碼檢測效能基準測試");
    console.log("=" .repeat(60));

    const results: Record<string, {
      withoutEncoding: number;
      withEncoding: number;
      overhead: number;
      overheadPercent: number;
    }> = {};

    for (const [key, testCase] of Object.entries(testCases)) {
      console.log(`\n${testCase.name} (${testCase.size})`);

      // 測試不啟用編碼檢測
      const timeWithoutEncoding = benchmark("  無編碼檢測", () => {
        for (let i = 0; i < 100; i++) {
          scanText(testCase.content, defaultConfig);
        }
      });

      // 測試啟用編碼檢測
      const timeWithEncoding = benchmark("  啟用編碼檢測", () => {
        for (let i = 0; i < 100; i++) {
          scanText(testCase.content, configWithEncoding);
        }
      });

      // 計算開銷
      const avgWithoutEncoding = timeWithoutEncoding / 100;
      const avgWithEncoding = timeWithEncoding / 100;
      const overhead = avgWithEncoding - avgWithoutEncoding;
      const overheadPercent = (overhead / avgWithoutEncoding) * 100;

      results[key] = {
        withoutEncoding: avgWithoutEncoding,
        withEncoding: avgWithEncoding,
        overhead,
        overheadPercent,
      };

      console.log(`  平均開銷: ${overhead.toFixed(2)}ms (${overheadPercent.toFixed(1)}%)`);
    }

    // 生成摘要報告
    console.log("\n" + "=".repeat(60));
    console.log("📈 效能摘要報告");
    console.log("=".repeat(60));

    console.log("\n平均掃描時間 (單次):");
    console.table(
      Object.entries(results).map(([key, data]) => ({
        測試案例: testCases[key as keyof typeof testCases].name,
        "無編碼檢測 (ms)": data.withoutEncoding.toFixed(2),
        "啟用編碼檢測 (ms)": data.withEncoding.toFixed(2),
        "額外開銷 (ms)": data.overhead.toFixed(2),
        "開銷百分比 (%)": data.overheadPercent.toFixed(1),
      }))
    );

    const avgOverheadPercent = Object.values(results)
      .reduce((sum, r) => sum + r.overheadPercent, 0) / Object.values(results).length;

    console.log(`\n平均額外開銷: ${avgOverheadPercent.toFixed(1)}%`);

    // 結論
    console.log("\n💡 效能建議:");
    if (avgOverheadPercent < 10) {
      console.log("  ✅ 編碼檢測開銷很小 (<10%)，建議預設啟用");
    } else if (avgOverheadPercent < 30) {
      console.log("  ⚠️ 編碼檢測開銷中等 (10-30%)，建議按需啟用");
    } else {
      console.log("  ❌ 編碼檢測開銷較大 (>30%)，建議僅在必要時啟用");
    }
    console.log("  📌 小內容受影響較小，大內容開銷較明顯");
    console.log("  🔒 安全性 > 效能：攔截編碼攻擊的價值值得開銷");
  });

  it("應測試不同內容類型的效能差異", () => {
    console.log("\n🔍 內容類型效能分析");
    console.log("-".repeat(60));

    const contentTypes = {
      "純文字": "Lorem ipsum ".repeat(1000),
      "含 API Key": "Lorem ipsum ".repeat(999) + "sk-proj-abc123def456",
      "含 Email": "Lorem ipsum ".repeat(999) + "user@example.com",
      "多個敏感項": "Lorem ipsum ".repeat(998) + "sk-proj-abc user@example.com password123",
    };

    console.log("啟用編碼檢測時，不同內容類型的掃描時間 (100次平均):\n");

    for (const [type, content] of Object.entries(contentTypes)) {
      const time = benchmark(type, () => {
        for (let i = 0; i < 100; i++) {
          scanText(content, configWithEncoding);
        }
      });

      const avgTime = time / 100;
      console.log(`  平均: ${avgTime.toFixed(2)}ms`);
    }
  });

  it("應測試編碼檢測的額外開銷", () => {
    console.log("\n🚀 編碼檢測開銷詳細分析");
    console.log("-".repeat(60));

    // 測試只有編碼內容的情況
    const base64Content = "c2stcHJvai1hYmMxMjM=";

    const base64Time = benchmark("Base64 編碼", () => {
      for (let i = 0; i < 100; i++) {
        scanText(base64Content, configWithEncoding);
      }
    });

    // 測試正常文字的開銷
    const normalContent = "Lorem ipsum dolor sit amet";
    const normalTime = benchmark("正常文字", () => {
      for (let i = 0; i < 100; i++) {
        scanText(normalContent, configWithEncoding);
      }
    });

    console.log("\n💡 結論:");
    console.log(`  Base64 編碼內容平均掃描時間: ${(base64Time / 100).toFixed(2)}ms`);
    console.log(`  正常文字平均掃描時間: ${(normalTime / 100).toFixed(2)}ms`);
    console.log(`  差異: ${((base64Time - normalTime) / 100).toFixed(2)}ms`);
  });
});

import type { GuardConfig, Finding, ScanResult } from "../types.js";
import { BUILTIN_RULES } from "../rules/builtin.js";
import { buildDynamicRules } from "../rules/dynamic.js";
import { redact, getLineCol } from "./utils.js";

export function scanText(text: string, config: GuardConfig): ScanResult {
  const truncated = text.slice(0, config.settings.max_chars);
  const allRules = [...BUILTIN_RULES, ...buildDynamicRules(config)];
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const rule of allRules) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(truncated)) !== null) {
      const matchedText = match[0];
      const key = `${rule.type}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { line, col } = getLineCol(truncated, match.index);
      const preview = redact(matchedText, config.settings.preview_length);

      findings.push({
        type: rule.type,
        severity: rule.severity,
        line: config.settings.show_line_numbers ? line : undefined,
        column: config.settings.show_line_numbers ? col : undefined,
        preview,
        description: rule.description,
      });
    }
  }

  const safe = findings.length === 0;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const medCount = findings.filter((f) => f.severity === "MEDIUM").length;

  const summary = safe
    ? "✅ 未偵測到敏感內容，可以安全傳送。"
    : `🚨 發現 ${findings.length} 個潛在敏感項目（HIGH: ${highCount}, MEDIUM: ${medCount}, LOW: ${findings.length - highCount - medCount}）`;

  const recommendation = safe
    ? "內容看起來安全，但仍請確認沒有業務邏輯上的機密資訊。"
    : "⛔ 建議先處理上述敏感項目後再傳送給 AI 服務。請用假資料、佔位符或移除敏感欄位後再重試。";

  return { safe, total_findings: findings.length, findings, summary, recommendation };
}

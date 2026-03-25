import type { GuardConfig, Finding, ScanResult, RedactResult, Rule } from "../types.js";
import { BUILTIN_RULES } from "../rules/builtin.js";
import { buildDynamicRules } from "../rules/dynamic.js";
import { redact, getLineCol, getIgnoredLines } from "./utils.js";

// Dynamic rules are derived from config; cache per config object so they are
// rebuilt only when the config reference changes (e.g. after reload_config).
const dynamicCache = new WeakMap<GuardConfig, Rule[]>();

function getRules(config: GuardConfig): Rule[] {
  let dynamic = dynamicCache.get(config);
  if (!dynamic) {
    dynamic = buildDynamicRules(config);
    dynamicCache.set(config, dynamic);
  }
  return [...BUILTIN_RULES, ...dynamic];
}

export function scanText(text: string, config: GuardConfig): ScanResult {
  const truncated = text.slice(0, config.settings.max_chars);
  const allRules = getRules(config);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const ignoredLines = getIgnoredLines(truncated);

  for (const rule of allRules) {
    // Reuse the compiled RegExp; reset lastIndex before each scan so the
    // stateful global flag starts from the beginning of the input.
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.pattern.exec(truncated)) !== null) {
      const matchedText = match[0];
      const key = `${rule.type}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { line, col } = getLineCol(truncated, match.index);
      if (ignoredLines.has(line)) continue;

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

export function redactText(text: string, config: GuardConfig): RedactResult {
  const truncated = text.slice(0, config.settings.max_chars);
  const allRules = getRules(config);
  const ignoredLines = getIgnoredLines(truncated);

  type MatchEntry = { index: number; length: number; type: string };
  const matches: MatchEntry[] = [];
  const seen = new Set<string>();

  for (const rule of allRules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(truncated)) !== null) {
      const key = `${match.index}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { line } = getLineCol(truncated, match.index);
      if (ignoredLines.has(line)) continue;
      matches.push({ index: match.index, length: match[0].length, type: rule.type });
    }
  }

  // Sort descending by index so later replacements don't shift earlier offsets
  matches.sort((a, b) => b.index - a.index);
  let redacted = truncated;
  for (const m of matches) {
    redacted = redacted.slice(0, m.index) + `[REDACTED_${m.type}]` + redacted.slice(m.index + m.length);
  }

  const { findings, total_findings } = scanText(text, config);
  const summary = total_findings === 0
    ? "✅ 未偵測到敏感內容，無需脫敏。"
    : `🔒 已脫敏 ${total_findings} 個敏感項目。`;

  return { redacted, findings, total_findings, summary };
}

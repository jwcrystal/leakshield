import type { GuardConfig, Finding, ScanResult, RedactResult, Rule } from "../types.js";
import { BUILTIN_RULES } from "../rules/builtin.js";
import { buildDynamicRules } from "../rules/dynamic.js";
import { redact, getLineCol, getIgnoredLines } from "./utils.js";
import { t } from "../i18n/index.js";
import * as encoding from "./encoding.js";
import { sanitizeForScanning, isLikelyHomographAttack, detectSuspiciousUnicode } from "./unicode.js";

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
  // Step 1: Check for truncation
  const wasTruncated = text.length > config.settings.max_chars;
  const truncated = text.slice(0, config.settings.max_chars);

  const allRules = getRules(config);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const ignoredLines = getIgnoredLines(truncated);

  // Step 2: Scan for suspicious Unicode patterns ONLY if there's an actual threat
  // This doesn't modify the text, just detects issues
  const suspicious = detectSuspiciousUnicode(truncated);
  if (suspicious.hasZeroWidth || suspicious.hasHomographs) {
    // Only add Unicode finding if there's a clear attack pattern
    findings.push({
      type: "CUSTOM",
      severity: suspicious.hasZeroWidth ? "HIGH" : "MEDIUM",
      line: 1,
      column: 1,
      preview: "****",
      description: suspicious.hasZeroWidth
        ? "檢測到零寬字符 (可能用於繞過敏感資料檢測)"
        : "檢測到可疑的 Unicode 字符 (可能的同形異義字攻擊)",
      match_start: 0,
      match_end: truncated.length,
      match_text: truncated.substring(0, 50), // Only store first 50 chars
      unicode_detected: {
        had_zero_width: suspicious.hasZeroWidth,
        had_homographs: suspicious.hasHomographs,
        details: suspicious.details,
      },
    } as any);
  }

  // Step 3: Regular pattern scanning on the original text
  // We scan the original text, not normalized, to preserve accurate offsets
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
        match_start: match.index,
        match_end: match.index + matchedText.length,
        match_text: matchedText,
      });
    }
  }

  const safe = findings.length === 0;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const medCount = findings.filter((f) => f.severity === "MEDIUM").length;

  const summary = safe
    ? t("scan.safe_summary")
    : t("scan.unsafe_summary", {
        count: findings.length,
        high: highCount,
        med: medCount,
        low: findings.length - highCount - medCount,
      });

  const recommendation = safe
    ? t("scan.safe_recommendation")
    : t("scan.unsafe_recommendation");

  // Add warnings for Unicode issues and truncation
  const warnings = [];
  if (suspicious.hasZeroWidth) warnings.push("零寬字符");
  if (suspicious.hasHomographs) warnings.push("可疑 Unicode");
  if (wasTruncated) warnings.push("內容截斷");

  const finalSummary = warnings.length > 0
    ? summary + ` [WARNING: ${warnings.join(', ')}]`
    : summary;

  return {
    safe,
    total_findings: findings.length,
    findings,
    summary: finalSummary,
    recommendation,
    was_truncated: wasTruncated || undefined,
  };
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
    ? t("redact.safe_summary")
    : t("redact.unsafe_summary", { count: total_findings });

  return { redacted, findings, total_findings, summary };
}

// ─── Export utilities ───────────────────────────────────────────────────────────

export { scanTextWithDecoding } from "./encoding.js";
export type { ScanWithDecodingResult } from "./encoding.js";

export {
  sanitizeForScanning,
  isLikelyHomographAttack,
  detectSuspiciousUnicode,
} from "./unicode.js";

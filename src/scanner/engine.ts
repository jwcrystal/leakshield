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

type MatchEntry = { index: number; length: number; type: string };

function getRules(config: GuardConfig): Rule[] {
  let dynamic = dynamicCache.get(config);
  if (!dynamic) {
    dynamic = buildDynamicRules(config);
    dynamicCache.set(config, dynamic);
  }
  return [...BUILTIN_RULES, ...dynamic];
}

function hasMatchingRange(findings: readonly Finding[], index: number, length: number): boolean {
  return findings.some((finding) => finding.match_start === index && finding.match_end === index + length);
}

function collapseOverlappingMatches(matches: readonly MatchEntry[]): MatchEntry[] {
  const sorted = [...matches].sort((left, right) => left.index - right.index || right.length - left.length);
  const groups = sorted.reduce<Array<{ start: number; end: number; representative: MatchEntry }>>(
    (collapsed, match) => {
      const previous = collapsed.at(-1);
      const matchEnd = match.index + match.length;
      if (!previous || match.index >= previous.end) {
        return [...collapsed, { start: match.index, end: matchEnd, representative: match }];
      }

      const representative = match.length > previous.representative.length
        ? match
        : previous.representative;
      return [
        ...collapsed.slice(0, -1),
        { start: previous.start, end: Math.max(previous.end, matchEnd), representative },
      ];
    },
    [],
  );

  return groups
    .map(({ start, end, representative }) => ({
      index: start,
      length: end - start,
      type: representative.type,
    }))
    .sort((left, right) => right.index - left.index);
}

function addExactValueFindings(
  text: string,
  config: GuardConfig,
  ignoredLines: ReadonlySet<number>,
  findings: Finding[],
): void {
  const detector = config.exact_value_detector;
  if (!detector) return;

  for (const match of detector.findAll(text)) {
    if (hasMatchingRange(findings, match.index, match.length)) continue;
    const { line, col } = getLineCol(text, match.index);
    if (ignoredLines.has(line)) continue;
    findings.push({
      type: "ENV_SECRET",
      severity: "HIGH",
      line: config.settings.show_line_numbers ? line : undefined,
      column: config.settings.show_line_numbers ? col : undefined,
      preview: "****",
      description: "Value from configured env file",
      match_start: match.index,
      match_end: match.index + match.length,
      match_text: text.slice(match.index, match.index + match.length),
    });
  }
}

/**
 * Options shared by the scanning entry points.
 */
export interface ScanOptions {
  /**
   * When false, in-text ignore directives (`// sg-ignore` and friends) are NOT
   * honored and every line is scanned. The model boundary (protectText /
   * deidentifyText) must always pass false — prompt or tool text could
   * otherwise carry a directive and sail through raw (fail-open bypass).
   * The CLI/Web transports keep the default (true), which is their contract.
   */
  honorIgnoreDirectives?: boolean;
}

function honorDirectives(opts?: ScanOptions): boolean {
  return opts?.honorIgnoreDirectives !== false;
}

/**
 * Internal scan function without encoding detection.
 * Used by scanTextWithDecoding to avoid infinite recursion.
 */
function scanTextInternal(text: string, config: GuardConfig, opts?: ScanOptions): ScanResult {
  // Step 1: Check for truncation
  const wasTruncated = text.length > config.settings.max_chars;
  const truncated = text.slice(0, config.settings.max_chars);

  const allRules = getRules(config);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const ignoredLines = honorDirectives(opts) ? getIgnoredLines(truncated) : new Set<number>();

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

  addExactValueFindings(truncated, config, ignoredLines, findings);

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

export function scanText(text: string, config: GuardConfig, opts?: ScanOptions): ScanResult {
  // If encoding detection is enabled, use the enhanced scanner
  if (config.settings.encoding_detection) {
    const result = encoding.scanTextWithDecoding(text, config, opts);

    // Generate proper summary based on merged results
    const safe = result.safe;
    const highCount = result.findings.filter((f) => f.severity === "HIGH").length;
    const medCount = result.findings.filter((f) => f.severity === "MEDIUM").length;
    const lowCount = result.findings.length - highCount - medCount;

    const summary = safe
      ? t("scan.safe_summary")
      : t("scan.unsafe_summary", {
          count: result.findings.length,
          high: highCount,
          med: medCount,
          low: lowCount,
        });

    const recommendation = safe
      ? t("scan.safe_recommendation")
      : t("scan.unsafe_recommendation");

    // Add warnings for encoding detection and truncation
    const warnings = [];
    if (result.was_decoded) {
      warnings.push(`編碼檢測: ${result.encoding_types_found.join(', ')}`);
    }
    if (result.original.was_truncated) {
      warnings.push("內容截斷");
    }

    const finalSummary = warnings.length > 0
      ? summary + ` [WARNING: ${warnings.join(', ')}]`
      : summary;

    return {
      safe,
      total_findings: result.total_findings,
      findings: result.findings,
      summary: finalSummary,
      recommendation,
      was_truncated: result.original.was_truncated,
    };
  }

  // Otherwise, use internal scan without encoding detection
  return scanTextInternal(text, config, opts);
}

// ─── Export scanTextInternal for use by encoding.ts ─────────────────────────────
export { scanTextInternal };

/** A UTF-16 code-unit span, half-open [start, end). */
export interface Utf16Span {
  start: number;
  end: number;
}

function overlapsSpan(start: number, end: number, spans: readonly Utf16Span[]): boolean {
  return spans.some((span) => start < span.end && span.start < end);
}

export function redactText(
  text: string,
  config: GuardConfig,
  opts?: ScanOptions,
  /**
   * Spans that must never be rewritten by redaction (validated issued
   * placeholders). A match that merely OVERLAPS one of these spans is
   * skipped, not redacted: redacting it would corrupt the protected value,
   * and leaving it unredacted lets the verification pass report it as a
   * crossing residual and fail closed. Only fully contained matches are
   * exempt from residual reporting (see filterResidualFindings).
   */
  protectedSpans: readonly Utf16Span[] = [],
): RedactResult {
  const truncated = text.slice(0, config.settings.max_chars);
  const allRules = getRules(config);
  const ignoredLines = honorDirectives(opts) ? getIgnoredLines(truncated) : new Set<number>();

  const matches: MatchEntry[] = [];
  const seen = new Set<string>();

  for (const rule of allRules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(truncated)) !== null) {
      if (overlapsSpan(match.index, match.index + match[0].length, protectedSpans)) continue;
      const key = `${match.index}:${match[0].length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const { line } = getLineCol(truncated, match.index);
      if (ignoredLines.has(line)) continue;
      matches.push({ index: match.index, length: match[0].length, type: rule.type });
    }
  }

  const detector = config.exact_value_detector;
  if (detector) {
    for (const match of detector.findAll(truncated)) {
      if (overlapsSpan(match.index, match.index + match.length, protectedSpans)) continue;
      if (matches.some((entry) => entry.index === match.index && entry.length === match.length)) continue;
      const { line } = getLineCol(truncated, match.index);
      if (ignoredLines.has(line)) continue;
      matches.push({ index: match.index, length: match.length, type: "ENV_SECRET" });
    }
  }

  let redacted = truncated;
  for (const m of collapseOverlappingMatches(matches)) {
    redacted = redacted.slice(0, m.index) + `[REDACTED_${m.type}]` + redacted.slice(m.index + m.length);
  }

  const { findings, total_findings } = scanText(text, config, opts);
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

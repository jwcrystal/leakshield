import type { GuardConfig, Finding, ScanResult, RedactResult, Rule } from "../types.js";
import { BUILTIN_RULES } from "../rules/builtin.js";
import { buildDynamicRules } from "../rules/dynamic.js";
import { allowSet, isAllowlisted, noteAllowlistSuppression } from "./allowlist.js";
import { containsAddressInRun, parseCidrList } from "./cidr.js";
import { redact, createLineIndex, lineColAt, getIgnoredLines } from "./utils.js";
import { t } from "../i18n/index.js";
import * as encoding from "./encoding.js";
import { sanitizeForScanning, isLikelyHomographAttack, detectSuspiciousUnicode, foldConfusables } from "./unicode.js";

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
  // Built-in rule toggle: an explicit override wins; otherwise opt-in rules
  // stay off and the rest stay on. Ids are validated at config load, so any
  // builtin without an id would silently become always-on — tests forbid that.
  const overrides = config.settings.rule_overrides ?? {};
  const activeBuiltins = BUILTIN_RULES.filter(
    (rule) => (rule.id !== undefined && rule.id in overrides ? overrides[rule.id] : !rule.optIn),
  );
  // The private-range rule is the only builtin whose verdict depends on
  // configuration. Bind the configured networks here so the shared rule object
  // stays constant and an empty list still means the documented defaults.
  const privateNetworks = parseCidrList(config.settings.private_cidrs);
  const configuredBuiltins = activeBuiltins.map((rule) =>
    rule.id === "private-ipv4"
      ? { ...rule, validate: (match: string) => containsAddressInRun(privateNetworks, match) }
      : rule,
  );
  return [...configuredBuiltins, ...dynamic];
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
  lineStarts: readonly number[],
  config: GuardConfig,
  ignoredLines: ReadonlySet<number>,
  findings: Finding[],
): void {
  const detector = config.exact_value_detector;
  if (!detector) return;
  const globalAllow = allowSet(config.settings.allowlist);

  for (const match of detector.findAll(text)) {
    if (hasMatchingRange(findings, match.index, match.length)) continue;
    const { line, col } = lineColAt(lineStarts, match.index);
    if (ignoredLines.has(line)) continue;
    const matchedText = text.slice(match.index, match.index + match.length);
    if (isAllowlisted(matchedText, globalAllow, undefined)) {
      noteAllowlistSuppression();
      continue;
    }
    findings.push({
      type: "ENV_SECRET",
      severity: "HIGH",
      line: config.settings.show_line_numbers ? line : undefined,
      column: config.settings.show_line_numbers ? col : undefined,
      preview: "****",
      description: "Value from configured env file",
      match_start: match.index,
      match_end: match.index + match.length,
      match_text: matchedText,
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

/** Invisible format characters that can splice a value so the rules miss it. */
export const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;

const SEVERITY_RANK: Record<Finding["severity"], number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Rule and exact-value findings for one text, in rule order. Rules of one type
 * matching at one offset report one finding: the highest severity, over the
 * longest span. Rule order must not decide either, or a LOW rule listed first
 * would downgrade the decision and leave the tail of a longer match unmasked.
 */
function collectRuleFindings(
  text: string,
  rules: ReturnType<typeof getRules>,
  config: GuardConfig,
  ignoredLines: Set<number>,
): Finding[] {
  const lineStarts = createLineIndex(text);
  const findings: Finding[] = [];
  const findingAtOffset = new Map<string, Finding>();
  const globalAllow = allowSet(config.settings.allowlist);
  for (const rule of rules) {
    // Start from the beginning. matchAll advances after empty matches (by a
    // code point under /u); exec alone leaves lastIndex unchanged and can hang.
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      // A zero-width match contains no value to report or mask. Skip it before
      // dedupe, validation or suppression, without losing later real matches.
      if (match[0].length === 0) continue;
      const offset = rule.skipPrefix ?? 0;
      const matchedText = match[0].slice(offset);
      const start = match.index + offset;
      if (rule.validate !== undefined && !rule.validate(matchedText, { text, index: start })) continue;
      const end = match.index + match[0].length;

      const { line, col } = lineColAt(lineStarts, start);
      if (ignoredLines.has(line)) continue;
      if (isAllowlisted(matchedText, globalAllow, rule.allow)) {
        noteAllowlistSuppression();
        // Do NOT reserve the dedupe key: another rule may match a longer span
        // at the same offset, and suppressing the short one must not hide it.
        continue;
      }

      const preview = redact(matchedText, config.settings.preview_length);

      const key = `${rule.type}:${start}`;
      const earlier = findingAtOffset.get(key);
      if (earlier) {
        if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[earlier.severity]) {
          earlier.severity = rule.severity;
          earlier.description = rule.description;
        }
        if (end > (earlier.match_end ?? 0)) {
          earlier.preview = preview;
          earlier.match_end = end;
          earlier.match_text = matchedText;
        }
        continue;
      }

      const finding: Finding = {
        type: rule.type,
        severity: rule.severity,
        line: config.settings.show_line_numbers ? line : undefined,
        column: config.settings.show_line_numbers ? col : undefined,
        preview,
        description: rule.description,
        match_start: start,
        match_end: end,
        match_text: matchedText,
      };
      findingAtOffset.set(key, finding);
      findings.push(finding);
    }
  }

  addExactValueFindings(text, lineStarts, config, ignoredLines, findings);
  return findings;
}

/**
 * True when `transform` (an evasion-undoing normalization that never moves
 * line breaks) makes the rules find something the raw text does not. Raw
 * findings are compared by type and transformed matched text, so a value that
 * is already detected raw does not count twice.
 */
function transformHidesFinding(
  text: string,
  transform: (value: string) => string,
  rawFindings: readonly Finding[],
  rules: ReturnType<typeof getRules>,
  config: GuardConfig,
  ignoredLines: Set<number>,
): boolean {
  const transformed = transform(text);
  if (transformed === text) return false;
  const identity = (finding: Finding): string => `${finding.type}\0${transform(finding.match_text ?? "")}`;
  const unmatched = new Map<string, number>();
  for (const finding of rawFindings) {
    const id = identity(finding);
    unmatched.set(id, (unmatched.get(id) ?? 0) + 1);
  }
  for (const finding of collectRuleFindings(transformed, rules, config, ignoredLines)) {
    const id = identity(finding);
    const remaining = unmatched.get(id) ?? 0;
    if (remaining === 0) return true;
    unmatched.set(id, remaining - 1);
  }
  return false;
}

const stripZeroWidth = (value: string): string => value.replace(ZERO_WIDTH_CHARS, "");

/**
 * Zero-width characters are common in harmless text: emoji ZWJ sequences, a
 * BOM at the start of a file, ZWNJ in Persian. They only matter when they
 * splice a sensitive value so the rules miss it (`pass\u200Dword=…`, a key
 * split by ZWSP). Strip them, rescan, and report only when the stripped text
 * yields a finding the raw text does not. Line breaks are untouched, so the
 * raw text's ignored lines still apply.
 */
function zeroWidthHidesFinding(
  text: string,
  rawFindings: readonly Finding[],
  rules: ReturnType<typeof getRules>,
  config: GuardConfig,
  ignoredLines: Set<number>,
): boolean {
  return transformHidesFinding(text, stripZeroWidth, rawFindings, rules, config, ignoredLines);
}

/**
 * Cyrillic and Greek text is common and harmless in source code: locale
 * files, comments, UI strings, math. Look-alike letters only matter when they
 * disguise a sensitive value (`рassword=…` with a Cyrillic `р`, an `sk-` key
 * with a Greek `κ`). Fold confusables to Latin (zero-width characters removed
 * too, so a combined splice is caught), rescan, and report only when the
 * folded text yields a finding the raw text does not (issue #46).
 */
function homoglyphHidesFinding(
  text: string,
  rawFindings: readonly Finding[],
  rules: ReturnType<typeof getRules>,
  config: GuardConfig,
  ignoredLines: Set<number>,
): boolean {
  // Text with zero-width characters but no look-alikes was already judged by
  // zeroWidthHidesFinding; skip the identical rescan.
  if (foldConfusables(text) === text) return false;
  const fold = (value: string): string => foldConfusables(stripZeroWidth(value));
  return transformHidesFinding(text, fold, rawFindings, rules, config, ignoredLines);
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
  const ignoredLines = honorDirectives(opts) ? getIgnoredLines(truncated) : new Set<number>();

  // Step 2: Regular pattern scanning on the original text
  // We scan the original text, not normalized, to preserve accurate offsets
  const ruleFindings = collectRuleFindings(truncated, allRules, config, ignoredLines);

  // Step 3: Flag suspicious Unicode only when it is an actual threat. This
  // doesn't modify the text, just detects issues.
  const zeroWidthEvasion = zeroWidthHidesFinding(truncated, ruleFindings, allRules, config, ignoredLines);
  const homoglyphEvasion =
    !zeroWidthEvasion && homoglyphHidesFinding(truncated, ruleFindings, allRules, config, ignoredLines);
  const findings: Finding[] = [];
  if (zeroWidthEvasion || homoglyphEvasion) {
    findings.push({
      type: "CUSTOM",
      severity: "HIGH",
      line: 1,
      column: 1,
      preview: "****",
      description: zeroWidthEvasion
        ? "檢測到零寬字符藏住敏感資料 (可能用於繞過敏感資料檢測)"
        : "檢測到可疑的 Unicode 字符 (可能的同形異義字攻擊)",
      match_start: 0,
      match_end: truncated.length,
      match_text: truncated.substring(0, 50), // Only store first 50 chars
      unicode_detected: {
        had_zero_width: zeroWidthEvasion,
        had_homographs: homoglyphEvasion,
        details: [zeroWidthEvasion ? "zero-width characters hide a finding" : "look-alike letters hide a finding"],
      },
    } as any);
  }
  findings.push(...ruleFindings);

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
  if (zeroWidthEvasion) warnings.push("零寬字符");
  if (homoglyphEvasion) warnings.push("可疑 Unicode");
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
  const truncatedLineStarts = createLineIndex(truncated);

  const matches: MatchEntry[] = [];
  const seen = new Set<string>();
  const globalAllow = allowSet(config.settings.allowlist);

  for (const rule of allRules) {
    rule.pattern.lastIndex = 0;
    // Keep the same progress and empty-span contract as collectRuleFindings.
    for (const match of truncated.matchAll(rule.pattern)) {
      if (match[0].length === 0) continue;
      const offset = rule.skipPrefix ?? 0;
      const start = match.index + offset;
      const end = match.index + match[0].length;
      const matchedText = match[0].slice(offset);
      if (rule.validate !== undefined && !rule.validate(matchedText, { text: truncated, index: start })) continue;
      if (overlapsSpan(start, end, protectedSpans)) continue;
      const key = `${start}:${end - start}`;
      if (seen.has(key)) continue;
      const { line } = lineColAt(truncatedLineStarts, start);
      if (ignoredLines.has(line)) continue;
      // An allowlisted literal is left as written, exactly as the scanner leaves
      // it unreported; redacting it would contradict the bypass the user chose.
      if (isAllowlisted(matchedText, globalAllow, rule.allow)) continue;
      seen.add(key);
      matches.push({ index: start, length: end - start, type: rule.type });
    }
  }

  const detector = config.exact_value_detector;
  if (detector) {
    for (const match of detector.findAll(truncated)) {
      if (overlapsSpan(match.index, match.index + match.length, protectedSpans)) continue;
      if (matches.some((entry) => entry.index === match.index && entry.length === match.length)) continue;
      const { line } = lineColAt(truncatedLineStarts, match.index);
      if (ignoredLines.has(line)) continue;
      const matchedText = truncated.slice(match.index, match.index + match.length);
      if (isAllowlisted(matchedText, globalAllow, undefined)) continue;
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

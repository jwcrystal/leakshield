/**
 * Redaction helpers — deterministic replacement of sensitive spans
 * and safe preview generation.
 *
 * Internal match metadata (match_start, match_end, match_text) is used
 * for replacement but MUST NOT be exposed via transport-facing outputs.
 */

import type { Finding, FindingType, GuardConfig, ScanResult, RedactResult } from "../types.js";

// ─── Transport-safe types ─────────────────────────────────────────────────────

/** Keys that are internal-only and must never appear in transport-facing outputs. */
const INTERNAL_FINDING_KEYS = ["match_start", "match_end", "match_text"] as const;
type InternalFindingKey = (typeof INTERNAL_FINDING_KEYS)[number];

/** A finding with internal metadata stripped — safe for transport serialization. */
export type TransportSafeFinding = Omit<Finding, InternalFindingKey>;

/** A ScanResult with transport-safe findings. */
export interface TransportSafeScanResult
  extends Omit<ScanResult, "findings"> {
  findings: TransportSafeFinding[];
}

/** A RedactResult with transport-safe findings. */
export interface TransportSafeRedactResult
  extends Omit<RedactResult, "findings"> {
  findings: TransportSafeFinding[];
}

// ─── Sanitization API ─────────────────────────────────────────────────────────

/**
 * Strip internal match metadata from a single finding.
 * The returned object is safe to serialize to transport consumers.
 */
export function sanitizeFindingForExport(
  f: Finding,
): TransportSafeFinding {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { match_start: _ms, match_end: _me, match_text: _mt, ...safe } = f;
  return safe;
}

/**
 * Strip internal match metadata from an array of findings.
 */
export function sanitizeFindingsForExport(
  findings: readonly Finding[],
): TransportSafeFinding[] {
  return findings.map(sanitizeFindingForExport);
}

/**
 * Produce a transport-safe copy of a ScanResult by stripping internal
 * match metadata from every finding.
 */
export function sanitizeScanResultForExport(
  result: ScanResult,
): TransportSafeScanResult {
  return { ...result, findings: sanitizeFindingsForExport(result.findings) };
}

/**
 * Produce a transport-safe copy of a RedactResult by stripping internal
 * match metadata from every finding.
 */
export function sanitizeRedactResultForExport(
  result: RedactResult,
): TransportSafeRedactResult {
  return { ...result, findings: sanitizeFindingsForExport(result.findings) };
}

// ─── Placeholder mapping ─────────────────────────────────────────────────────

const PLACEHOLDER_MAP: Record<FindingType, string> = {
  API_KEY: "[REDACTED_API_KEY]",
  SECRET: "[REDACTED_PASSWORD]",
  TOKEN: "[REDACTED_TOKEN]",
  PII_EMAIL: "[REDACTED_EMAIL]",
  PII_PHONE_TW: "[REDACTED_PHONE]",
  PII_PHONE_INTL: "[REDACTED_PHONE]",
  PII_ID_TW: "[REDACTED_ID]",
  PII_PASSPORT: "[REDACTED_PASSPORT]",
  PII_SSN: "[REDACTED_SSN]",
  TW_BUSINESS_NO: "[REDACTED_BUSINESS_NO]",
  DB_CONNECTION: "[REDACTED_DB_CONNECTION]",
  PRIVATE_DOMAIN: "[REDACTED_PRIVATE_DOMAIN]",
  NDA_KEYWORD: "[REDACTED_NDA_TERM]",
  ENV_SECRET: "[REDACTED_ENV_SECRET]",
  // 與 engine.ts 的 `[REDACTED_${type}]` 產生規則保持同形
  PII_CREDIT_CARD: "[REDACTED_PII_CREDIT_CARD]",
  PII_IBAN: "[REDACTED_PII_IBAN]",
  PII_IP: "[REDACTED_PII_IP]",
  PII_URL: "[REDACTED_PII_URL]",
  // 編碼過的片段（Base64 / hex / percent-run）；只由 pseudonymization 的定位器產生
  ENCODED: "[REDACTED_ENCODED]",
  CUSTOM: "[REDACTED_CUSTOM]",
};

// ─── Span types ──────────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
  placeholder: string;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Validate that all findings carry the match metadata needed for
 * deterministic replacement. Returns the validated spans or undefined
 * if any finding is missing required fields.
 */
function extractSpans(findings: readonly Finding[]): Span[] | undefined {
  const spans: Span[] = [];

  for (const f of findings) {
    if (
      f.match_start === undefined ||
      f.match_end === undefined ||
      f.match_text === undefined
    ) {
      return undefined;
    }
    spans.push({
      start: f.match_start,
      end: f.match_end,
      placeholder: PLACEHOLDER_MAP[f.type],
    });
  }

  return spans;
}

/**
 * Sort spans by start position ascending, then merge overlapping/adjacent spans.
 * When spans overlap, the earlier-starting span wins; for equal starts, the longer span absorbs the shorter one.
 */
function sortAndMergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];

  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Span[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];

    if (current.start <= last.end) {
      // Overlapping or adjacent — extend the previous span if needed
      if (current.end > last.end) {
        merged[merged.length - 1] = { ...last, end: current.end };
      }
      // Otherwise the current span is fully contained; skip it
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Apply sorted, non-overlapping spans to the original content,
 * replacing each span with its placeholder.
 */
function applyReplacements(content: string, spans: Span[]): string {
  // Build result by walking the content forward
  const parts: string[] = [];
  let cursor = 0;

  for (const span of spans) {
    if (span.start < cursor) continue; // skip fully contained spans
    parts.push(content.slice(cursor, span.start));
    parts.push(span.placeholder);
    cursor = span.end;
  }

  parts.push(content.slice(cursor));
  return parts.join("");
}

// ─── Public API ──────────────────────────────────────────────────────────────

const DEFAULT_PREVIEW_LENGTH = 60;

/**
 * Build a safe preview of the original content.
 *
 * Returns a masked excerpt centered around the first finding,
 * respecting `preview_length` from config (default 60).
 * Returns undefined when no findings or no match metadata is available.
 */
export function buildSafePreview(
  originalContent: string,
  findings: readonly Finding[],
  config?: GuardConfig,
): string | undefined {
  if (findings.length === 0) return undefined;

  const spans = extractSpans(findings);
  if (spans === undefined || spans.length === 0) return undefined;

  const previewLength =
    config?.settings.preview_length ?? DEFAULT_PREVIEW_LENGTH;

  // Sort and merge for accurate replacement
  const merged = sortAndMergeSpans(spans);

  // Determine the window around the first finding
  const firstSpan = merged[0];
  const contentLength = originalContent.length;

  // Calculate window: try to center around the first finding
  const spanLength = firstSpan.end - firstSpan.start;
  const placeholderLen = firstSpan.placeholder.length;
  const contextBudget = Math.max(0, previewLength - placeholderLen);
  const halfContext = Math.floor(contextBudget / 2);

  let windowStart = Math.max(0, firstSpan.start - halfContext);
  let windowEnd = windowStart + previewLength;

  // Adjust if window exceeds content length
  if (windowEnd > contentLength) {
    windowEnd = contentLength;
    windowStart = Math.max(0, windowEnd - previewLength);
  }

  // Extract window content
  const windowContent = originalContent.slice(windowStart, windowEnd);

  // Adjust spans to be relative to the window
  const windowSpans = merged
    .filter((s) => s.start < windowEnd && s.end > windowStart)
    .map((s) => ({
      ...s,
      start: Math.max(0, s.start - windowStart),
      end: Math.min(windowEnd - windowStart, s.end - windowStart),
    }));

  return applyReplacements(windowContent, windowSpans);
}

/**
 * Build a fully redacted version of the original content.
 *
 * Replaces all sensitive spans with semantic placeholders.
 * Returns undefined when no findings or match metadata is missing.
 */
export function buildRedactedContent(
  originalContent: string,
  findings: readonly Finding[],
  _config?: GuardConfig,
): string | undefined {
  if (findings.length === 0) return undefined;

  const spans = extractSpans(findings);
  if (spans === undefined) return undefined;

  const merged = sortAndMergeSpans(spans);
  return applyReplacements(originalContent, merged);
}

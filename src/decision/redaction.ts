import type { Finding, FindingType } from "../types.js";

// ─── Semantic placeholder mapping ────────────────────────────────────────────

const TYPE_PLACEHOLDER: Record<FindingType, string> = {
  API_KEY:        "[REDACTED_API_KEY]",
  SECRET:         "[REDACTED_PASSWORD]",
  TOKEN:          "[REDACTED_TOKEN]",
  PII_EMAIL:      "[REDACTED_EMAIL]",
  PII_PHONE_TW:   "[REDACTED_PHONE]",
  PII_PHONE_INTL: "[REDACTED_PHONE]",
  PII_ID_TW:      "[REDACTED_ID]",
  DB_CONNECTION:  "[REDACTED_DB_CONNECTION]",
  PRIVATE_DOMAIN: "[REDACTED_PRIVATE_DOMAIN]",
  NDA_KEYWORD:    "[REDACTED_NDA_TERM]",
  CUSTOM:         "[REDACTED_CUSTOM]",
};

function placeholderForType(type: string): string {
  return TYPE_PLACEHOLDER[type as FindingType] ?? `[REDACTED_${type}]`;
}

// ─── Binary detection ─────────────────────────────────────────────────────────

function hasBinaryContent(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true;
  }
  return false;
}

// ─── Span utilities ───────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
  placeholder: string;
}

/** Collect spans from findings that have match_start/match_end. */
function collectSpans(findings: Finding[]): Span[] {
  const spans: Span[] = [];
  for (const f of findings) {
    if (f.match_start === undefined || f.match_end === undefined) continue;
    spans.push({
      start: f.match_start,
      end: f.match_end,
      placeholder: placeholderForType(f.type),
    });
  }
  // Sort ascending by start
  spans.sort((a, b) => a.start - b.start);
  return mergeOverlapping(spans);
}

/** Merge overlapping or adjacent spans, keeping the placeholder of the first (highest-priority) span. */
function mergeOverlapping(spans: Span[]): Span[] {
  if (spans.length === 0) return spans;
  const merged: Span[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = spans[i];
    if (curr.start < prev.end) {
      // Overlap — extend end, keep prev placeholder
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a sendable redacted payload by replacing sensitive spans with semantic
 * placeholders.  Returns `undefined` if the content contains binary data.
 */
export function buildRedactedContent(
  content: string,
  findings: Finding[]
): string | undefined {
  if (hasBinaryContent(content)) return undefined;

  const spans = collectSpans(findings);
  if (spans.length === 0) return content;

  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push(content.slice(cursor, span.start));
    }
    parts.push(span.placeholder);
    cursor = span.end;
  }
  if (cursor < content.length) {
    parts.push(content.slice(cursor));
  }
  return parts.join("");
}

/**
 * Build a short masked excerpt of the content for human display.
 * Sensitive spans are replaced with `****`.  The result is truncated to
 * `previewLength` characters.  Returns `undefined` when there are no findings.
 */
export function buildSafePreview(
  content: string,
  findings: Finding[],
  previewLength = 60
): string | undefined {
  if (findings.length === 0) return undefined;

  const spans = collectSpans(findings);

  // Mask sensitive spans with ****
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      parts.push(content.slice(cursor, span.start));
    }
    parts.push("****");
    cursor = span.end;
  }
  if (cursor < content.length) {
    parts.push(content.slice(cursor));
  }
  const masked = parts.join("");
  return masked.slice(0, previewLength);
}

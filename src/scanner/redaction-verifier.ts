import { redactText, scanText, type ScanOptions, type Utf16Span } from "./engine.js";
import type { Finding, GuardConfig, RedactResult, ScanResult } from "../types.js";

export interface RedactVerifiedResult {
  redacted: string;
  verified: boolean;
  totalFindings: number;
  residualFindings: number;
  wasTruncated: boolean;
  summary: string;
}

const SAFE_REDACTION_SUFFIX = "redaction verified — no residual findings";

/**
 * Every occurrence of each `protected` string in `text`, as UTF-16 spans.
 * Callers pass the exact values they issued, never a marker-shaped pattern, so
 * a lookalike string that was not issued is never exempted.
 */
export function spansForProtectedStrings(text: string, protectedStrings: readonly string[]): Utf16Span[] {
  const spans: Utf16Span[] = [];
  for (const needle of protectedStrings) {
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at === -1) break;
      spans.push({ start: at, end: at + needle.length });
      from = at + 1;
    }
  }
  return spans;
}

function containedIn(span: Utf16Span, spans: readonly Utf16Span[]): boolean {
  return spans.some((outer) => span.start >= outer.start && span.end <= outer.end);
}

/**
 * Strictly interior to a protected placeholder span: the finding touches
 * neither the opening nor the closing delimiter. Only these are exempt — a
 * generated hex run inside the placeholder body is never user content, while a
 * finding that matches the marker shape itself (or crosses the boundary) still
 * reports and fails closed.
 */
function strictlyInteriorTo(span: Utf16Span, spans: readonly Utf16Span[]): boolean {
  return spans.some((outer) => span.start > outer.start && span.end < outer.end);
}

/** Filter out findings fully contained in [REDACTED_*] or strictly inside issued placeholders. */
function filterResidualFindings(
  findings: readonly Finding[],
  redacted: string,
  protectedStrings: readonly string[],
): Finding[] {
  const markerSpans: Array<{ start: number; end: number }> = [];
  const re = /\[REDACTED_\w+\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(redacted)) !== null) {
    markerSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  const protectedSpans = spansForProtectedStrings(redacted, protectedStrings);
  if (markerSpans.length === 0 && protectedSpans.length === 0) return [...findings];

  return findings.filter((f) => {
    // Decoded findings use offsets from decoded content, not redacted output.
    if (f.encoding_detected || f.match_start === undefined || f.match_end === undefined) return true;
    const span = { start: f.match_start, end: f.match_end };
    if (containedIn(span, markerSpans)) return false;
    return !strictlyInteriorTo(span, protectedSpans);
  });
}

export function redactAndVerify(
  text: string,
  config: GuardConfig,
  opts?: ScanOptions,
  /**
   * Exact values issued by this operation (e.g. `[SG-EMAIL-…]` placeholders)
   * that redaction must not rewrite and verification must exempt exactly when
   * contained. Neighbouring and crossing findings stay reportable so they
   * still fail closed.
   */
  protectedStrings: readonly string[] = [],
): RedactVerifiedResult {
  const originalTruncated = text.length > config.settings.max_chars;
  const protectedSpans = spansForProtectedStrings(text, protectedStrings);
  const redactResult: RedactResult = redactText(text, config, opts, protectedSpans);
  const verification: ScanResult = scanText(redactResult.redacted, config, opts);
  const residualFindings = filterResidualFindings(verification.findings, redactResult.redacted, protectedStrings);
  const wasTruncated = originalTruncated || verification.was_truncated === true;
  const verified = !wasTruncated && residualFindings.length === 0;
  const summary = redactResult.summary + (verified ? ` [${SAFE_REDACTION_SUFFIX}]` : " [redaction incomplete]");

  return {
    redacted: redactResult.redacted,
    verified,
    totalFindings: redactResult.total_findings,
    residualFindings: residualFindings.length,
    wasTruncated,
    summary,
  };
}

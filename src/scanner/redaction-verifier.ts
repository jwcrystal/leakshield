import { redactText, scanText, type ScanOptions } from "./engine.js";
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

/** Filter out findings fully contained in [REDACTED_*] placeholders. */
function filterResidualFindings(findings: readonly Finding[], redacted: string): Finding[] {
  const placeholderSpans: Array<{ start: number; end: number }> = [];
  const re = /\[REDACTED_\w+\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(redacted)) !== null) {
    placeholderSpans.push({ start: m.index, end: m.index + m[0].length });
  }
  if (placeholderSpans.length === 0) return [...findings];

  return findings.filter((f) => {
    // Decoded findings use offsets from decoded content, not redacted output.
    if (f.encoding_detected || f.match_start === undefined || f.match_end === undefined) return true;
    return !placeholderSpans.some(
      (s) => f.match_start! >= s.start && f.match_end! <= s.end,
    );
  });
}

export function redactAndVerify(text: string, config: GuardConfig, opts?: ScanOptions): RedactVerifiedResult {
  const originalTruncated = text.length > config.settings.max_chars;
  const redactResult: RedactResult = redactText(text, config, opts);
  const verification: ScanResult = scanText(redactResult.redacted, config, opts);
  const residualFindings = filterResidualFindings(verification.findings, redactResult.redacted);
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

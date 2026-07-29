import { redactText, scanText } from "./engine.js";
import type { GuardConfig, RedactResult, ScanResult } from "../types.js";

export interface RedactVerifiedResult {
  redacted: string;
  verified: boolean;
  totalFindings: number;
  residualFindings: number;
  wasTruncated: boolean;
  summary: string;
}

const SAFE_REDACTION_SUFFIX = "redaction verified — no residual findings";

export function redactAndVerify(text: string, config: GuardConfig): RedactVerifiedResult {
  const originalTruncated = text.length > config.settings.max_chars;
  const redactResult: RedactResult = redactText(text, config);
  const verification: ScanResult = scanText(redactResult.redacted, config);
  const wasTruncated = originalTruncated || verification.was_truncated === true;
  const verified = !wasTruncated && verification.safe;
  const summary = redactResult.summary + (verified ? ` [${SAFE_REDACTION_SUFFIX}]` : " [redaction incomplete]");

  return {
    redacted: redactResult.redacted,
    verified,
    totalFindings: redactResult.total_findings,
    residualFindings: verification.total_findings,
    wasTruncated,
    summary,
  };
}
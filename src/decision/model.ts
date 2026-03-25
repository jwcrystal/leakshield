import type { ScanResult } from "../types.js";
import { buildRedactedContent, buildSafePreview } from "./redaction.js";

export type GuardDecision = "ALLOW" | "WARN" | "CONFIRM" | "BLOCK";
export type GuardRiskLevel = "LOW" | "MEDIUM" | "HIGH";

export interface GuardDecisionFinding {
  type: string;
  severity: GuardRiskLevel;
  line?: number;
  preview?: string;
}

export interface GuardDecisionResult {
  decision: GuardDecision;
  riskLevel: GuardRiskLevel;
  summary: string;
  findings: GuardDecisionFinding[];
  safePreview?: string;
  recommendedAction: "CONTINUE" | "CANCEL" | "SEND_REDACTED" | "CONFIRM_ORIGINAL";
  redactedContent?: string;
}

export function toDecisionResult(
  scan: ScanResult,
  originalContent: string
): GuardDecisionResult {
  if (scan.safe) {
    return {
      decision: "ALLOW",
      riskLevel: "LOW",
      summary: scan.summary,
      findings: [],
      recommendedAction: "CONTINUE",
    };
  }

  const riskLevel: GuardRiskLevel = scan.findings.some((f) => f.severity === "HIGH")
    ? "HIGH"
    : scan.findings.some((f) => f.severity === "MEDIUM")
    ? "MEDIUM"
    : "LOW";

  return {
    decision: riskLevel === "LOW" ? "WARN" : "CONFIRM",
    riskLevel,
    summary: scan.summary,
    findings: scan.findings.map((f) => ({
      type: f.type,
      severity: f.severity,
      line: f.line,
      preview: f.preview,
    })),
    safePreview: buildSafePreview(originalContent, scan.findings),
    recommendedAction:
      riskLevel === "HIGH" ? "CANCEL" : riskLevel === "MEDIUM" ? "SEND_REDACTED" : "CONTINUE",
    redactedContent: buildRedactedContent(originalContent, scan.findings),
  };
}

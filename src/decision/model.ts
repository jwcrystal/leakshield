/**
 * Decision model — translates a ScanResult into a GuardDecisionResult
 * that the reminder / confirmation UI layer can consume.
 */

import type { ScanResult, Finding, GuardConfig } from "../types.js";
import { buildSafePreview, buildRedactedContent } from "./redaction.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Overall decision the guardrail returns. */
export type GuardDecision = "ALLOW" | "WARN" | "CONFIRM";

/** Computed risk level. */
export type GuardRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Recommended action when decision is CONFIRM. */
export type GuardRecommendedAction = "REVIEW" | "BLOCK";

/** A single finding as seen by the decision layer. */
export interface GuardDecisionFinding {
  type: Finding["type"];
  severity: Finding["severity"];
  description: string;
  preview: string;
}

/** The full decision result consumed by the UI / MCP layer. */
export interface GuardDecisionResult {
  decision: GuardDecision;
  riskLevel: GuardRiskLevel;
  findings: readonly GuardDecisionFinding[];
  recommendedAction?: GuardRecommendedAction;
  safePreview?: string;
  redactedContent?: string;
  originalContent: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasHigh(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "HIGH");
}

function hasMediumOrHigher(findings: readonly Finding[]): boolean {
  return findings.some(
    (f) => f.severity === "HIGH" || f.severity === "MEDIUM",
  );
}

function toGuardFinding(f: Finding): GuardDecisionFinding {
  return {
    type: f.type,
    severity: f.severity,
    description: f.description,
    preview: f.preview,
  };
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Translate a ScanResult into a GuardDecisionResult.
 *
 * | Findings          | decision | riskLevel | recommendedAction |
 * |-------------------|----------|-----------|-------------------|
 * | none              | ALLOW    | LOW       | —                 |
 * | LOW only          | WARN     | MEDIUM    | —                 |
 * | MEDIUM (no HIGH)  | CONFIRM  | HIGH      | REVIEW            |
 * | any HIGH          | CONFIRM  | CRITICAL  | BLOCK             |
 */
export function toDecisionResult(
  scan: ScanResult,
  originalContent: string,
  config?: GuardConfig,
): GuardDecisionResult {
  const findings = scan.findings.map(toGuardFinding);

  if (scan.safe || scan.total_findings === 0) {
    return {
      decision: "ALLOW",
      riskLevel: "LOW",
      findings,
      originalContent,
    };
  }

  if (hasHigh(scan.findings)) {
    return {
      decision: "CONFIRM",
      riskLevel: "CRITICAL",
      findings,
      recommendedAction: "BLOCK",
      safePreview: buildSafePreview(originalContent, scan.findings, config),
      redactedContent: buildRedactedContent(
        originalContent,
        scan.findings,
        config,
      ),
      originalContent,
    };
  }

  if (hasMediumOrHigher(scan.findings)) {
    return {
      decision: "CONFIRM",
      riskLevel: "HIGH",
      findings,
      recommendedAction: "REVIEW",
      safePreview: buildSafePreview(originalContent, scan.findings, config),
      redactedContent: buildRedactedContent(
        originalContent,
        scan.findings,
        config,
      ),
      originalContent,
    };
  }

  // LOW-only
  return {
    decision: "WARN",
    riskLevel: "MEDIUM",
    findings,
    originalContent,
  };
}

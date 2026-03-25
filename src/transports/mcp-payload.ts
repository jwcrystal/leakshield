/**
 * MCP payload serializer — converts scan results into decision-oriented
 * payloads safe for MCP tool responses.
 *
 * This is a pure helper seam: no side effects, no file I/O.
 * It wraps `toDecisionResult` and strips any content that must not
 * leave the guard boundary (originalContent, internal match metadata).
 */

import type { ScanResult, GuardConfig } from "../types.js";
import {
  toDecisionResult,
  type GuardDecision,
  type GuardRiskLevel,
  type GuardRecommendedAction,
  type GuardDecisionFinding,
} from "../decision/model.js";

// ─── Payload type ──────────────────────────────────────────────────────────

/** The JSON-serializable payload returned by scan_text / scan_file MCP tools. */
export interface McpDecisionPayload {
  /** Backward-compatible boolean derived from decision. */
  safe: boolean;
  /** Total number of findings. */
  total_findings: number;
  /** Human-readable summary. */
  summary: string;
  /** Guard decision: ALLOW | WARN | CONFIRM. */
  decision: GuardDecision;
  /** Computed risk level. */
  riskLevel: GuardRiskLevel;
  /** Sanitized findings (no internal metadata). */
  findings: readonly GuardDecisionFinding[];
  /** Recommended action when decision is CONFIRM. */
  recommendedAction?: GuardRecommendedAction;
  /** Masked excerpt around the first finding (CONFIRM only). */
  safePreview?: string;
  /** Optional context label (e.g. "config.ts"). */
  label?: string;
  /** Optional resolved file path (scan_file only). */
  file?: string;
}

// ─── Core helper ───────────────────────────────────────────────────────────

/**
 * Build a decision-oriented MCP payload from a scan result.
 *
 * - Computes the decision via `toDecisionResult`.
 * - Derives `safe` from the decision for backward compatibility.
 * - Strips `originalContent` and any internal match metadata.
 * - Optionally attaches `label` or `file` context.
 */
export function toMcpDecisionPayload(
  scan: ScanResult,
  originalContent: string,
  config?: GuardConfig,
  meta?: { readonly label?: string; readonly file?: string },
): McpDecisionPayload {
  const decision = toDecisionResult(scan, originalContent, config);

  const payload: McpDecisionPayload = {
    safe: decision.decision === "ALLOW",
    total_findings: scan.total_findings,
    summary: scan.summary,
    decision: decision.decision,
    riskLevel: decision.riskLevel,
    findings: decision.findings,
  };

  if (decision.recommendedAction !== undefined) {
    payload.recommendedAction = decision.recommendedAction;
  }

  if (decision.safePreview !== undefined) {
    payload.safePreview = decision.safePreview;
  }

  if (meta?.label !== undefined) {
    payload.label = meta.label;
  }

  if (meta?.file !== undefined) {
    payload.file = meta.file;
  }

  return payload;
}

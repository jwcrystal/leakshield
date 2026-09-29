/**
 * Per-session email de-identification (issue #20 trial).
 *
 * Opt-in (v2 plugin option `deidentify: true`, requires `mode: "redact"`):
 * repeated MEDIUM `PII_EMAIL` findings are replaced with opaque, stable
 * `[SG-EMAIL-…]` placeholders so an agent can correlate occurrences without
 * seeing the addresses. The mapping key lives in memory for one plugin setup
 * (= one OpenCode session) and is never persisted; there is no reverse
 * mapping. Everything else — HIGH findings, truncation, encoded/overlapping/
 * ambiguous findings, verification failure — keeps the fail-closed default.
 */

import { createHmac, randomBytes } from "node:crypto";
import { scanText } from "../scanner/engine.js";
import { redactAndVerify } from "../scanner/redaction-verifier.js";
import type { Finding, GuardConfig } from "../types.js";
import {
  blockedText,
  protectText,
  type ProtectionOptions,
  type ProtectedText,
} from "./ingress.js";

export const DEIDENTIFY_MARKER_PREFIX = "[SG-EMAIL-";

/** Placeholder body length: 16 hex chars (64 bits). See placeholderFor(). */
const PLACEHOLDER_HEX_CHARS = 16;

/** One random key per plugin setup (= one OpenCode session); never persisted. */
export function createSessionKey(): Buffer {
  return randomBytes(32);
}

/**
 * Stable opaque placeholder for one email value within a session. The value is
 * normalized (trim + lowercase) so case variants of one address collide to a
 * single placeholder. 16 hex chars (64 bits) of HMAC-SHA-256 keyed by the
 * session key — non-reversible without the in-memory key, and shaped so no
 * scanner rule or `[REDACTED_*]` marker exemption matches it. Collision
 * bound: at 64 bits, a birthday collision needs ~2^32 distinct values in one
 * session before two different addresses could share a placeholder.
 */
export function placeholderFor(value: string, sessionKey: Buffer): string {
  const digest = createHmac("sha256", sessionKey)
    .update(value.trim().toLowerCase())
    .digest("hex");
  return `${DEIDENTIFY_MARKER_PREFIX}${digest.slice(0, PLACEHOLDER_HEX_CHARS)}]`;
}

function isDeidentifiableEmail(finding: Finding): boolean {
  return finding.type === "PII_EMAIL" && finding.severity === "MEDIUM";
}

export type DeidentifyApplication = { ok: true; text: string } | { ok: false };

/**
 * Substitute email spans in `text` according to `findings`, enforcing the
 * fail-closed gates up front. Returns `{ ok: false }` when:
 * - any finding (email or not) carries `encoding_detected` metadata
 *   (its offsets cannot be trusted for substitution),
 * - an email finding lacks usable `match_start`/`match_end`/`match_text`,
 * - email spans overlap, or
 * - a span's `match_text` does not equal the slice it claims to cover.
 */
export function applyDeidentify(
  text: string,
  findings: readonly Finding[],
  sessionKey: Buffer,
): DeidentifyApplication {
  if (findings.some((f) => f.encoding_detected)) return { ok: false };

  const emails = findings.filter(isDeidentifiableEmail);
  const spans: Array<{ start: number; end: number; placeholder: string }> = [];
  for (const f of emails) {
    const { match_start: start, match_end: end, match_text: matched } = f;
    if (
      typeof start !== "number" ||
      typeof end !== "number" ||
      typeof matched !== "string" ||
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start >= end ||
      end > text.length ||
      text.slice(start, end) !== matched
    ) {
      return { ok: false };
    }
    spans.push({ start, end, placeholder: placeholderFor(matched, sessionKey) });
  }

  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) return { ok: false };
  }

  // Apply descending by start so earlier offsets stay valid during splicing.
  let substituted = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end, placeholder } = spans[i];
    substituted = substituted.slice(0, start) + placeholder + substituted.slice(end);
  }
  return { ok: true, text: substituted };
}

/**
 * `protectText` with the de-identification trial applied: emails opted in via
 * the session key are replaced by stable placeholders before the standard
 * redaction/verification pipeline. Any doubt (truncation, encoded findings,
 * bad spans, verification failure, residual originals) blocks the whole unit.
 */
export function deidentifyText(
  text: string,
  config: GuardConfig,
  sessionKey: Buffer,
  options: ProtectionOptions,
): ProtectedText {
  if (options.mode !== "redact") {
    // Defense in depth: de-identification is a redact-mode-only trial, so this
    // exported API must never relax block mode even if a future caller
    // bypasses the plugin-option schema refine.
    return protectText(text, config, options);
  }

  const block = (totalFindings: number): ProtectedText => ({
    action: "block",
    text: blockedText(options.context, totalFindings),
    totalFindings,
  });

  try {
    // The model boundary never honors in-text ignore directives (fail-open
    // bypass otherwise); the same flag covers every scan below.
    const noDirectives = { honorIgnoreDirectives: false } as const;
    const scan = scanText(text, config, noDirectives);
    if (scan.was_truncated) return block(scan.total_findings);

    if (!scan.findings.some(isDeidentifiableEmail)) {
      return protectText(text, config, options);
    }

    const applied = applyDeidentify(text, scan.findings, sessionKey);
    if (!applied.ok) return block(scan.total_findings);

    const verified = redactAndVerify(applied.text, config, noDirectives);
    if (!verified.verified) return block(scan.total_findings);

    // Independent safety check: the verifier exempts findings inside its own
    // [REDACTED_*] marker shape, so it alone is not proof for our placeholders.
    const finalText = verified.redacted;
    const rescan = scanText(finalText, config, noDirectives);
    if (!rescan.safe) return block(scan.total_findings);
    for (const f of scan.findings) {
      if (isDeidentifiableEmail(f) && f.match_text && finalText.includes(f.match_text)) {
        return block(scan.total_findings);
      }
    }

    return { action: "redact", text: finalText, totalFindings: scan.total_findings };
  } catch {
    // A scanner failure must never result in the original content reaching a model.
    return block(0);
  }
}

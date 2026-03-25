/**
 * Redaction stubs — real implementation deferred to Task 2.
 */

import type { Finding, GuardConfig } from "../types.js";

/**
 * Build a safe preview of the original content.
 * Currently returns undefined (stub).
 */
export function buildSafePreview(
  _originalContent: string,
  _findings: readonly Finding[],
  _config?: GuardConfig,
): string | undefined {
  return undefined;
}

/**
 * Build a fully redacted version of the original content.
 * Currently returns undefined (stub).
 */
export function buildRedactedContent(
  _originalContent: string,
  _findings: readonly Finding[],
  _config?: GuardConfig,
): string | undefined {
  return undefined;
}

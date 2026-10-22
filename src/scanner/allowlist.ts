/**
 * Exact-match allowlists (issue #32).
 *
 * An allowlist entry suppresses a finding only when the matched text is exactly
 * that string. It is not a pattern, it is not a substring test, and it does not
 * rewrite anything: the content still leaves the machine as-is. That makes it a
 * real bypass, which is why every suppression is counted here and surfaced by
 * `--doctor`, and why the entry lists are capped at config load.
 *
 * The counter is process-wide and monotonic. It is diagnostic evidence ("how
 * often did the allowlist actually fire?"), not a metric to optimize.
 */

/** Values that never produce a finding, for one rule or for every rule. */
export function allowSet(values: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((values ?? []).filter((value) => value.length > 0));
}

/** True when `matchedText` is exactly an allowlisted value. */
export function isAllowlisted(
  matchedText: string,
  globalAllow: ReadonlySet<string>,
  ruleAllow: ReadonlySet<string> | undefined,
): boolean {
  if (globalAllow.size === 0 && (ruleAllow === undefined || ruleAllow.size === 0)) return false;
  return globalAllow.has(matchedText) || ruleAllow?.has(matchedText) === true;
}

let suppressions = 0;
const MAX_COUNT = Number.MAX_SAFE_INTEGER;

/** Record one suppressed finding. Bounded so a long-lived process cannot wrap. */
export function noteAllowlistSuppression(): void {
  if (suppressions < MAX_COUNT) suppressions += 1;
}

/** Findings suppressed by an allowlist since this module was loaded. */
export function allowlistSuppressions(): number {
  return suppressions;
}

/** Test seam only: reset the counter between cases. */
export function resetAllowlistSuppressionsForTests(): void {
  suppressions = 0;
}

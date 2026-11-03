// Redact a matched secret for safe display.
// SECURITY: Regardless of value length or previewLen, we always return "****"
// to prevent any partial secret exposure in output (previews, logs, reports).
// The _value and _previewLen parameters are retained for API compatibility.
export function redact(_value: string, _previewLen: number): string {
  return "****";
}

export function getLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  return lineColAt(createLineIndex(before), before.length);
}

/** Start offset of every line in a text; a line break is `\r?\n`, so only `\n` ends a line. */
export function createLineIndex(text: string): number[] {
  const starts = [0];
  let from = 0;
  for (;;) {
    const nl = text.indexOf("\n", from);
    if (nl === -1) return starts;
    from = nl + 1;
    starts.push(from);
  }
}

/** Line (1-based) and column (1-based) of `index`, given the starts from createLineIndex of the same text. */
export function lineColAt(lineStarts: readonly number[], index: number): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: index - lineStarts[lo] + 1 };
}

/**
 * Multiple ignore patterns to prevent bypass attempts.
 *
 * Supported formats:
 * - // leakshield-ignore
 * - // guard:skip
 * - // guard:ignore
 * - // sg-ignore
 * - // no-scan
 * - // skip-guard
 *
 * All patterns are word-boundary protected to prevent:
 * - leakshield-ignored (won't match)
 * - leakshield_ignore (won't match)
 * - leakshieldignore (won't match)
 */
const IGNORE_PATTERNS = [
  /\bleakshield-ignore\b/i,           // Original format
  /\bguard:\s*skip\b/i,                     // Short format
  /\bguard:\s*ignore\b/i,                   // Short format alternative
  /\bsg-ignore\b/i,                         // Abbreviated
  /\bno-scan\b/i,                           // Alternative
  /\bskip-guard\b/i,                        // Alternative
];

/**
 * Extracts line numbers that should be ignored during scanning.
 *
 * Lines containing any of the supported ignore patterns will be skipped.
 * This prevents attackers from using variants to bypass detection.
 *
 * @param text - The full text content to scan
 * @returns Set of line numbers (1-indexed) to ignore
 */
export function getIgnoredLines(text: string): Set<number> {
  const ignored = new Set<number>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check against all patterns
    for (const pattern of IGNORE_PATTERNS) {
      if (pattern.test(line)) {
        ignored.add(i + 1); // 1-indexed
        break; // No need to check other patterns for this line
      }
    }
  }

  return ignored;
}

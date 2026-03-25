// Redact a matched secret for display. previewLen controls the max output
// length so callers can control how much of a long match is surfaced in
// the masked preview (e.g. first N chars + "****" + last N chars).
export function redact(value: string, previewLen: number): string {
  if (value.length <= 8) return "****";
  const masked = value.slice(0, 4) + "****" + value.slice(-2);
  // Truncate the masked preview to previewLen — allows config to limit exposure
  // of very long secrets while still showing a safe redacted snippet.
  return masked.slice(0, previewLen);
}

export function getLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

const IGNORE_PATTERN = /sensitive-guard-ignore/i;

export function getIgnoredLines(text: string): Set<number> {
  const ignored = new Set<number>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (IGNORE_PATTERN.test(lines[i])) ignored.add(i + 1); // 1-indexed
  }
  return ignored;
}

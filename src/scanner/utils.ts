export function redact(value: string, _previewLen: number): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-2);
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

export function redact(value: string, _previewLen: number): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-2);
}

export function getLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

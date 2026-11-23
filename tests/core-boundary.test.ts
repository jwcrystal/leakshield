import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const CORE_PATHS = ["core", "decision", "scanner", "rules", "config", "types.ts"];
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

function specifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((match) => match[1]!);
}

describe("host-independent core boundary", () => {
  const files = CORE_PATHS.flatMap((p) => sourceFiles(join(SRC, p)));

  it("covers the core directories", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))("%s imports no host adapter", (_name, file) => {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      expect(specifier.startsWith("@opencode")).toBe(false);
      if (!specifier.startsWith(".")) continue;
      const resolved = normalize(join(dirname(file), specifier));
      expect(resolved.slice(SRC.length + 1)).not.toMatch(/^adapters\//);
    }
  });
});

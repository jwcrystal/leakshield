import { readdirSync, readFileSync, statSync } from "node:fs";
import path, { join, posix, win32 } from "node:path";
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

function assertCoreImport(specifier: string, file: string, src = SRC, paths = path): void {
  expect(specifier.startsWith("@opencode")).toBe(false);
  if (!specifier.startsWith(".")) return;
  const resolved = paths.normalize(paths.join(paths.dirname(file), specifier));
  expect(paths.relative(src, resolved).split(paths.sep)[0]).not.toBe("adapters");
}

describe("host-independent core boundary", () => {
  const files = CORE_PATHS.flatMap((p) => sourceFiles(join(SRC, p)));

  it("covers the core directories", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  describe.each([["POSIX", posix], ["Windows", win32]] as const)("%s paths", (_name, paths) => {
    const src = paths.resolve("repo", "src");
    const file = paths.join(src, "core", "index.ts");

    it.each(["opencode", "claude-code", "pi"])("rejects an import from %s", (host) => {
      expect(() => assertCoreImport(`../adapters/${host}/index.js`, file, src, paths)).toThrow();
    });

    it("rejects a normalized traversal into an adapter", () => {
      expect(() => assertCoreImport("../core/../adapters/pi/index.js", file, src, paths)).toThrow();
    });

    it("allows shared modules and similarly named directories", () => {
      for (const specifier of ["./session.js", "../types.js", "../adapters-shared/index.js", "node:path"]) {
        expect(() => assertCoreImport(specifier, file, src, paths)).not.toThrow();
      }
    });
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))("%s imports no host adapter", (_name, file) => {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      assertCoreImport(specifier, file);
    }
  });
});

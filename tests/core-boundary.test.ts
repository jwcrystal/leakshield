import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const CORE_PATHS = ["core", "decision", "scanner", "rules", "config", "types.ts"];
const HOST_IMPORT = /from\s+["'](?:@opencode[^"']*|(?:\.{1,2}\/)+(?:[\w-]+\/)*opencode[^"']*)["']/;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

describe("host-independent core boundary", () => {
  const files = CORE_PATHS.flatMap((p) => sourceFiles(join(SRC, p)));

  it("covers the core directories", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(files.map((f) => [f.slice(SRC.length + 1), f]))("%s imports nothing from the OpenCode layer", (_name, file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(HOST_IMPORT);
  });
});

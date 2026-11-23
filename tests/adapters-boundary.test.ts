import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
const ADAPTERS = join(SRC, "adapters");
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

function sourceFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

const hosts = readdirSync(ADAPTERS).filter((entry) => statSync(join(ADAPTERS, entry)).isDirectory());
const files = hosts.flatMap((host) => sourceFiles(join(ADAPTERS, host)).map((file) => [host, file] as const));

describe("adapter independence", () => {
  it("finds every adapter", () => {
    expect(hosts.sort()).toEqual(["claude-code", "opencode", "pi"]);
  });

  it.each(files.map(([host, file]) => [`${host}/${relative(join(ADAPTERS, host), file)}`, host, file]))(
    "%s imports no other adapter",
    (_name, host, file) => {
      const text = readFileSync(file, "utf8");
      for (const [specifier] of text.matchAll(SPECIFIER)) {
        if (specifier === undefined || !specifier.startsWith(".")) continue;
        const resolved = normalize(join(dirname(file), specifier));
        const parts = relative(ADAPTERS, resolved).split(sep);
        if (parts[0] === "..") continue;
        expect(parts[0], `${file} imports ${specifier}`).toBe(host);
      }
    },
  );
});

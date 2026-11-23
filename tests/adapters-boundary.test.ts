import { readdirSync, readFileSync, statSync } from "node:fs";
import path, { join, posix, relative, win32 } from "node:path";
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

function assertAdapterImports(text: string, host: string, file: string, adapters = ADAPTERS, paths = path): void {
  for (const [, specifier] of text.matchAll(SPECIFIER)) {
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    const resolved = paths.normalize(paths.join(paths.dirname(file), specifier));
    const parts = paths.relative(adapters, resolved).split(paths.sep);
    if (parts[0] === "..") continue;
    expect(parts[0], `${file} imports ${specifier}`).toBe(host);
  }
}

describe("adapter independence", () => {
  it("finds every adapter", () => {
    expect(hosts.sort()).toEqual(["claude-code", "opencode", "pi"]);
  });

  describe.each([["POSIX", posix], ["Windows", win32]] as const)("%s paths", (_name, paths) => {
    const adapters = paths.resolve("repo", "src", "adapters");
    const file = paths.join(adapters, "opencode", "plugin.ts");

    it.each([
      'import { guard } from "../pi/guard.js";',
      'export { guard } from "../pi/guard.js";',
      'import("../pi/guard.js");',
      'require("../claude-code/proxy.js");',
      'import "../pi/guard.js";',
      'import("./nested/../../pi/guard.js");',
    ])("rejects cross-adapter dependency: %s", (text) => {
      expect(() => assertAdapterImports(text, "opencode", file, adapters, paths)).toThrow();
    });

    it("allows the same adapter, shared modules and packages", () => {
      const text = 'import "./hooks.js"; import "../../core/index.js"; import "../../types.js"; import "node:path";';
      expect(() => assertAdapterImports(text, "opencode", file, adapters, paths)).not.toThrow();
    });
  });

  it.each(files.map(([host, file]) => [`${host}/${relative(join(ADAPTERS, host), file)}`, host, file]))(
    "%s imports no other adapter",
    (_name, host, file) => {
      assertAdapterImports(readFileSync(file, "utf8"), host, file);
    },
  );
});

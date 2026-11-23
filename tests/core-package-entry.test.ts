import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGuardCore, type HostToolPolicy } from "../src/core/index.js";
import { opencodeToolPolicy } from "../src/adapters/opencode/opencode-tool-policy.js";

const ROOT = join(__dirname, "..");

describe("experimental package core subpath", () => {
  it("exports the host-neutral guard factory independently of the plugin entry", () => {
    expect(typeof createGuardCore).toBe("function");
  });

  it("exports the host policy contract", () => {
    const policy: HostToolPolicy = opencodeToolPolicy;
    expect(typeof policy.isCodeModeCall).toBe("function");
  });

  it("publishes both JS and TypeScript declarations without altering the default plugin entry", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
    expect(pkg.exports["."]).toBe("./dist/index.js");
    expect(pkg.exports["./core"]).toEqual({
      types: "./dist/core/index.d.ts",
      default: "./dist/core/index.js",
    });
    expect(tsconfig.compilerOptions.declaration).toBe(true);
  });
});

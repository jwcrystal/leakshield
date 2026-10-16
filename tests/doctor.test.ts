import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, parseJsonc, formatDoctorReport, type DoctorDeps } from "../src/doctor.js";
import type { GuardConfig } from "../src/types.js";

function makeFixture(overrides: {
  version?: string | null;
  config?: (tmp: string) => unknown;
  options?: Partial<DoctorDeps>;
  distFiles?: boolean;
}): { deps: DoctorDeps; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-doctor-"));
  const pluginRoot = path.join(tmp, "leakshield");
  if (overrides.distFiles) {
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export {};");
    // v1 legacy entries point at the compiled opencode.js file directly
    fs.writeFileSync(path.join(pluginRoot, "dist", "opencode.js"), "export {};");
  }
  const config = overrides.config?.(tmp);
  if (config !== undefined) {
    fs.writeFileSync(path.join(tmp, "opencode.json"), JSON.stringify(config, null, 2));
  }
  const deps: DoctorDeps = {
    opencodeVersion: () => (overrides.version === undefined ? "opencode v2.0.23" : overrides.version),
    readIfExists(p) {
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    existsDir(p) {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    existsFile(p) {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    loadGuardConfig: () => ({}) as GuardConfig,
    smokeScan: () => ({ findings: 1 }),
    cwd: tmp,
    home: tmp,
    ...overrides.options,
  };
  return { deps, tmp };
}

const distRef = (tmp: string) => path.join(tmp, "leakshield", "dist");

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });
  it("parses comments and trailing commas", () => {
    const text = `{
      // schema comment
      "$schema": "https://opencode.ai/config.json",
      "plugins": [ { "package": "/x/leakshield/dist", }, ],
    }`;
    expect(parseJsonc(text)).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: "/x/leakshield/dist" }],
    });
  });
});

describe("runDoctor", () => {
  it("reports PROTECTED for a valid v2 local-dist registration", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.hostGeneration).toBe("v2");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("ok");
  });

  it("reports PARTIAL and explicit weaker coverage for hook-first registration", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: { mode: "transparent", wireProtection: false } }] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PARTIAL");
    expect(report.checks.find((c) => c.id === "options")?.detail).toContain("wireProtection=false");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("hook-only");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("not inspected");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("scoped host preparation");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("no outbound HTTP/WS/SDK admission");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).not.toContain("refused in both modes");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("reply-side SG failures");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).not.toContain("unknown intercepted HTTP routes (including commandcode legacy /alpha/generate) are refused in both modes");
    expect(formatDoctorReport(report)).toContain("PARTIAL — hook-first protection");
  });

  it("skips the dist check for package-name registration", async () => {
    const { deps } = makeFixture({ config: () => ({ plugins: ["leakshield"] }) });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("skip");
  });

  it("reports BROKEN for invalid mode", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: { mode: "bogus" } }] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "options")?.state).toBe("fail");
  });

  it("reports BROKEN for transparent + envQueries (refinement)", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({
        plugins: [{ package: distRef(tmp), options: { mode: "transparent", envQueries: true } }],
      }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "options")?.detail).toContain("envQueries");
  });

  it("reports BROKEN when the dist entry point is missing (silent skip)", async () => {
    const { deps } = makeFixture({
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("fail");
    expect(report.checks.find((c) => c.id === "dist")?.detail).toContain("silently");
  });

  it("reports BROKEN when the guard config throws", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
      options: { loadGuardConfig: () => { throw new Error("yaml explode"); } },
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "guard-config")?.state).toBe("fail");
  });

  it("reports BROKEN when smoke finds nothing", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
      options: { smokeScan: () => ({ findings: 0 }) },
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "smoke")?.state).toBe("fail");
  });

  it("reports PARTIAL for a v1 legacy file registration", async () => {
    const { deps } = makeFixture({
      version: "opencode 1.18.29",
      distFiles: true,
      config: (tmp) => ({ plugin: [`${distRef(tmp)}/opencode.js`] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PARTIAL");
    expect(report.hostGeneration).toBe("v1");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("session hooks only");
  });

  it("reports NOT_REGISTERED when a v1 host is given the v2-style plugins key", async () => {
    // Truthful outcome: the v1 host never reads `plugins`, so a v2-style
    // registration silently does nothing there — the doctor must say so
    // instead of reporting protection.
    const { deps } = makeFixture({
      version: "opencode 1.18.29",
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    expect(report.snippet).toContain('"plugin"');
  });

  it("reports NOT_REGISTERED with a snippet when config lacks the plugin", async () => {
    const { deps } = makeFixture({ config: () => ({ plugins: ["some-other-plugin"] }) });
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    expect(report.snippet).toContain('"plugins"');
  });

  it("reports NOT_REGISTERED when no config file exists", async () => {
    const { deps } = makeFixture({});
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    expect(report.snippet).toBeTruthy();
  });

  it("reports BROKEN for an unparsable config", async () => {
    const { deps, tmp } = makeFixture({});
    fs.writeFileSync(path.join(tmp, "opencode.json"), "{ not json !!");
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "config")?.state).toBe("fail");
  });

  it("reports HOST_MISSING when opencode is absent", async () => {
    const { deps } = makeFixture({ version: null });
    const report = await runDoctor(deps);
    expect(report.status).toBe("HOST_MISSING");
    expect(report.checks).toHaveLength(1);
  });

  it("adds a transparent-protocol coverage warning in transparent mode", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }] }),
    });
    const report = await runDoctor(deps);
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("Chat Completions");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("injected HTTP fetch");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("outside coverage");
    expect(report.checks.find((c) => c.id === "coverage")?.detail).not.toContain("Built-in aisdk provider packages");
  });
});

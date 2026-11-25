import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor, parseJsonc, type DoctorDeps } from "../src/adapters/opencode/doctor.js";
import { formatDoctorReport } from "../src/doctor-report.js";
import { buildDynamicRules } from "../src/rules/dynamic.js";
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
    // The host records this file for the legacy registration shape; v2 configs
    // point at the directory.
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

/** Config in the `.opencode/` directory, which the host applies after the project file. */
function writeRepoConfig(tmp: string, config: unknown): string {
  const dir = path.join(tmp, ".opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "opencode.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** Global config at the primary root `configRootGroups` probes for `home: tmp`. */
function writeGlobalConfig(
  tmp: string,
  config: unknown,
  name = "opencode.json",
): string {
  const dir = path.join(tmp, ".config", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config, null, 2));
  return file;
}

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
  it.each([
    [{ mode: "transparent" }, "enabled"],
    [{ mode: "transparent", wireProtection: false }, "disabled"],
    [{ mode: "block" }, "not-applicable"],
  ])("reports the configured wire state for %j", async (options, wireProtection) => {
    const { deps } = makeFixture({ config: () => ({ plugins: [{ package: "leakshield", options }] }) });
    expect(await runDoctor(deps)).toMatchObject({ wireProtection });
  });

  it("keeps the weakest configured wire state across registrations", async () => {
    const { deps } = makeFixture({ config: () => ({ plugins: [
      { package: "leakshield", options: { mode: "transparent" } },
      { package: "leakshield", options: { mode: "transparent", wireProtection: false } },
    ] }) });
    expect(await runDoctor(deps)).toMatchObject({ status: "PARTIAL", wireProtection: "disabled" });
  });

  it("reports known wire configuration even when the guard config is broken", async () => {
    const { deps } = makeFixture({
      config: () => ({ plugins: [{ package: "leakshield", options: { mode: "transparent" } }] }),
      options: { loadGuardConfig: () => { throw new Error("synthetic invalid config"); } },
    });
    const report = await runDoctor(deps);
    expect(report).toMatchObject({ status: "BROKEN", wireProtection: "enabled" });
    expect(formatDoctorReport(report)).toContain("Configuration status: BROKEN");
  });

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

  it("reports the default mode when options omit mode", async () => {
    const v2 = makeFixture({ config: () => ({ plugins: ["leakshield"] }) });
    const v2Report = await runDoctor(v2.deps);
    expect(v2Report.checks.find((c) => c.id === "options")?.detail).toContain("mode=transparent (default) wireProtection=true");

    const explicit = makeFixture({ config: () => ({ plugins: [{ package: "leakshield", options: { mode: "block" } }] }) });
    const explicitReport = await runDoctor(explicit.deps);
    expect(explicitReport.checks.find((c) => c.id === "options")?.detail).toBe("mode=block");
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

  it("warns for transparent + envQueries without changing the status", async () => {
    const base = makeFixture({
      distFiles: true,
      config: (tmp) => ({
        plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }],
      }),
    });
    const baseReport = await runDoctor(base.deps);

    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({
        plugins: [{ package: distRef(tmp), options: { mode: "transparent", envQueries: true } }],
      }),
    });
    const report = await runDoctor(deps);
    expect(report.status).not.toBe("BROKEN");
    expect(report.status).toBe(baseReport.status);
    expect(report.checks.find((c) => c.id === "env-queries")?.state).toBe("warn");
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

  it("warns about custom rules the scanner skips without failing the install (#33)", async () => {
    const guardConfig = {
      nda_keywords: [],
      private_domains: [],
      custom_rules: [{ description: "employee id", pattern: "[", severity: "HIGH" }],
      settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: false },
    } as GuardConfig;
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
      options: { loadGuardConfig: () => guardConfig },
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "custom-rules");
    expect(check?.state).toBe("warn");
    expect(check?.detail).toContain('"employee id"');
    expect(check?.detail).not.toContain("[");
    expect(report.status).toBe("PROTECTED");
  });

  it("reports a ReDoS-skipped rule exactly when the scanner drops it, even if later probes are fast (#33)", async () => {
    // First probe slow, every later one fast: doctor and the scanner must
    // still agree, because the first verdict is the one enforced.
    const pattern = "doctor-timing-marker-\\d+";
    const guardConfig = {
      nda_keywords: [],
      private_domains: [],
      custom_rules: [{ description: "timing rule", pattern, severity: "HIGH" }],
      settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: false },
    } as GuardConfig;
    let calls = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (++calls === 2 ? 250 : 0));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = makeFixture({
        distFiles: true,
        config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
        options: { loadGuardConfig: () => guardConfig },
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "custom-rules");
      expect(check?.state).toBe("warn");
      expect(check?.detail).toContain('"timing rule" (disabled by ReDoS check)');
      expect(check?.detail).not.toContain("doctor-timing-marker");
      expect(buildDynamicRules(guardConfig).some((r) => r.description === "timing rule")).toBe(false);
    } finally {
      nowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("omits the custom-rules check when every custom rule is enforced", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugins: [{ package: distRef(tmp), options: {} }] }),
    });
    const report = await runDoctor(deps);
    expect(report.checks.find((c) => c.id === "custom-rules")).toBeUndefined();
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

  it("reports BROKEN for a v1 host with an upgrade fix, whatever the registration", async () => {
    for (const config of [
      (tmp: string) => ({ plugin: [`${distRef(tmp)}/opencode.js`] }),
      (tmp: string) => ({ plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }] }),
    ]) {
      const { deps } = makeFixture({ version: "opencode 1.18.29", distFiles: true, config });
      const report = await runDoctor(deps);
      expect(report.status).toBe("BROKEN");
      expect(report.hostGeneration).toBe("v1");
      expect(report.hostVersion).toBe("opencode 1.18.29");
      const host = report.checks.find((c) => c.id === "host");
      expect(host?.state).toBe("fail");
      expect(host?.detail).toContain("no longer supported");
      expect(host?.fix).toContain("Upgrade to OpenCode v2");
      // Returns right after host detection: nothing else is evaluated.
      expect(report.checks.map((c) => c.id)).toEqual(["host"]);
      expect(formatDoctorReport(report)).toContain("BROKEN");
    }
  });

  it("reports NOT_REGISTERED when a v2 host only has the legacy plugin array", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (tmp) => ({ plugin: [`${distRef(tmp)}/opencode.js`] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    expect(report.snippet).toContain('"plugins"');
  });

  it("reports NOT_REGISTERED with a snippet when config lacks the plugin", async () => {
    const { deps } = makeFixture({ config: () => ({ plugins: ["some-other-plugin"] }) });
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    expect(report.snippet).toContain('"plugins"');
  });

  it("finds a global registration when the project config only sets $schema (#65)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({ $schema: "https://opencode.ai/config.json" }),
    });
    const globalPath = writeGlobalConfig(tmp, {
      plugins: [{ package: "leakshield", options: { mode: "transparent" } }],
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    const registration = report.checks.find((c) => c.id === "registration");
    expect(registration?.state).toBe("ok");
    expect(registration?.detail).toContain(`(from ${globalPath})`);
    // Both files are in the chain, highest precedence first.
    expect(report.checks.find((c) => c.id === "config")?.detail).toBe(
      `${path.join(tmp, "opencode.json")}, ${globalPath}`,
    );
    expect(report.configPath).toBe(path.join(tmp, "opencode.json"));
  });

  it("does not lose the chain when only the global config has a plugins key (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ model: "openai/gpt-6" }) });
    writeGlobalConfig(tmp, { plugins: [{ package: "leakshield" }] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
  });

  it("ignores the inactive fallback root so a stale file cannot flip the verdict (#65)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({ $schema: "https://opencode.ai/config.json" }),
    });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    const fallback = path.join(tmp, "Library", "Application Support", "opencode");
    fs.mkdirSync(fallback, { recursive: true });
    fs.writeFileSync(path.join(fallback, "opencode.json"), "{ stale !!");
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "config")?.detail).not.toContain("Library");
  });

  it("falls back to the secondary global root when ~/.config has no config (#65)", async () => {
    const { deps, tmp } = makeFixture({});
    const dir = path.join(tmp, "Library", "Application Support", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "opencode.json");
    fs.writeFileSync(file, JSON.stringify({ plugins: ["leakshield"] }));
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "config")?.detail).toBe(file);
  });

  it("keeps a global registration when the project list adds other plugins (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: ["some-other-plugin"] }) });
    writeGlobalConfig(tmp, { plugins: [{ package: "leakshield", options: { mode: "transparent" } }] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "registration")?.detail).toContain("with options");
  });

  it("keeps a global registration when the project list is empty (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: [] }) });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("reports the disable entry that would stop the host loading LeakShield (#65)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({ $schema: "https://opencode.ai/config.json" }),
    });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    const disablePath = writeRepoConfig(tmp, { plugins: ["-leakshield"] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("NOT_REGISTERED");
    const detail = report.checks.find((c) => c.id === "registration")?.detail ?? "";
    expect(detail).toContain(disablePath);
    expect(detail).toContain('"-leakshield"');
  });

  it("treats -* as disabling every plugin (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: ["-*"] }) });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    expect((await runDoctor(deps)).status).toBe("NOT_REGISTERED");
  });

  it("matches a disable against the plugin id, not the dist path (#65)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: ["-leakshield"] }),
    });
    writeGlobalConfig(tmp, { plugins: [{ package: distRef(tmp) }] });
    expect((await runDoctor(deps)).status).toBe("NOT_REGISTERED");
  });

  it("does not let a removal of another plugin suppress LeakShield (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: ["-acme.reviewer"] }) });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "registration")?.detail).not.toContain("disabled");
  });

  it("restores entries with a wildcard enable (#65)", async () => {
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "-leakshield", "*"] }),
    });
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("validates the options of the entry applied last, even for the same package (#65)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: (fixtureTmp) => ({
        plugins: ["leakshield", { package: distRef(fixtureTmp), options: { mode: "bogus" } }],
      }),
    });
    writeGlobalConfig(tmp, {
      plugins: [{ package: distRef(tmp), options: { mode: "transparent" } }],
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "options")?.state).toBe("fail");
  });

  it("resolves a restored entry from the file that declared it, not the wildcard's file (#65)", async () => {
    // distFiles creates <cwd>/leakshield/dist, which the wildcard must not use.
    const { deps, tmp } = makeFixture({ distFiles: true, config: () => ({ plugins: ["*"] }) });
    writeGlobalConfig(tmp, { plugins: ["./leakshield/dist"] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "dist")?.detail).toContain(
      path.join(tmp, ".config", "opencode", "leakshield", "dist"),
    );
  });

  it("keeps a scoped package that merely ends in leakshield separate (#65)", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: ["@scope/leakshield"] }),
    });
    expect((await runDoctor(deps)).status).toBe("NOT_REGISTERED");
  });

  it('recognises a plugin directory given as "./" (#65)', async () => {
    const { deps, tmp } = makeFixture({});
    const root = path.join(tmp, "leakshield");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "index.js"), "export {};");
    fs.writeFileSync(path.join(root, "opencode.json"), JSON.stringify({ plugins: ["./"] }));
    expect((await runDoctor({ ...deps, cwd: root })).status).toBe("PROTECTED");
  });

  it('does not rebase a bare "." that the host resolves as a package (#65)', async () => {
    const { deps, tmp } = makeFixture({});
    const root = path.join(tmp, "leakshield");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "index.js"), "export {};");
    fs.writeFileSync(path.join(root, "opencode.json"), JSON.stringify({ plugins: ["."] }));
    expect((await runDoctor({ ...deps, cwd: root })).status).toBe("NOT_REGISTERED");
  });

  it("keeps a prefix removal off the prefix's own id (#65)", async () => {
    const { deps } = makeFixture({ config: () => ({ plugins: ["leakshield", "-leakshield.*"] }) });
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("keeps the options an earlier config set when a later ID re-enables it (#65)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: ["leakshield"] }),
    });
    writeGlobalConfig(tmp, {
      plugins: [{ package: distRef(tmp), options: { mode: "transparent", wireProtection: false } }],
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PARTIAL");
    expect(report.checks.find((c) => c.id === "options")?.detail).toContain("wireProtection=false");
  });

  it("keeps the options an earlier config set when an object selects the same ID (#65)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: [{ package: "leakshield" }] }),
    });
    writeGlobalConfig(tmp, {
      plugins: [{ package: distRef(tmp), options: { mode: "transparent", wireProtection: false } }],
    });
    expect((await runDoctor(deps)).status).toBe("PARTIAL");
  });

  it("validates a new reference instead of reusing the entry it replaced (#65)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({ plugins: ["-leakshield", "./leakshield/dist"] }),
    });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    // ./leakshield/dist does not exist under the project directory.
    expect((await runDoctor(deps)).status).toBe("BROKEN");
  });

  it.skipIf(process.platform === "win32")(
    "does not rebase a backslash-relative reference on POSIX (#65)",
    async () => {
      const { deps } = makeFixture({ config: () => ({ plugins: [".\\leakshield\\dist"] }) });
      expect((await runDoctor(deps)).status).toBe("NOT_REGISTERED");
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not read backslashes as separators in a POSIX path (#65)",
    async () => {
      const { deps, tmp } = makeFixture({});
      const dir = path.join(tmp, "fixture", "unrelated\\leakshield\\dist");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.js"), "export {};");
      fs.writeFileSync(path.join(tmp, "opencode.json"), JSON.stringify({ plugins: [dir] }));
      expect((await runDoctor(deps)).status).toBe("NOT_REGISTERED");
    },
  );

  it("fails a configured file path, which the host skips (#65)", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (fixtureTmp) => ({ plugins: [`${distRef(fixtureTmp)}/opencode.js`] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "dist")?.detail).toContain("single file");
  });

  it("decodes a file:// reference instead of using it literally (#65)", async () => {
    const { deps, tmp } = makeFixture({});
    const dir = path.join(tmp, "user name", "leakshield", "dist");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "export {};");
    fs.writeFileSync(
      path.join(tmp, "opencode.json"),
      JSON.stringify({ plugins: [pathToFileURL(dir).href] }),
    );
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("does not crash on an unrelated plugin with an invalid file:// URL (#65)", async () => {
    const { deps } = makeFixture({
      distFiles: true,
      config: (fixtureTmp) => ({
        plugins: ["file:///tmp/other%2Fplugin", { package: distRef(fixtureTmp), options: { mode: "transparent" } }],
      }),
    });
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("reports a LeakShield entry with an invalid file:// URL as unloadable (#65)", async () => {
    // A malformed escape is not a path on any platform, unlike a remote host (a
    // valid UNC URL on Windows).
    const { deps } = makeFixture({
      config: () => ({ plugins: ["file:///bad%/leakshield/dist"] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    const dist = report.checks.find((c) => c.id === "dist");
    expect(dist?.state).toBe("fail");
    expect(dist?.detail).toContain("not a file URL");
  });

  it("keeps a valid registration from hiding an invalid LeakShield URL (#65)", async () => {
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file:///bad%/leakshield/dist"] }),
    });
    // Before the tolerant decode this returned PROTECTED: the unloadable entry
    // was not recognised as LeakShield, so it escaped both checks.
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    const dist = report.checks.find((c) => c.id === "dist");
    expect(dist?.state).toBe("fail");
    expect(dist?.detail).toContain("not a file URL");
  });

  it("keeps the LeakShield id when the URL itself is unparsable (#65)", async () => {
    // `new URL` throws on the host, so the id comes from the raw text.
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file://[bad]/leakshield/dist"] }),
    });
    expect((await runDoctor(deps)).status).toBe("BROKEN");
  });

  it("recognises LeakShield across dot segments in an unloadable URL (#65)", async () => {
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file://[bad]/leakshield/./dist"] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    const dist = report.checks.find((c) => c.id === "dist");
    expect(dist?.state).toBe("fail");
    expect(dist?.detail).toContain("file://[bad]/leakshield/./dist");
  });

  it("strips literal control characters before identifying an unloadable URL (#65)", async () => {
    // URL parsing removes tab/CR/LF, so the path reads as /leakshield/dist.
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file:///bad%/leakshie\tld/dist"] }),
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("fail");
  });

  it("matches a case-variant LeakShield path in an unloadable URL (#65)", async () => {
    // On a case-insensitive filesystem this is the same directory.
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file://[bad]/Users/x/LeakShield/dist"] }),
    });
    expect((await runDoctor(deps)).status).toBe("BROKEN");
  });

  it("splits encoded separators even next to a bad escape (#65)", async () => {
    const { deps } = makeFixture({
      config: () => ({ plugins: ["leakshield", "file:///Users/x/leakshield%2Fdist%ZZ"] }),
    });
    expect((await runDoctor(deps)).status).toBe("BROKEN");
  });

  it("resolves a relative plugin path from the config file that declared it (#65)", async () => {
    const { deps, tmp } = makeFixture({});
    const dir = path.join(tmp, ".opencode", "leakshield", "dist");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.js"), "export {};");
    writeRepoConfig(tmp, { plugins: ["./leakshield/dist"] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PROTECTED");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("ok");
  });

  it("lets a later entry re-enable what a project list disabled (#65)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: ["-leakshield"] }) });
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    writeRepoConfig(tmp, { plugins: ["leakshield"] });
    expect((await runDoctor(deps)).status).toBe("PROTECTED");
  });

  it("keeps the weakest options when a selector re-adds the plugin (#67)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: [{ package: "leakshield", options: {} }] }),
    });
    writeGlobalConfig(tmp, {
      plugins: [{ package: distRef(tmp), options: { mode: "transparent", wireProtection: false } }],
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PARTIAL");
    expect(report.checks.find((c) => c.id === "options")?.detail).toContain("weakest of 2");
  });

  it("keeps the weakest options when a second reference re-adds the plugin (#67)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: () => ({ plugins: ["-leakshield", "./leakshield/dist"] }),
    });
    writeGlobalConfig(tmp, {
      plugins: [{ package: "leakshield", options: { mode: "transparent", wireProtection: false } }],
    });
    const report = await runDoctor(deps);
    expect(report.status).toBe("PARTIAL");
    expect(report.checks.find((c) => c.id === "dist")?.state).toBe("ok");
  });

  it("keeps the weakest options when the same reference is applied again (#67)", async () => {
    const { deps, tmp } = makeFixture({ config: () => ({ plugins: ["leakshield"] }) });
    writeGlobalConfig(tmp, {
      plugins: [{ package: "leakshield", options: { mode: "transparent", wireProtection: false } }],
    });
    expect((await runDoctor(deps)).status).toBe("PARTIAL");
  });

  it("loads the guard config of every configured entry (#67)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: (fixtureTmp) => ({
        plugins: [
          { package: distRef(fixtureTmp), options: { mode: "block", configPath: "/missing-guard.yml" } },
        ],
      }),
      options: {
        loadGuardConfig: (overridePath) => {
          if (overridePath === "/missing-guard.yml") throw new Error("no such file");
          return {} as GuardConfig;
        },
      },
    });
    writeGlobalConfig(tmp, { plugins: [{ package: "leakshield", options: { mode: "block" } }] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "guard-config")?.detail).toContain("/missing-guard.yml");
  });

  it("requires the canary under every configured guard config (#67)", async () => {
    const { deps, tmp } = makeFixture({
      distFiles: true,
      config: (fixtureTmp) => ({
        plugins: [
          { package: distRef(fixtureTmp), options: { mode: "transparent", configPath: "/disabled.yml" } },
        ],
      }),
      options: {
        loadGuardConfig: (overridePath) =>
          (overridePath === "/disabled.yml" ? { disabled: true } : {}) as GuardConfig,
        smokeScan: (_text, config) => ({
          findings: (config as unknown as { disabled?: boolean }).disabled ? 0 : 1,
        }),
      },
    });
    writeGlobalConfig(tmp, { plugins: [{ package: "leakshield", options: { mode: "transparent" } }] });
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    expect(report.checks.find((c) => c.id === "smoke")?.detail).toContain("/disabled.yml");
  });

  it("reports allow when any transparent entry allows attachments (#67)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({
        plugins: [{ package: "leakshield", options: { mode: "transparent", attachments: "allow" } }],
      }),
    });
    // The stricter entry comes first, so it wins the tie without the aggregate.
    writeGlobalConfig(tmp, { plugins: ["leakshield"] });
    const report = await runDoctor(deps);
    expect(report.checks.find((c) => c.id === "coverage")?.detail).toContain("ALLOW");
  });

  it("reports BROKEN for an unparsable file anywhere in the chain (#65)", async () => {
    const { deps, tmp } = makeFixture({
      config: () => ({ $schema: "https://opencode.ai/config.json" }),
    });
    const globalPath = writeGlobalConfig(tmp, "{ not json !!");
    const report = await runDoctor(deps);
    expect(report.status).toBe("BROKEN");
    const config = report.checks.find((c) => c.id === "config");
    expect(config?.state).toBe("fail");
    expect(config?.detail).toContain(globalPath);
    expect(report.configPath).toBe(globalPath);
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

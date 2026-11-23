// Component under test: pi doctor checks (src/pi/doctor.ts) and their effect
// on the shared doctor exit code.
import { describe, expect, it } from "vitest";
import { doctorExitCode, type DoctorReport } from "../src/doctor.js";
import { piVerdict } from "../src/doctor-hosts.js";
import { runPiDoctor, type PiDoctorDeps } from "../src/pi/doctor.js";

const AGENT = "/home/test/.pi/agent";
const EXTENSION = "/pkg/dist/pi/extension.js";

function deps(files: Record<string, string>, overrides: Partial<PiDoctorDeps> = {}): PiDoctorDeps {
  return {
    piVersion: () => "1.6.0",
    env: { HOME: "/home/test" },
    readFile: (filePath) => files[filePath] ?? null,
    fileExists: (filePath) => filePath === EXTENSION,
    home: "/home/test",
    cwd: "/work",
    extensionPath: () => EXTENSION,
    checkConfig: () => null,
    ...overrides,
  };
}

function stateOf(checks: Awaited<ReturnType<typeof runPiDoctor>>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.state;
}

function agent(settings: Record<string, unknown>, models: Record<string, unknown> = {}): Record<string, string> {
  return {
    [`${AGENT}/settings.json`]: JSON.stringify(settings),
    [`${AGENT}/models.json`]: JSON.stringify({ providers: models }),
  };
}

const ANTHROPIC = {
  anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "$ANTHROPIC_API_KEY" },
};

describe("pi doctor", () => {
  it("skips when pi is not installed", async () => {
    const checks = await runPiDoctor(deps({}, { piVersion: () => null }));
    expect(checks).toEqual([{ id: "pi", state: "skip", detail: expect.stringContaining("not found") }]);
  });

  it("fails an unsupported pi version before anything else", async () => {
    const checks = await runPiDoctor(deps({}, { piVersion: () => "2.1.0" }));
    expect(stateOf(checks, "pi")).toBe("fail");
    expect(stateOf(checks, "pi-extension")).toBeUndefined();
  });

  it("reports a registered first extension and a supported model as protected", async () => {
    const checks = await runPiDoctor(
      deps(agent({ defaultProvider: "anthropic", defaultModel: "claude-test", extensions: [EXTENSION] }, ANTHROPIC)),
    );
    expect(stateOf(checks, "pi-extension")).toBe("ok");
    expect(stateOf(checks, "pi-config")).toBe("ok");
    expect(stateOf(checks, "pi-extension-registered")).toBe("ok");
    expect(stateOf(checks, "pi-provider")).toBe("ok");
    expect(JSON.stringify(checks)).not.toContain("sk-ant-secret-value");
    expect(piVerdict(checks)).toEqual({ exit: 0, verdict: expect.stringContaining("PROTECTED") });
  });

  it("cannot verify a -e-only install from pi settings", async () => {
    const checks = await runPiDoctor(deps(agent({ defaultProvider: "anthropic" }, ANTHROPIC)));
    expect(stateOf(checks, "pi-extension-registered")).toBe("skip");
    expect(piVerdict(checks)).toEqual({ exit: 1, verdict: expect.stringContaining("NOT VERIFIED") });
  });

  it("reports a later position as partial rather than protected", async () => {
    const checks = await runPiDoctor(
      deps(agent({ defaultProvider: "anthropic", extensions: ["/other/before.js", EXTENSION] }, ANTHROPIC)),
    );
    expect(stateOf(checks, "pi-extension-registered")).toBe("warn");
    expect(piVerdict(checks)).toEqual({ exit: 0, verdict: expect.stringContaining("PARTIAL") });
  });

  it("resolves a relative extension entry against the working directory", async () => {
    const checks = await runPiDoctor(
      deps(
        agent({ defaultProvider: "anthropic", extensions: ["dist/pi/extension.js"] }, ANTHROPIC),
        { cwd: "/pkg" },
      ),
    );
    expect(stateOf(checks, "pi-extension-registered")).toBe("ok");
  });

  it("fails a model whose transport does not go through fetch", async () => {
    const checks = await runPiDoctor(
      deps(agent({ defaultProvider: "codex", extensions: [EXTENSION] }, {
        codex: { baseUrl: "https://chatgpt.com/backend-api", api: "openai-codex-responses" },
      })),
    );
    expect(stateOf(checks, "pi-provider")).toBe("fail");
    expect(piVerdict(checks).exit).toBe(1);
  });

  it("warns when the provider declares no api", async () => {
    const checks = await runPiDoctor(
      deps(agent({ defaultProvider: "builtin", extensions: [EXTENSION] }, {
        builtin: { baseUrl: "https://api.example.test" },
      })),
    );
    expect(stateOf(checks, "pi-provider")).toBe("warn");
  });

  it("fails a broken agent directory and an unloadable guard config", async () => {
    const broken = await runPiDoctor(deps({ [`${AGENT}/settings.json`]: "{oops" }));
    expect(stateOf(broken, "pi-settings")).toBe("fail");

    const config = await runPiDoctor(deps({}, { checkConfig: () => "bad rule" }));
    expect(stateOf(config, "pi-config")).toBe("fail");
  });

  it("reports a missing extension build and a missing binary", async () => {
    const missing = await runPiDoctor(deps({}, { fileExists: () => false }));
    expect(stateOf(missing, "pi-extension")).toBe("fail");
    expect(stateOf(missing, "pi")).toBe("ok");
  });

  it("lets a registered pi extension satisfy the HOST_MISSING fallback", () => {
    const report: DoctorReport = {
      status: "HOST_MISSING",
      hostVersion: null,
      hostGeneration: null,
      configPath: null,
      checks: [],
      pi: [{ id: "pi-extension-registered", state: "ok", detail: "first" }],
    };
    expect(doctorExitCode(report)).toBe(0);
    expect(
      doctorExitCode({ ...report, pi: [{ id: "pi-extension-registered", state: "warn", detail: "second" }] }),
    ).toBe(0);
    expect(
      doctorExitCode({ ...report, pi: [{ id: "pi-extension-registered", state: "skip", detail: "not visible" }] }),
    ).toBe(1);
    expect(
      doctorExitCode({ ...report, pi: [{ id: "pi", state: "fail", detail: "unsupported" }] }),
    ).toBe(1);
  });

  it("does not fail a protected OpenCode run for a broken pi setup", () => {
    const protectedRun: DoctorReport = {
      status: "PROTECTED",
      hostVersion: "2.2.5",
      hostGeneration: "v2",
      configPath: "/work/opencode.json",
      checks: [],
    };
    expect(
      doctorExitCode({ ...protectedRun, pi: [{ id: "pi-extension-registered", state: "fail", detail: "broken" }] }),
    ).toBe(0);
  });
});

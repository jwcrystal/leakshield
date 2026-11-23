// Component under test: pi doctor checks (src/pi/doctor.ts) and their effect
// on the shared doctor exit code.
import { describe, expect, it } from "vitest";
import { doctorExitCode, type DoctorReport } from "../src/doctor.js";
import { runPiDoctor, type PiDoctorDeps } from "../src/pi/doctor.js";

const AGENT = "/home/test/.pi/agent";

function deps(files: Record<string, string>, overrides: Partial<PiDoctorDeps> = {}): PiDoctorDeps {
  return {
    piVersion: () => "1.6.0",
    env: { HOME: "/home/test" },
    readFile: (filePath) => files[filePath] ?? null,
    fileExists: () => true,
    home: "/home/test",
    cwd: "/work",
    extensionPath: () => "/pkg/dist/pi/extension.js",
    probeProxy: async () => ({ ok: true, upstream: "https://api.anthropic.com" }),
    ...overrides,
  };
}

function stateOf(checks: Awaited<ReturnType<typeof runPiDoctor>>, id: string): string | undefined {
  return checks.find((check) => check.id === id)?.state;
}

const SETTINGS = JSON.stringify({ defaultModel: "claude-test" });
const MODELS = JSON.stringify({
  providers: {
    anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages", apiKey: "$ANTHROPIC_API_KEY" },
  },
});

describe("pi doctor", () => {
  it("skips when pi is not installed", async () => {
    const checks = await runPiDoctor(deps({}, { piVersion: () => null }));
    expect(checks).toEqual([{ id: "pi", state: "skip", detail: expect.stringContaining("not found") }]);
  });

  it("fails an unsupported pi version before anything else", async () => {
    const checks = await runPiDoctor(deps({}, { piVersion: () => "2.1.0" }));
    expect(stateOf(checks, "pi-version")).toBe("fail");
    expect(stateOf(checks, "pi-extension")).toBeUndefined();
  });

  it("reports the extension, provider and credential without reading the secret", async () => {
    const checks = await runPiDoctor(
      deps(
        { [`${AGENT}/settings.json`]: SETTINGS, [`${AGENT}/models.json`]: MODELS },
        {
          env: { HOME: "/home/test", PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-secret-value" },
          fileExists: () => false,
        },
      ),
    );
    expect(stateOf(checks, "pi-extension")).toBe("fail");
    expect(stateOf(checks, "pi-provider")).toBe("ok");
    expect(stateOf(checks, "pi-credential")).toBe("ok");
    expect(JSON.stringify(checks)).not.toContain("sk-ant-secret-value");
  });

  it("skips the provider check when no provider is selected", async () => {
    const checks = await runPiDoctor(
      deps({ [`${AGENT}/settings.json`]: SETTINGS, [`${AGENT}/models.json`]: MODELS }),
    );
    expect(stateOf(checks, "pi-provider")).toBe("skip");
    expect(checks.find((check) => check.id === "pi-provider")?.detail).toContain("`leakshield pi` requires --provider");
    expect(stateOf(checks, "pi-credential")).toBeUndefined();
  });

  it("warns when PI_PROVIDER names a provider outside models.json", async () => {
    const checks = await runPiDoctor(
      deps(
        { [`${AGENT}/settings.json`]: SETTINGS, [`${AGENT}/models.json`]: MODELS },
        { env: { HOME: "/home/test", PI_PROVIDER: "missing" } },
      ),
    );
    expect(stateOf(checks, "pi-provider")).toBe("warn");
    expect(checks.find((check) => check.id === "pi-provider")?.detail).toContain('"missing" is not declared');
    expect(stateOf(checks, "pi-credential")).toBeUndefined();
  });

  it("resolves the provider from generated settings only inside a managed launch", async () => {
    const generated = "/tmp/leakshield-pi/run-1/agent";
    const files = {
      [`${generated}/settings.json`]: JSON.stringify({ defaultProvider: "anthropic" }),
      [`${generated}/models.json`]: JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: "http://127.0.0.1:4321",
            api: "anthropic-messages",
            apiKey: "$LEAKSHIELD_PI_TOKEN",
          },
        },
      }),
    };
    const checks = await runPiDoctor(
      deps(files, {
        env: {
          HOME: "/home/test",
          PI_CODING_AGENT_DIR: generated,
          LEAKSHIELD_PI_URL: "http://127.0.0.1:4321",
          LEAKSHIELD_PI_TOKEN: "t".repeat(48),
        },
      }),
    );
    expect(stateOf(checks, "pi-provider")).toBe("ok");
    expect(checks.find((check) => check.id === "pi-provider")?.detail).toContain("anthropic");
    expect(stateOf(checks, "pi-credential")).toBe("ok");
    expect(stateOf(checks, "pi-launcher")).toBe("ok");

    const outside = await runPiDoctor(
      deps(files, { env: { HOME: "/home/test", PI_CODING_AGENT_DIR: generated } }),
    );
    expect(stateOf(outside, "pi-provider")).toBe("skip");
  });

  it("warns when no credential is available and when this is not a managed launch", async () => {
    const checks = await runPiDoctor(
      deps({
        [`${AGENT}/settings.json`]: SETTINGS,
        [`${AGENT}/models.json`]: JSON.stringify({
          providers: { anthropic: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" } },
        }),
      }, { env: { HOME: "/home/test", PI_PROVIDER: "anthropic" } }),
    );
    expect(stateOf(checks, "pi-credential")).toBe("warn");
    expect(checks.find((check) => check.id === "pi-credential")?.fix).toContain("in pi's models.json");
    expect(stateOf(checks, "pi-launcher")).toBe("warn");
  });

  it("warns that plain pi stays unprotected when models.json names real endpoints", async () => {
    const checks = await runPiDoctor(
      deps({
        [`${AGENT}/models.json`]: JSON.stringify({
          providers: { custom: { baseUrl: "https://api.example.test/v1", api: "openai-completions", models: [{ id: "m" }] } },
        }),
      }),
    );
    expect(stateOf(checks, "pi-route")).toBe("warn");
  });

  it("fails malformed pi configuration instead of guessing", async () => {
    const checks = await runPiDoctor(deps({ [`${AGENT}/settings.json`]: "{oops" }));
    expect(stateOf(checks, "pi-settings")).toBe("fail");
  });

  it("accepts an active boundary and rejects a dead or foreign one", async () => {
    const active = await runPiDoctor(
      deps(
        { [`${AGENT}/settings.json`]: SETTINGS },
        { env: { HOME: "/home/test", ANTHROPIC_API_KEY: "k", LEAKSHIELD_PI_URL: "http://127.0.0.1:4321" } },
      ),
    );
    expect(stateOf(active, "pi-launcher")).toBe("ok");

    const dead = await runPiDoctor(
      deps(
        { [`${AGENT}/settings.json`]: SETTINGS },
        { env: { HOME: "/home/test", LEAKSHIELD_PI_URL: "http://127.0.0.1:4321" }, probeProxy: async () => ({ ok: false, reason: "unreachable" }) },
      ),
    );
    expect(stateOf(dead, "pi-launcher")).toBe("fail");

    const foreign = await runPiDoctor(
      deps({}, { env: { HOME: "/home/test", LEAKSHIELD_PI_URL: "http://127.0.0.1:4321" }, probeProxy: async () => ({ ok: false, reason: "not-leakshield" }) }),
    );
    expect(stateOf(foreign, "pi-launcher")).toBe("fail");

    const remote = await runPiDoctor(deps({}, { env: { HOME: "/home/test", LEAKSHIELD_PI_URL: "https://example.test" } }));
    expect(stateOf(remote, "pi-launcher")).toBe("fail");
  });

  it("lets a managed pi launch satisfy the HOST_MISSING fallback", () => {
    const report: DoctorReport = {
      status: "HOST_MISSING",
      hostVersion: null,
      hostGeneration: null,
      configPath: null,
      checks: [],
      pi: [{ id: "pi-launcher", state: "ok", detail: "managed launch active" }],
    };
    expect(doctorExitCode(report)).toBe(0);
    expect(
      doctorExitCode({ ...report, pi: [{ id: "pi-launcher", state: "warn", detail: "not managed" }] }),
    ).toBe(1);
    expect(
      doctorExitCode({ ...report, pi: [{ id: "pi-version", state: "fail", detail: "unsupported" }] }),
    ).toBe(1);
  });

  it("does not fail a protected OpenCode run for an inactive broken pi setup", async () => {
    const protectedRun: DoctorReport = {
      status: "PROTECTED",
      hostVersion: "2.2.5",
      hostGeneration: "v2",
      configPath: "/work/opencode.json",
      checks: [],
    };
    // Real report shape: a broken agent directory still emits a `pi-launcher:
    // warn` row because this is not a managed launch.
    const checks = await runPiDoctor(
      deps({ [`${AGENT}/settings.json`]: "{oops" }, { env: { HOME: "/home/test" } }),
    );
    expect(stateOf(checks, "pi-settings")).toBe("fail");
    expect(stateOf(checks, "pi-launcher")).toBe("warn");
    expect(doctorExitCode({ ...protectedRun, pi: checks })).toBe(0);
    expect(
      doctorExitCode({ ...protectedRun, pi: [{ id: "pi-launcher", state: "fail", detail: "dead boundary" }] }),
    ).toBe(1);
  });
});

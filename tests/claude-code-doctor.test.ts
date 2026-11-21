import path from "node:path";
import { describe, expect, it } from "vitest";
import { runClaudeCodeDoctor, type ClaudeCodeDoctorDeps, type ProxyProbe } from "../src/claude-code/doctor.js";
import { doctorExitCode, formatDoctorReport, type DoctorReport } from "../src/doctor.js";

const HOME = "/home/u";
const CWD = "/work/p";

function deps(over: {
  files?: Record<string, string>;
  env?: Record<string, string>;
  probe?: (url: string) => ProxyProbe;
  claude?: string | null;
} = {}): ClaudeCodeDoctorDeps & { probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    claudeVersion: () => (over.claude === undefined ? "2.1.321 (Claude Code)" : over.claude),
    readIfExists: (file) => over.files?.[file] ?? null,
    probeProxy: async (url) => {
      probed.push(url);
      return over.probe ? over.probe(url) : { ok: false, reason: "unreachable" };
    },
    env: over.env ?? {},
    cwd: CWD,
    home: HOME,
  };
}

const userSettings = path.join(HOME, ".claude", "settings.json");
const projectLocal = path.join(CWD, ".claude", "settings.local.json");
const byId = (checks: Awaited<ReturnType<typeof runClaudeCodeDoctor>>, id: string) => checks.find((c) => c.id === id);

describe("Claude Code doctor", () => {
  it("skips when claude is not installed", async () => {
    const checks = await runClaudeCodeDoctor(deps({ claude: null }));
    expect(checks).toEqual([expect.objectContaining({ id: "claude-code", state: "skip" })]);
  });

  it("warns when ANTHROPIC_BASE_URL is not set anywhere", async () => {
    const d = deps();
    const check = byId(await runClaudeCodeDoctor(d), "claude-code-proxy");
    expect(check?.state).toBe("warn");
    expect(check?.fix).toContain("leakshield --claude-code-proxy");
    expect(d.probed).toEqual([]);
  });

  it("reports ok when settings point at a running LeakShield proxy", async () => {
    const d = deps({
      files: { [userSettings]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } }) },
      probe: () => ({ ok: true, upstream: "https://api.anthropic.com" }),
    });
    const check = byId(await runClaudeCodeDoctor(d), "claude-code-proxy");
    expect(check?.state).toBe("ok");
    expect(check?.detail).toContain(userSettings);
    expect(d.probed).toEqual(["http://127.0.0.1:8787"]);
  });

  it("fails when the base URL is local but nothing answers", async () => {
    const check = byId(await runClaudeCodeDoctor(deps({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } })), "claude-code-proxy");
    expect(check?.state).toBe("fail");
  });

  it("warns when the base URL is some other gateway", async () => {
    const check = byId(await runClaudeCodeDoctor(deps({
      env: { ANTHROPIC_BASE_URL: "https://gateway.example" },
      probe: () => ({ ok: false, reason: "not-leakshield" }),
    })), "claude-code-proxy");
    expect(check?.state).toBe("warn");
  });

  it("lets project-local settings win over user settings and the shell", async () => {
    const d = deps({
      files: {
        [userSettings]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://user.example" } }),
        [projectLocal]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9000" } }),
      },
      env: { ANTHROPIC_BASE_URL: "https://shell.example" },
      probe: () => ({ ok: true, upstream: null }),
    });
    const checks = await runClaudeCodeDoctor(d);
    expect(d.probed).toEqual(["http://127.0.0.1:9000"]);
    expect(byId(checks, "claude-code-env")?.state).toBe("warn");
  });

  it("warns when a Bedrock or Vertex provider bypasses the base URL", async () => {
    const checks = await runClaudeCodeDoctor(deps({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }));
    expect(byId(checks, "claude-code-provider")?.state).toBe("warn");
  });

  it("warns when the embedding host manages the provider", async () => {
    const checks = await runClaudeCodeDoctor(deps({ env: { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" } }));
    expect(byId(checks, "claude-code-host-managed")?.state).toBe("warn");
  });

  it("warns about unreadable settings instead of failing", async () => {
    const checks = await runClaudeCodeDoctor(deps({ files: { [userSettings]: "{ not json" } }));
    expect(byId(checks, "claude-code-settings")?.state).toBe("warn");
  });
});

describe("doctor report with Claude Code", () => {
  const base: DoctorReport = { status: "HOST_MISSING", hostVersion: null, hostGeneration: null, configPath: null, checks: [] };

  it("exits 0 on a Claude-Code-only machine whose proxy is in place", () => {
    expect(doctorExitCode(base)).toBe(1);
    expect(doctorExitCode({ ...base, claudeCode: [{ id: "claude-code-proxy", state: "ok", detail: "x" }] })).toBe(0);
    expect(doctorExitCode({ ...base, claudeCode: [{ id: "claude-code-proxy", state: "warn", detail: "x" }] })).toBe(1);
    expect(doctorExitCode({ ...base, status: "PROTECTED" })).toBe(0);
  });

  it("keeps every other OpenCode status as it was", () => {
    const proxied = [{ id: "claude-code-proxy", state: "ok" as const, detail: "x" }];
    expect(doctorExitCode({ ...base, status: "BROKEN", claudeCode: proxied })).toBe(1);
    expect(doctorExitCode({ ...base, status: "NOT_REGISTERED", claudeCode: proxied })).toBe(1);
    expect(doctorExitCode({ ...base, status: "PARTIAL", claudeCode: proxied })).toBe(0);
  });

  it("does not count Claude Code as protected when a provider bypasses the proxy", () => {
    const ok = { id: "claude-code-proxy", state: "ok" as const, detail: "x" };
    for (const id of ["claude-code-provider", "claude-code-host-managed"]) {
      expect(doctorExitCode({ ...base, claudeCode: [{ id, state: "warn", detail: "x" }, ok] })).toBe(1);
    }
  });

  it("fails when Claude Code points at a proxy that is not running", () => {
    const dead = [{ id: "claude-code-proxy", state: "fail" as const, detail: "x" }];
    expect(doctorExitCode({ ...base, status: "PROTECTED", claudeCode: dead })).toBe(1);
  });

  it("prints the Claude Code section", () => {
    const text = formatDoctorReport({ ...base, claudeCode: [{ id: "claude-code-proxy", state: "warn", detail: "not set", fix: "run it" }] });
    expect(text).toContain("Claude Code:");
    expect(text).toContain("[WARN] claude-code-proxy: not set");
  });
});

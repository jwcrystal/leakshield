// Component under test: per-host doctor dispatch (src/doctor-hosts.ts).
import { describe, expect, it } from "vitest";
import { claudeCodeVerdict, parseDoctorTarget, piVerdict, runDoctorCommand } from "../src/doctor-hosts.js";

describe("doctor target parsing", () => {
  it("accepts a bare flag, a separated target and an inline target", () => {
    expect(parseDoctorTarget(["--doctor"])).toBe("all");
    expect(parseDoctorTarget(["--doctor", "pi"])).toBe("pi");
    expect(parseDoctorTarget(["--doctor", "claude-code"])).toBe("claude-code");
    expect(parseDoctorTarget(["--doctor=opencode"])).toBe("opencode");
    expect(parseDoctorTarget(["--doctor", "all"])).toBe("all");
  });

  it("does not consume another flag as a target", () => {
    expect(parseDoctorTarget(["--doctor", "--forget"])).toBe("all");
  });

  it("refuses an unknown target instead of silently checking everything", async () => {
    expect(parseDoctorTarget(["--doctor", "nope"])).toMatchObject({
      error: expect.stringContaining("unknown doctor target"),
    });
    expect(parseDoctorTarget(["--doctor="])).toMatchObject({ error: expect.stringContaining("missing") });
    expect(await runDoctorCommand(["--doctor", "nope"])).toBe(2);
    expect(await runDoctorCommand(["--doctor=nope"])).toBe(2);
  });
});

describe("per-host verdicts", () => {
  it("treats Claude Code as protected only behind a healthy proxy", () => {
    expect(
      claudeCodeVerdict([
        { id: "claude-code", state: "ok", detail: "2.1.321" },
        { id: "claude-code-proxy", state: "ok", detail: "proxy answers" },
      ]).exit,
    ).toBe(0);
    expect(
      claudeCodeVerdict([
        { id: "claude-code", state: "ok", detail: "2.1.321" },
        { id: "claude-code-proxy", state: "warn", detail: "not set" },
      ]).exit,
    ).toBe(1);
    expect(
      claudeCodeVerdict([
        { id: "claude-code", state: "ok", detail: "2.1.321" },
        { id: "claude-code-provider", state: "warn", detail: "bedrock" },
        { id: "claude-code-proxy", state: "ok", detail: "proxy answers" },
      ]).exit,
    ).toBe(1);
    expect(claudeCodeVerdict([{ id: "claude-code", state: "skip", detail: "not found" }])).toEqual({
      exit: 1,
      verdict: expect.stringContaining("NOT INSTALLED"),
    });
  });

  it("treats pi as protected only inside a managed launch", () => {
    expect(
      piVerdict([
        { id: "pi", state: "ok", detail: "1.6.0" },
        { id: "pi-launcher", state: "ok", detail: "managed launch active" },
      ]),
    ).toEqual({ exit: 0, verdict: expect.stringContaining("PROTECTED") });
    expect(
      piVerdict([
        { id: "pi", state: "ok", detail: "1.6.0" },
        { id: "pi-launcher", state: "warn", detail: "not managed" },
      ]).exit,
    ).toBe(1);
    expect(
      piVerdict([
        { id: "pi", state: "ok", detail: "1.6.0" },
        { id: "pi-launcher", state: "fail", detail: "dead boundary" },
      ]).exit,
    ).toBe(1);
    expect(piVerdict([{ id: "pi", state: "skip", detail: "not found" }])).toEqual({
      exit: 1,
      verdict: expect.stringContaining("NOT INSTALLED"),
    });
  });
});

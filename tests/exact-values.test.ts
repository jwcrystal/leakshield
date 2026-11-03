import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GuardConfigSchema, loadConfig } from "../src/config/loader.js";
import { deidentifyText } from "../src/decision/deidentify.js";
import { toDecisionResult } from "../src/decision/model.js";
import { createPseudonymizer } from "../src/decision/pseudonymization.js";
import { redactText, scanText } from "../src/scanner/engine.js";
import { ExactValueDetector } from "../src/scanner/exact-values.js";
import { filterBySeverity } from "../src/transports/cli.js";
import type { GuardConfig } from "../src/types.js";

const OPAQUE_VALUE = "unclassified-opaque-value-987654321";
let projectRoot: string | undefined;

function createProject(config: string, env = ""): string {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-env-"));
  fs.mkdirSync(path.join(projectRoot, "config"));
  fs.writeFileSync(path.join(projectRoot, "config", "guard.config.yaml"), config, "utf8");
  fs.writeFileSync(path.join(projectRoot, ".env"), env, "utf8");
  return path.join(projectRoot, "config", "guard.config.yaml");
}

function loadProjectConfig(config: string, env = "") {
  const configPath = createProject(config, env);
  return loadConfig(configPath, projectRoot);
}

afterEach(() => {
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
  projectRoot = undefined;
});

describe("exact values from configured env_files", () => {
  it("does not load .env unless env_files explicitly enables it", () => {
    const config = loadProjectConfig("settings: {}\n", `TOKEN=${OPAQUE_VALUE}\n`);

    expect(scanText(`token: ${OPAQUE_VALUE}`, config).safe).toBe(true);
  });

  it("detects and redacts exact values that do not match built-in patterns", () => {
    const config = loadProjectConfig(
      "settings:\n  env_files:\n    - .env\n",
      `TOKEN=${OPAQUE_VALUE}\nEMPTY=\n`,
    );
    const text = `token: ${OPAQUE_VALUE}`;

    const scan = scanText(text, config);
    expect(scan.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ENV_SECRET", severity: "HIGH", match_text: OPAQUE_VALUE }),
    ]));
    expect(redactText(text, config).redacted).toBe("token: [REDACTED_ENV_SECRET]");
  });

  it("parses quoted values and strips unquoted comments", () => {
    const config = loadProjectConfig(
      "settings:\n  env_files:\n    - .env\n",
      `QUOTED=\"${OPAQUE_VALUE}\"\nCOMMENTED=${OPAQUE_VALUE} # deployment token\n`,
    );

    const scan = scanText(`${OPAQUE_VALUE}\n${OPAQUE_VALUE}`, config);
    expect(scan.findings.filter((finding) => finding.type === "ENV_SECRET")).toHaveLength(2);
  });

  it("redacts the complete env value when it overlaps a built-in rule", () => {
    const overlappingValue = "prefix-user@example.com-suffix";
    const config = loadProjectConfig(
      "settings:\n  env_files:\n    - .env\n",
      `TOKEN=${overlappingValue}\n`,
    );

    expect(redactText(`token=${overlappingValue}`, config).redacted)
      .toBe("token=[REDACTED_ENV_SECRET]");
  });

  it("keeps one complete placeholder when an exact value overlaps a longer rule match", () => {
    const exactValue = "overlap-secret";
    const config = loadProjectConfig(
      [
        "custom_rules:",
        "  - description: Full token",
        `    pattern: ${exactValue}-suffix`,
        "    severity: HIGH",
        "settings:",
        "  env_files:",
        "    - .env",
        "",
      ].join("\n"),
      `TOKEN=${exactValue}\n`,
    );

    expect(redactText(`token=${exactValue}-suffix`, config).redacted)
      .toBe("token=[REDACTED_CUSTOM]");
  });

  it("does not serialize exact secret values into the loaded config", () => {
    const config = loadProjectConfig(
      "settings:\n  env_files:\n    - .env\n",
      `TOKEN=${OPAQUE_VALUE}\n`,
    );

    expect(JSON.stringify(config)).not.toContain(OPAQUE_VALUE);
  });

  it("rejects configured files outside the workspace", () => {
    const configPath = createProject("settings:\n  env_files:\n    - ../outside.env\n");

    expect(() => loadConfig(configPath, projectRoot)).toThrow(/outside the workspace/i);
  });

  it("fails when a configured env file cannot be read", () => {
    const configPath = createProject("settings:\n  env_files:\n    - .env.local\n");

    expect(() => loadConfig(configPath, projectRoot)).toThrow(/configured env file/i);
  });
});

describe("exact values on the same range as a rule finding", () => {
  const VALUE = "synthetic-exact-value";

  function configWith(severity: "HIGH" | "MEDIUM" | "LOW"): GuardConfig {
    return {
      ...GuardConfigSchema.parse({
        nda_keywords: [],
        custom_rules: [{ description: "synthetic-rule", pattern: VALUE, severity }],
        settings: {},
      }),
      exact_value_detector: new ExactValueDetector([VALUE]),
    };
  }

  it.each(["LOW", "MEDIUM"] as const)("reports ENV_SECRET at HIGH beside a %s rule", (severity) => {
    expect(scanText(VALUE, configWith(severity)).findings.map((f) => [f.type, f.severity])).toEqual([
      ["CUSTOM", severity],
      ["ENV_SECRET", "HIGH"],
    ]);
  });

  it("keeps one finding when the rule is already HIGH", () => {
    expect(scanText(VALUE, configWith("HIGH")).findings.map((f) => [f.type, f.severity])).toEqual([
      ["CUSTOM", "HIGH"],
    ]);
  });

  it("keeps the match under --min-severity high and raises the decision", () => {
    const scan = scanText(VALUE, configWith("LOW"));
    expect(filterBySeverity(scan, "high").findings.map((f) => f.match_text)).toEqual([VALUE]);
    expect(toDecisionResult(scan, VALUE)).toMatchObject({ riskLevel: "CRITICAL", recommendedAction: "BLOCK" });
  });

  it("labels the transparent-mode token by the higher severity", () => {
    const created = createPseudonymizer(configWith("LOW"));
    if (!created.ok) throw new Error("static failure");
    const result = created.protectText("s", VALUE);
    if (!result.ok) throw new Error("protect failed");
    expect(result.text).toMatch(/^\[SGP2:ENV_SECRET-[a-z-]+\]$/);
  });

  it("still de-identifies an email that is also an exact value", () => {
    const email = "synthetic@example.com";
    const config = { ...configWith("LOW"), exact_value_detector: new ExactValueDetector([email]) };
    expect(scanText(email, config).findings.map((f) => [f.type, f.severity])).toEqual([
      ["PII_EMAIL", "MEDIUM"],
      ["ENV_SECRET", "HIGH"],
    ]);
    const result = deidentifyText(email, config, Buffer.alloc(32, 1), { mode: "redact", context: "message text" });
    expect(result.action).not.toBe("block");
    expect(result.text).not.toContain(email);
  });

  it("still honours an ignore directive and the allowlist", () => {
    expect(scanText(`${VALUE} // sg-ignore`, configWith("LOW")).findings).toEqual([]);
    const config = configWith("LOW");
    config.settings.allowlist = [VALUE];
    expect(scanText(VALUE, config).findings).toEqual([]);
  });

  it("writes one placeholder and reports both findings from redactText", () => {
    const result = redactText(`token=${VALUE}`, configWith("LOW"));
    expect(result.redacted).toBe("token=[REDACTED_CUSTOM]");
    expect(result.findings.map((f) => f.type)).toEqual(["CUSTOM", "ENV_SECRET"]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config/loader.js";
import { redactText, scanText } from "../src/scanner/engine.js";

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

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { z } from "zod";
import { loadExactValueDetector } from "../scanner/exact-values.js";
import { BUILTIN_RULE_IDS } from "../rules/builtin.js";
import type { GuardConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_DYNAMIC_RULE_LENGTH = 200;
const MAX_PRIVATE_DOMAIN_LENGTH = 255;
const MAX_ENV_FILE_PATH_LENGTH = 4096;

const CustomRuleSchema = z.object({
  description: z.string().min(1).max(MAX_DYNAMIC_RULE_LENGTH),
  pattern: z.string().min(1).max(MAX_DYNAMIC_RULE_LENGTH),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).default("HIGH"),
});

export const GuardConfigSchema = z.object({
  nda_keywords: z.array(z.string().min(1).max(MAX_DYNAMIC_RULE_LENGTH)).default(["CONFIDENTIAL", "INTERNAL ONLY", "DO NOT SHARE", "NDA"]),
  private_domains: z.array(z.string().min(1).max(MAX_PRIVATE_DOMAIN_LENGTH)).default([]),
  custom_rules: z.array(CustomRuleSchema).nullable().default([]).transform((v) => v ?? []),
  settings: z.object({
    max_chars: z.number().int().positive().default(200000),
    show_line_numbers: z.boolean().default(true),
    preview_length: z.number().int().positive().default(60),
    encoding_detection: z.boolean().default(false),
    env_files: z.array(z.string().min(1).max(MAX_ENV_FILE_PATH_LENGTH)).max(16).default([]),
    rule_overrides: z.record(z.string().min(1), z.boolean()).default({}),
  }).default({}),
}).superRefine((config, ctx) => {
  // Unknown rule ids in `rule_overrides` fail the parse (fail-closed): a typo
  // must never silently leave a rule in the wrong state.
  const overrides = config.settings.rule_overrides ?? {};
  for (const id of Object.keys(overrides)) {
    if (!BUILTIN_RULE_IDS.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["settings", "rule_overrides", id],
        message: `unknown builtin rule id "${id}" (see src/rules/builtin.ts BUILTIN_RULE_IDS)`,
      });
    }
  }
  // A custom rule whose pattern does not compile fails the parse too: the
  // scanner would otherwise drop it and report clean text as safe.
  config.custom_rules.forEach((rule, index) => {
    try {
      new RegExp(rule.pattern, "gi");
    } catch (error) {
      // V8 messages embed the pattern ("Invalid regular expression: /…/gi:
      // reason"); keep only the reason, since a pattern may itself be a
      // literal the rule exists to protect.
      const reason = (error as Error).message.split(": ").pop();
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["custom_rules", index, "pattern"],
        message: `custom_rules[${index}] "${rule.description}": pattern does not compile (${reason})`,
      });
    }
  });
});

function finalizeConfig(config: GuardConfig, workspaceRoot: string): GuardConfig {
  return {
    ...config,
    exact_value_detector: loadExactValueDetector(config.settings.env_files ?? [], workspaceRoot),
  };
}

/**
 * Resolves the guard config path exactly like `loadConfig` does: the override
 * when it exists, otherwise the first default candidate that exists. Returns
 * undefined when no config file is present (defaults apply).
 */
export function findConfigPath(overridePath?: string): string | undefined {
  const configPaths = overridePath
    ? [overridePath]
    : [
        path.resolve(process.cwd(), "config/guard.config.yaml"),
        path.resolve(__dirname, "../../config/guard.config.yaml"),
        path.resolve(process.env.HOME ?? "~", ".leakshield/guard.config.yaml"),
      ];

  for (const p of configPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export interface LoadedGuardConfig {
  config: GuardConfig;
  /**
   * sha256 of the exact bytes `config` was parsed from, or "absent" when no
   * configuration file exists (defaults apply). Consumers that authorize from
   * this config can compare the fingerprint on later reads.
   */
  fingerprint: string;
  configPath: string | undefined;
}

/**
 * Loads the guard config and, from the very same read, the fingerprint of the
 * bytes it was parsed from. The allowlist inside `config` and `fingerprint`
 * are therefore guaranteed to describe one configuration state — an edit
 * between a config load and a separate fingerprint read could otherwise
 * authorize against content that never existed at a single point in time.
 */
export function loadConfigWithFingerprint(
  overridePath?: string,
  workspaceRoot = process.cwd(),
): LoadedGuardConfig {
  const configPath = findConfigPath(overridePath);
  if (!configPath) {
    return {
      config: finalizeConfig(GuardConfigSchema.parse({}), workspaceRoot),
      fingerprint: "absent",
      configPath,
    };
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return {
    config: finalizeConfig(GuardConfigSchema.parse(yaml.load(raw)), workspaceRoot),
    fingerprint: createHash("sha256").update(raw).digest("hex"),
    configPath,
  };
}

export function loadConfig(overridePath?: string, workspaceRoot = process.cwd()): GuardConfig {
  return loadConfigWithFingerprint(overridePath, workspaceRoot).config;
}

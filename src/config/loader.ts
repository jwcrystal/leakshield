import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { z } from "zod";
import { loadExactValueDetector } from "../scanner/exact-values.js";
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
  }).default({}),
});

function finalizeConfig(config: GuardConfig, workspaceRoot: string): GuardConfig {
  return {
    ...config,
    exact_value_detector: loadExactValueDetector(config.settings.env_files ?? [], workspaceRoot),
  };
}

export function loadConfig(overridePath?: string, workspaceRoot = process.cwd()): GuardConfig {
  const configPaths = overridePath
    ? [overridePath]
    : [
        path.resolve(process.cwd(), "config/guard.config.yaml"),
        path.resolve(__dirname, "../../config/guard.config.yaml"),
        path.resolve(process.env.HOME ?? "~", ".sensitive-guard/guard.config.yaml"),
      ];

  for (const p of configPaths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf-8");
      return finalizeConfig(GuardConfigSchema.parse(yaml.load(raw)), workspaceRoot);
    }
  }

  return finalizeConfig(GuardConfigSchema.parse({}), workspaceRoot);
}

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import { z } from "zod";
import type { GuardConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GuardConfigSchema = z.object({
  nda_keywords: z.array(z.string()).default(["CONFIDENTIAL", "INTERNAL ONLY", "DO NOT SHARE", "NDA"]),
  private_domains: z.array(z.string()).default([]),
  settings: z.object({
    max_chars: z.number().int().positive().default(200000),
    show_line_numbers: z.boolean().default(true),
    preview_length: z.number().int().positive().default(60),
  }).default({}),
});

export function loadConfig(overridePath?: string): GuardConfig {
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
      return GuardConfigSchema.parse(yaml.load(raw));
    }
  }

  return GuardConfigSchema.parse({});
}

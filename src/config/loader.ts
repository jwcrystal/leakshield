import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { fileURLToPath } from "url";
import type { GuardConfig } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG: GuardConfig = {
  nda_keywords: ["CONFIDENTIAL", "INTERNAL ONLY", "DO NOT SHARE", "NDA"],
  private_domains: [],
  settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60 },
};

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
      return yaml.load(raw) as GuardConfig;
    }
  }

  return DEFAULT_CONFIG;
}

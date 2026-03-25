// ─── Domain Types ────────────────────────────────────────────────────────────

export interface CustomRuleConfig {
  description: string;
  pattern: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
}

export interface GuardConfig {
  nda_keywords: string[];
  private_domains: string[];
  custom_rules: CustomRuleConfig[];
  settings: {
    max_chars: number;
    show_line_numbers: boolean;
    preview_length: number;
  };
}

export type FindingType =
  | "API_KEY"
  | "SECRET"
  | "TOKEN"
  | "PII_EMAIL"
  | "PII_PHONE_TW"
  | "PII_PHONE_INTL"
  | "PII_ID_TW"
  | "DB_CONNECTION"
  | "PRIVATE_DOMAIN"
  | "NDA_KEYWORD"
  | "CUSTOM";

export interface Finding {
  type: FindingType;
  severity: "HIGH" | "MEDIUM" | "LOW";
  line?: number;
  column?: number;
  preview: string;
  description: string;
  /** Byte offset of the match start in the original text (for deterministic redaction). */
  match_start?: number;
  /** Byte offset one past the match end in the original text. */
  match_end?: number;
  /** The raw matched text (used by the redaction layer; never exposed in output). */
  match_text?: string;
}

export interface ScanResult {
  safe: boolean;
  total_findings: number;
  findings: Finding[];
  summary: string;
  recommendation: string;
}

export interface RedactResult {
  redacted: string;
  findings: Finding[];
  total_findings: number;
  summary: string;
}

export interface Rule {
  type: FindingType;
  severity: Finding["severity"];
  description: string;
  pattern: RegExp;
}

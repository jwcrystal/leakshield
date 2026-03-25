// ─── Domain Types ────────────────────────────────────────────────────────────

export interface GuardConfig {
  nda_keywords: string[];
  private_domains: string[];
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
  | "NDA_KEYWORD";

export interface Finding {
  type: FindingType;
  severity: "HIGH" | "MEDIUM" | "LOW";
  line?: number;
  column?: number;
  preview: string;
  description: string;
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

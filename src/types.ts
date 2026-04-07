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
  /** Internal-only: byte offset of match start in the original content. */
  match_start?: number;
  /** Internal-only: byte offset of match end in the original content. */
  match_end?: number;
  /** Internal-only: the raw matched text. Never expose to CLI/MCP outputs. */
  match_text?: string;
  /** Metadata about encoding detection (if found via decoding) */
  encoding_detected?: {
    type: 'Base64' | 'URL' | 'Hex';
    confidence: number;
    encoded_length?: number;
    decoded_length?: number;
  };
}

export interface ScanResult {
  safe: boolean;
  total_findings: number;
  findings: Finding[];
  summary: string;
  recommendation: string;
  /** Indica se o conteúdo foi truncado durante a verificação */
  was_truncated?: boolean;
  /** Metadados sobre sanitização Unicode */
  unicode_sanitized?: {
    hadZeroWidth: boolean;
    hadVariants: boolean;
    removedChars: number;
    homographSuspected: boolean;
  };
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

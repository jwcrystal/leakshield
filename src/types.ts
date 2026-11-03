import type { ExactValueDetector } from "./scanner/exact-values.js";

// ─── Domain Types ────────────────────────────────────────────────────────────

export interface CustomRuleConfig {
  description: string;
  pattern: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  /**
   * Extra regex flags, a subset of `imsuy`; `g` is always added. Invalid flags
   * fail config load rather than being ignored.
   */
  flags?: string;
  /**
   * Wrap the pattern edges in `\b` where that edge is an ASCII word character.
   * CJK edges are left alone for the same reason as `keywordPattern`: `\b` never
   * holds between two non-word characters.
   */
  word_boundary?: boolean;
  /** Exact strings this rule never reports. Not a regex; not a partial match. */
  allow?: string[];
  /**
   * Reserved. Accepted and validated, but the scanner has no source path for
   * chat/tool text, so it does not scope anything yet; `--doctor` warns when set.
   */
  path?: string[];
}

export interface GuardConfig {
  nda_keywords: string[];
  private_domains: string[];
  custom_rules: CustomRuleConfig[];
  settings: {
    max_chars: number;
    show_line_numbers: boolean;
    preview_length: number;
    encoding_detection: boolean;
    env_files?: string[];
    /** Built-in rule id → enabled. Absent id = the rule's own default (opt-in rules stay off). */
    rule_overrides?: Record<string, boolean>;
    /**
     * Networks the opt-in `private-ipv4` rule reports. Empty or absent uses
     * RFC 1918, CGNAT and link-local. Entries are validated at config load.
     */
    private_cidrs?: string[];
    /**
     * Exact strings that never produce a finding, for any rule. A bypass
     * surface: every entry is surfaced by `--doctor`, and every suppression is
     * counted. Not a regex, not a partial match.
     */
    allowlist?: string[];
  };
  /** In-memory only; serializes to a fingerprint without retaining raw values. */
  exact_value_detector?: ExactValueDetector;
}

/**
 * Runtime-closed enumeration (R-round F1.2): the SGP2 category whitelist is
 * enforced at persisted-seed intake, so the legal labels must exist as a
 * value, not just a type. Keep list and type in one place.
 */
export const FINDING_TYPES = [
  "API_KEY",
  "SECRET",
  "TOKEN",
  "PII_EMAIL",
  "PII_PHONE_TW",
  "PII_PHONE_INTL",
  "PII_ID_TW",
  "DB_CONNECTION",
  "PRIVATE_DOMAIN",
  "NDA_KEYWORD",
  "ENV_SECRET",
  "CUSTOM",
  "PII_CREDIT_CARD",
  "PII_IBAN",
  "PII_IP",
  "PII_URL",
  "ENCODED",
] as const;

export type FindingType = (typeof FINDING_TYPES)[number];

export interface Finding {
  type: FindingType;
  severity: "HIGH" | "MEDIUM" | "LOW";
  line?: number;
  column?: number;
  preview: string;
  description: string;
  /** Internal-only: UTF-16 code-unit offset of the match start in the original content (regex `.index`; the scanner slices with String.slice). Not a byte offset. */
  match_start?: number;
  /** Internal-only: UTF-16 code-unit offset of the match end (match_start + match length). Not a byte offset. */
  match_end?: number;
  /** Internal-only: the raw matched text. Never expose to transport outputs. */
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
  /**
   * Exact strings this rule never reports. Compared against the matched text,
   * never partially. A suppression is counted and surfaced by `--doctor`.
   */
  allow?: ReadonlySet<string>;
  /**
   * Stable identifier for built-in rules, the key used by
   * `settings.rule_overrides` in the guard config. Every BUILTIN_RULES entry
   * must set one (tests enforce this) so any built-in can be toggled.
   */
  id?: string;
  /**
   * Opt-in rules are disabled unless explicitly enabled via
   * `settings.rule_overrides`. Used for high-noise rules (e.g. URL) that
   * must not run always-on.
   */
  optIn?: boolean;
  /**
   * Optional semantic validation for a regex match (Luhn for credit cards,
   * mod-97 for IBAN, routability for IPv4). Returning false skips the match
   * entirely — used to keep checksum-capable formats at near-zero false
   * positives without weakening the pattern shape.
   *
   * `context` carries the scanned text and the match offset for rules whose
   * meaning depends on surrounding syntax (an email-shaped span that is really
   * an SSH remote authority). It is supplied by the engine, never by callers
   * that only know the matched string.
   */
  validate?: (match: string, context: { text: string; index: number }) => boolean;
  /**
   * Characters at the start of `pattern`'s match that are syntax, not the
   * finding. The engine reports and redacts from `match.index + skipPrefix`.
   * Used by url-userinfo, which must anchor on `://` without a variable-length
   * lookbehind (V8 retries that lookbehind at every position, which is
   * quadratic on a long token).
   */
  skipPrefix?: number;
}

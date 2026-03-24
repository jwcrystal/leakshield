import type { Rule } from "../types.js";

export const BUILTIN_RULES: Rule[] = [
  // ── API Keys / Secrets / Tokens ──────────────────────────────────────────
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "OpenAI API Key",
    pattern: /sk-[A-Za-z0-9]{20,60}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,80}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Google API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "AWS Access Key ID",
    pattern: /(?<![A-Z0-9])[A-Z0-9]{20}(?![A-Z0-9])/g,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "AWS Secret Access Key",
    pattern: /(?:aws.{0,10})?['\"]([A-Za-z0-9\/+]{40})['"]/gi,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub Personal Access Token",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub OAuth / App Token",
    pattern: /gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "Generic Bearer Token（長度 ≥ 32 的字串）",
    pattern: /bearer\s+[A-Za-z0-9\-_\.]{32,}/gi,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "Generic Secret / Password 賦值",
    pattern:
      /(?:password|passwd|secret|private_key|client_secret)\s*[:=]\s*['"]([^'"]{8,})['"]/gi,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "JWT Token",
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]+/g,
  },

  // ── PII ──────────────────────────────────────────────────────────────────
  {
    type: "PII_EMAIL",
    severity: "MEDIUM",
    description: "Email 地址",
    pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
  },
  {
    type: "PII_PHONE_TW",
    severity: "MEDIUM",
    description: "台灣手機號碼",
    pattern: /(?:(?:\+886)|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g,
  },
  {
    type: "PII_PHONE_INTL",
    severity: "LOW",
    description: "國際電話號碼",
    pattern: /\+[1-9]\d{6,14}\b/g,
  },
  {
    type: "PII_ID_TW",
    severity: "HIGH",
    description: "台灣身份證字號",
    pattern: /[A-Z][12]\d{8}/g,
  },

  // ── 資料庫連線字串 ────────────────────────────────────────────────────────
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "資料庫連線字串（含密碼）",
    pattern:
      /(?:mongodb|postgresql|postgres|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
  },
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "DB Connection String（ADO 格式）",
    pattern:
      /(?:Data Source|Server|Host)\s*=\s*[^;]+;\s*(?:Password|Pwd)\s*=\s*[^;]+/gi,
  },
];

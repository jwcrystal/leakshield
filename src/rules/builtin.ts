import type { Rule } from "../types.js";

export const BUILTIN_RULES: Rule[] = [
  // ── API Keys / Secrets / Tokens ──────────────────────────────────────────
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "OpenAI API Key",
    // 涵蓋舊格式 sk-xxx 與新格式 sk-proj-xxx / sk-svcacct-xxx（上限放寬至 120）
    pattern: /sk-[A-Za-z0-9\-_]{20,120}/g,
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
    // AWS key 固定以 AKIA / ASIA / ABIA / ACCA 開頭，後接 16 個大寫英數字
    pattern: /(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}/g,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "AWS Secret Access Key",
    // 須有 aws 關鍵字為前綴，避免誤報一般 Base64 / SHA-1 hash
    pattern: /aws.{0,20}['\"]?([A-Za-z0-9\/+]{40})['\"]?/gi,
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
    description: "GitHub Fine-Grained Personal Access Token",
    // 2022 年起新格式
    pattern: /github_pat_[A-Za-z0-9_]{82}/g,
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
    // 同時涵蓋有引號（YAML/JSON）與無引號（.env）寫法
    // (?!\$\{) 排除環境變數參照 ${VAR}；(?!\*) 排除遮罩值 ********
    pattern:
      /(?:password|passwd|secret|private_key|client_secret)\s*[:=]\s*(?:['"](?!\$\{)[^'"]{8,}['"]|(?!['"\$\*])\S{8,})/gi,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "JWT Token",
    // 移除最後一段 character class 中的 . 以減少誤匹配
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_+/=]+/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Stripe Live Secret Key",
    pattern: /sk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Stripe Live Publishable Key",
    pattern: /pk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "Slack Bot Token",
    pattern: /xoxb-[0-9A-Za-z\-]{40,}/g,
  },
  {
    type: "TOKEN",
    severity: "HIGH",
    description: "Slack User / App Token",
    pattern: /xoxp-[0-9A-Za-z\-]{40,}|xoxa-[0-9A-Za-z\-]{40,}/g,
  },
  {
    type: "API_KEY",
    severity: "HIGH",
    description: "Hugging Face API Token",
    pattern: /hf_[A-Za-z0-9]{34,}/g,
  },
  {
    type: "SECRET",
    severity: "HIGH",
    description: "PEM Private Key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
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
    // 加上 word boundary 避免擷取較長字串的片段
    pattern: /\b[A-Z][12]\d{8}\b/g,
  },

  // ── 資料庫連線字串 ────────────────────────────────────────────────────────
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "資料庫連線字串（含密碼）",
    pattern:
      /(?:mongodb(?:\+srv)?|postgresql|postgres|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
  },
  {
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "DB Connection String（ADO 格式）",
    // (?:[^;]+;)* 允許 Server 與 Password 之間存在任意數量的中間欄位
    pattern:
      /(?:Data Source|Server|Host)\s*=\s*[^;]+;(?:[^;]+;)*\s*(?:Password|Pwd)\s*=\s*[^;]+/gi,
  },
];

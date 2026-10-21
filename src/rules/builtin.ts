import type { Rule } from "../types.js";
import { containsAddressInRun, ipv4Windows, parseCidrList } from "../scanner/cidr.js";

/** Networks used when a rule is evaluated without a loaded config. */
const DEFAULT_PRIVATE_NETWORKS = parseCidrList(undefined);

/**
 * A dotted run of four or more octets.
 *
 * Four groups is an address. A longer run is matched whole on purpose: with
 * the old four-group pattern, `10.1.2.3.4` yielded `10.1.2.3` and the public
 * `1.2.3.4` inside it was never reported — which the masker then caught as
 * residual plaintext and turned into a refusal for the whole request.
 */
const IPV4_DOTTED_RUN = /\b[0-9]{1,3}(?:\.[0-9]{1,3}){3,}\b/g;
import { classifyTransportSpan } from "../scanner/remotes.js";

/** Luhn checksum（ISO/IEC 7812-1）；信用卡號形狀相符後必須通過才命中。 */
function luhnValid(raw: string): boolean {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN mod-97（ISO 13616）：前四碼移到尾端、字母轉數字後取模必須為 1。 */
function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const v = code >= 48 && code <= 57 ? code - 48 : code - 55; // 0-9 或 A=10…Z=35
    remainder = (remainder * (v < 10 ? 10 : 100) + v) % 97;
  }
  return remainder === 1;
}

/** 僅公共可路由 IPv4 視為敏感；私有／回環／鏈路本地／CGNAT／保留段不命中（config 常見值）。 */
function publicIPv4(raw: string): boolean {
  const octets = raw.split(".").map(Number);
  // A run longer than four octets is reported whole when any window is a
  // public address, so a suffix like the 1.2.3.4 in 10.1.2.3.4 is never left
  // unmasked.
  if (octets.length > 4) return ipv4Windows(raw).some((window) => publicIPv4(window));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast / reserved
  return true;
}

export const BUILTIN_RULES: Rule[] = [
  // ── API Keys / Secrets / Tokens ──────────────────────────────────────────
  {
    id: "openai-key",
    type: "API_KEY",
    severity: "HIGH",
    description: "OpenAI API Key",
    // 涵蓋舊格式 sk-xxx 與新格式 sk-proj-xxx / sk-svcacct-xxx（上限放寬至 120）
    pattern: /sk-[A-Za-z0-9\-_]{20,120}/g,
  },
  {
    id: "anthropic-key",
    type: "API_KEY",
    severity: "HIGH",
    description: "Anthropic API Key",
    pattern: /sk-ant-[A-Za-z0-9\-_]{20,80}/g,
  },
  {
    id: "google-key",
    type: "API_KEY",
    severity: "HIGH",
    description: "Google API Key",
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
  },
  {
    id: "aws-access-key",
    type: "API_KEY",
    severity: "HIGH",
    description: "AWS Access Key ID",
    // AWS key 固定以 AKIA / ASIA / ABIA / ACCA 開頭，後接 16 個大寫英數字
    // 加上 word boundary 避免命中嵌入較長字串中的片段（如 base64）
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "aws-secret",
    type: "SECRET",
    severity: "HIGH",
    description: "AWS Secret Access Key",
    // 改進規則：要求明確的 AWS secret 關鍵字前綴
    // 匹配格式：aws_secret_access_key, aws_secret_key, secretAccessKey, etc.
    // 避免誤報 Git commit hash 或一般 Base64 字串
    pattern: /(?:aws_secret_access_key|aws_secret_key|aws.?secret|secretAccessKey|aws.?access)\s*[:=]\s*['"]?([A-Za-z0-9\/+]{40})['"]?/gi,
  },
  {
    id: "github-pat",
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub Personal Access Token",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    id: "github-fine-grained-pat",
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub Fine-Grained Personal Access Token",
    // 2022 年起新格式
    pattern: /github_pat_[A-Za-z0-9_]{82}/g,
  },
  {
    id: "github-oauth-app",
    type: "TOKEN",
    severity: "HIGH",
    description: "GitHub OAuth / App Token",
    pattern: /gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}/g,
  },
  {
    id: "generic-bearer",
    type: "TOKEN",
    severity: "HIGH",
    description: "Generic Bearer Token（長度 ≥ 32 的字串）",
    pattern: /bearer\s+[A-Za-z0-9\-_\.]{32,}/gi,
  },
  {
    id: "generic-secret",
    type: "SECRET",
    severity: "HIGH",
    description: "Generic Secret / Password 賦值",
    // 同時涵蓋有引號（YAML/JSON）與無引號（.env）寫法
    // (?!\$\{) 排除環境變數參照 ${VAR}；(?!\*) 排除遮罩值 ********
    pattern:
      /(?:password|passwd|secret|private_key|client_secret)\s*[:=]\s*(?:['"](?!\$\{)[^'"]{8,}['"]|(?!['"\$\*])\S{8,})/gi,
  },
  {
    id: "url-userinfo",
    type: "SECRET",
    severity: "HIGH",
    description: "URL 內嵌憑證（user:password@）",
    // 取到 authority 內最後一個 `@` 為止的完整 userinfo：`https://u:pa@ss@host`
    // 若停在第一個 `@`，`ss` 會留在遮罩之外。前置 group 不吃 `:`，且以 `://`
    // 起頭（skipPrefix 只回報 userinfo），避免可變長度 lookbehind 在每個位置
    // 重掃造成二次方成長。
    pattern: /:\/\/[^\s/?#:]*:[^\s/?#]*@/gi,
    skipPrefix: 3,
  },
  {
    id: "jwt",
    type: "TOKEN",
    severity: "HIGH",
    description: "JWT Token",
    // 移除最後一段 character class 中的 . 以減少誤匹配
    pattern: /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_+/=]+/g,
  },
  {
    id: "stripe-live-secret",
    type: "API_KEY",
    severity: "HIGH",
    description: "Stripe Live Secret Key",
    pattern: /sk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    id: "stripe-live-publishable",
    type: "API_KEY",
    severity: "HIGH",
    description: "Stripe Live Publishable Key",
    pattern: /pk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    id: "slack-bot",
    type: "TOKEN",
    severity: "HIGH",
    description: "Slack Bot Token",
    pattern: /xoxb-[0-9A-Za-z\-]{40,}/g,
  },
  {
    id: "slack-user-app",
    type: "TOKEN",
    severity: "HIGH",
    description: "Slack User / App Token",
    pattern: /xoxp-[0-9A-Za-z\-]{40,}|xoxa-[0-9A-Za-z\-]{40,}/g,
  },
  {
    id: "huggingface-token",
    type: "API_KEY",
    severity: "HIGH",
    description: "Hugging Face API Token",
    pattern: /hf_[A-Za-z0-9]{34,}/g,
  },
  {
    id: "pem-private-key",
    type: "SECRET",
    severity: "HIGH",
    description: "PEM Private Key",
    // Full PEM block first (header + body + END) so the base64 body cannot
    // survive a redaction/pseudonymization that only renamed the header; a
    // truncated block (no END line) falls back to the header-only match.
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  },

  // ── PII ──────────────────────────────────────────────────────────────────
  {
    id: "email",
    type: "PII_EMAIL",
    severity: "MEDIUM",
    description: "Email 地址",
    // The local part is capped at 64 octets, the RFC 5321 limit. Unbounded
    // `+` made the rule quadratic on a long token with no `@`: every start
    // position consumed the rest of the run before failing.
    pattern: /[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    // `user@host:path` and `ssh://user@host/…` are Git transports, not
    // mailboxes (#34). The password half of `scheme://user:password@host` is
    // a credential, reported by `url-userinfo` instead. Only this rule skips
    // those spans; private domains, path keywords and URL credentials keep
    // their own findings.
    validate: (match, context) =>
      classifyTransportSpan(context.text, context.index, match.length) === null,
  },
  {
    id: "phone-tw",
    type: "PII_PHONE_TW",
    severity: "MEDIUM",
    description: "台灣手機號碼",
    // Opt-in（P2, 2026-10-06 owner 拍板；2026-10-07 實作）：數字段對 SGP1
    // token 類字串的誤報是量測到的主要 FP 源（0.294%）。要開啟：
    // settings.rule_overrides["phone-tw"]: true。漏真電話風險見 README。
    optIn: true,
    pattern: /(?:(?:\+886)|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g,
  },
  {
    id: "phone-intl",
    type: "PII_PHONE_INTL",
    severity: "LOW",
    description: "國際電話號碼",
    // Opt-in，同 phone-tw（P2）。要開啟：settings.rule_overrides["phone-intl"]: true
    optIn: true,
    pattern: /\+[1-9]\d{6,14}\b/g,
  },
  {
    id: "id-tw",
    type: "PII_ID_TW",
    severity: "HIGH",
    description: "台灣身份證字號",
    // 加上 word boundary 避免擷取較長字串的片段
    pattern: /\b[A-Z][12]\d{8}\b/g,
  },

  // ── 資料庫連線字串 ────────────────────────────────────────────────────────
  {
    id: "db-connection",
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "資料庫連線字串（含密碼）",
    pattern:
      /(?:mongodb(?:\+srv)?|postgresql|postgres|mysql|redis|mssql):\/\/[^:\s]+:[^@\s]+@[^\s"']+/gi,
  },
  {
    id: "db-connection-ado",
    type: "DB_CONNECTION",
    severity: "HIGH",
    description: "DB Connection String（ADO 格式）",
    // (?:[^;]+;)* 允許 Server 與 Password 之間存在任意數量的中間欄位
    pattern:
      /(?:Data Source|Server|Host)\s*=\s*[^;]+;(?:[^;]+;)*\s*(?:Password|Pwd)\s*=\s*[^;]+/gi,
  },

  // ── 金融／網路 PII（regex 框形狀，validate 再驗校驗碼／可路由性）────────
  {
    id: "credit-card",
    type: "PII_CREDIT_CARD",
    severity: "HIGH",
    description: "信用卡號（Luhn 驗證）",
    // 13–19 位數字，允許空格或連字號分隔；Luhn 不過由 validate 排除
    pattern: /\b(?:[0-9][ -]?){12,18}[0-9]\b/g,
    validate: luhnValid,
  },
  {
    id: "iban",
    type: "PII_IBAN",
    severity: "HIGH",
    description: "IBAN 國際銀行帳號（mod-97 驗證）",
    // 緊湊或四字一空格兩種形狀（檢查碼後可有一空格）；mod-97 不過由 validate 排除
    pattern: /\b[A-Z]{2}[0-9]{2} ?(?:[A-Z0-9]{11,30}|(?:[A-Z0-9]{4} ){2,7}[A-Z0-9]{1,4})\b/g,
    validate: ibanValid,
  },
  {
    id: "public-ipv4",
    type: "PII_IP",
    severity: "MEDIUM",
    description: "公共 IPv4 位址",
    // 私有／回環／CGNAT／保留段由 validate 排除，避免 config 常數誤報
    pattern: IPV4_DOTTED_RUN,
    validate: publicIPv4,
  },
  {
    id: "private-ipv4",
    type: "PII_IP",
    severity: "MEDIUM",
    description: "私有 IPv4 位址",
    // Opt-in：內網拓撲通常敏感，但位址字面值對版本號、時間戳的誤報也高。
    // 要開啟：settings.rule_overrides["private-ipv4"]: true。預設涵蓋
    // RFC 1918、CGNAT 與 link-local；settings.private_cidrs 可縮小範圍。
    optIn: true,
    pattern: IPV4_DOTTED_RUN,
    // getRules 會以 settings.private_cidrs 換掉這個 validator。
    validate: (match) => containsAddressInRun(DEFAULT_PRIVATE_NETWORKS, match),
  },
  {
    id: "url",
    type: "PII_URL",
    severity: "LOW",
    description: "HTTP(S) URL",
    // Opt-in：always-on 會把 wire 請求的 endpoint 當 PII 導致 fail-closed 拒絕
    // （tests/opencode-transparent.test.ts 曾回歸）。要開啟：settings.rule_overrides.url: true
    // 結尾不吃句讀（.,;:!?），避免把句子標點吞進遮罩範圍
    optIn: true,
    pattern: /\bhttps?:\/\/[^\s<>"'`\\)\]]*[^\s<>"'`\\)\][.,;:!?]/g,
  },
];

/** 所有 builtin 規則的 stable id（供 config rule_overrides 驗證；tests 保證每條規則都有 id）。 */
export const BUILTIN_RULE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_RULES.map((rule) => rule.id).filter((id): id is string => id !== undefined),
);

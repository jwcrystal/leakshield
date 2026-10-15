import type { GuardConfig, Rule } from "../types.js";

// ReDoS protection: test the compiled regex against a fixed input with a
// synchronous timeout. Node.js is single-threaded so we approximate a timeout
// by measuring wall-clock time after exec() returns. Patterns that complete
// under REDOS_TIMEOUT_MS are accepted; those that hang are caught by the
// outer try/catch if they throw, or rejected if they exceed the limit.
const REDOS_TIMEOUT_MS = 200;
const REDOS_TEST_INPUT = "a".repeat(50) + "!";

function isSafePattern(pattern: string): boolean {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "gi");
  } catch {
    return false; // invalid regex syntax
  }
  const start = Date.now();
  try {
    compiled.exec(REDOS_TEST_INPUT);
  } catch {
    return false;
  }
  return Date.now() - start < REDOS_TIMEOUT_MS;
}

export function buildDynamicRules(config: GuardConfig): Rule[] {
  const rules: Rule[] = [];

  // Word boundaries make keyword rules match the standalone WORD, not words
  // that merely contain it ("Foundation" must not trip「NDA」, "confidentiality"
  // must not trip「CONFIDENTIAL」). Boundaries are added only where the
  // keyword's edge is an ASCII word character: `\b` never holds between two
  // non-word characters, so CJK keywords (「機密」inside Chinese text) would
  // silently stop matching if we wrapped them unconditionally.
  const keywordPattern = (keyword: string): RegExp => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lead = /^[A-Za-z0-9_]/.test(keyword) ? "\\b" : "";
    const trail = /[A-Za-z0-9_]$/.test(keyword) ? "\\b" : "";
    return new RegExp(lead + escaped + trail, "gi");
  };

  for (const kw of config.nda_keywords) {
    rules.push({
      type: "NDA_KEYWORD",
      severity: "HIGH",
      description: `NDA 關鍵字「${kw}」`,
      pattern: keywordPattern(kw),
    });
  }

  for (const domain of config.private_domains) {
    rules.push({
      type: "PRIVATE_DOMAIN",
      severity: "MEDIUM",
      description: `私有域名「${domain}」`,
      pattern: new RegExp(domain.replace(/\./g, "\\."), "gi"),
    });
  }

  for (const rule of config.custom_rules) {
    if (!isSafePattern(rule.pattern)) {
      console.warn(`[sensitive-guard] custom_rules: 略過不安全或無效的 pattern —「${rule.description}」`);
      continue;
    }
    rules.push({
      type: "CUSTOM",
      severity: rule.severity,
      description: rule.description,
      pattern: new RegExp(rule.pattern, "gi"),
    });
  }

  return rules;
}

import type { GuardConfig, Rule } from "../types.js";

// ReDoS heuristic: run the compiled regex once against a fixed input and
// measure wall-clock time after exec() returns. This is a heuristic, not a
// guarantee: Node.js is single-threaded, so exec() cannot be interrupted, and
// a pattern that backtracks catastrophically on this input blocks until it
// finishes. Patterns that return under REDOS_TIMEOUT_MS are accepted; slower
// ones are skipped and reported by `--doctor`. Patterns that do not compile
// never get here: `loadConfig()` rejects them (fail-closed).
const REDOS_TIMEOUT_MS = 200;
const REDOS_TEST_INPUT = "a".repeat(50) + "!";

export type CustomPatternVerdict = "ok" | "invalid" | "redos-suspect";

// The timing check can land on either side of the limit from one run to the
// next, so the first verdict for a pattern is kept for the life of the
// process: `--doctor` and the scanner it smoke-tests then agree on which
// rules are enforced. Bounded so a long-lived process cannot grow it forever.
const MAX_REMEMBERED_VERDICTS = 1024;
const verdicts = new Map<string, CustomPatternVerdict>();

export function checkCustomPattern(pattern: string): CustomPatternVerdict {
  const remembered = verdicts.get(pattern);
  if (remembered !== undefined) return remembered;
  const verdict = probeCustomPattern(pattern);
  if (verdicts.size >= MAX_REMEMBERED_VERDICTS) verdicts.clear();
  verdicts.set(pattern, verdict);
  return verdict;
}

function probeCustomPattern(pattern: string): CustomPatternVerdict {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, "gi");
  } catch {
    return "invalid";
  }
  const start = Date.now();
  try {
    compiled.exec(REDOS_TEST_INPUT);
  } catch {
    return "redos-suspect";
  }
  return Date.now() - start < REDOS_TIMEOUT_MS ? "ok" : "redos-suspect";
}

/** Descriptions of the custom rules `buildDynamicRules` skips, in config order. */
export function skippedCustomRules(config: GuardConfig): { description: string; reason: Exclude<CustomPatternVerdict, "ok"> }[] {
  const skipped: { description: string; reason: Exclude<CustomPatternVerdict, "ok"> }[] = [];
  for (const rule of config.custom_rules ?? []) {
    const verdict = checkCustomPattern(rule.pattern);
    if (verdict !== "ok") skipped.push({ description: rule.description, reason: verdict });
  }
  return skipped;
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
    const verdict = checkCustomPattern(rule.pattern);
    if (verdict !== "ok") {
      console.warn(
        verdict === "invalid"
          ? `[leakshield] custom_rules: 略過無法編譯的 pattern —「${rule.description}」`
          : `[leakshield] custom_rules: 略過疑似 ReDoS 的 pattern（計時啟發式檢查，非保證）—「${rule.description}」`,
      );
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

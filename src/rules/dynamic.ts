import type { CustomRuleConfig, GuardConfig, Rule } from "../types.js";

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

/**
 * Is this pattern's top level an alternation (`a|b`, not `(?:a|b)`)? Boundaries
 * cannot be attached safely to each branch from outside, and `\bfoo|bar\b`
 * would silently mean something else, so `word_boundary` refuses it.
 */
function hasTopLevelAlternation(source: string): boolean {
  let depth = 0;
  let escaped = false;
  let inClass = false;
  for (const ch of source) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "|" && depth === 0) return true;
  }
  return false;
}

/** The ASCII-word test `keywordPattern` uses for its boundaries. */
function asciiWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9_]$/.test(ch);
}

/** Characters that hide the real edge (group, class, quantifier, escape). No
 * boundary can be placed there safely, so none is added and `--doctor` says so. */
const HIDDEN_EDGE = new Set(["(", ")", "[", "]", "{", "}", ".", "*", "+", "?", "|", "\\"]);

/** End index (exclusive) of the escape sequence starting at `start`. */
function escapeEnd(source: string, start: number): number {
  const next = source[start + 1];
  if (next === undefined) return start + 1;
  if (next === "x") return Math.min(source.length, start + 4);
  if (next === "u" || next === "p" || next === "P" || next === "k") {
    if (source[start + 2] === "{" || source[start + 2] === "<") {
      const close = source.indexOf(source[start + 2] === "{" ? "}" : ">", start + 3);
      return close === -1 ? source.length : close + 1;
    }
    return next === "u" ? Math.min(source.length, start + 6) : start + 2;
  }
  if (/[1-9]/.test(next)) {
    let index = start + 1;
    while (index < source.length && /[0-9]/.test(source[index] ?? "")) index += 1;
    return index;
  }
  return Math.min(source.length, start + 2);
}

/** End index (exclusive) of a character class starting at `start`. */
function classEnd(source: string, start: number): number {
  let index = start + 1;
  if (source[index] === "^") index += 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      index = Math.max(escapeEnd(source, index), index + 1);
      continue;
    }
    if (ch === "]") return index + 1;
    index += 1;
  }
  return source.length;
}

/** First token of the pattern: one escape, one class, or one character. */
function firstToken(source: string): string {
  const ch = source[0];
  if (ch === undefined) return "";
  if (ch === "\\") return source.slice(0, escapeEnd(source, 0));
  if (ch === "[") return source.slice(0, classEnd(source, 0));
  return ch;
}

/** Last token of the pattern, walking past escapes and classes. */
function lastToken(source: string): string {
  let index = 0;
  let start = 0;
  while (index < source.length) {
    start = index;
    const ch = source[index];
    if (ch === "\\") {
      index = Math.max(escapeEnd(source, index), index + 1);
      continue;
    }
    if (ch === "[") {
      index = Math.max(classEnd(source, index), index + 1);
      continue;
    }
    index += 1;
  }
  return source.slice(start);
}

type EdgeClass = "word" | "satisfied" | "hidden" | "none";

/**
 * What a boundary can do at this edge. Only a literal ASCII word character can
 * take a `\b`. An escape is never assumed to end in a word character: `\D`,
 * `\x21` or `\u5bc6` all end in something else, and appending `\b` would drop
 * real matches (including the CJK case the acceptance criteria call out).
 */
function classifyEdge(token: string): EdgeClass {
  if (token === "") return "none";
  if (token === "\\b" || token === "^" || token === "$") return "satisfied";
  if (token.startsWith("\\") || token.startsWith("[")) return "hidden";
  if (token.length === 1) {
    if (asciiWordChar(token)) return "word";
    if (HIDDEN_EDGE.has(token)) return "hidden";
    return "none";
  }
  return "hidden";
}

const EDGE_CLASS: Record<EdgeClass, "added" | "hidden" | "none"> = {
  word: "added",
  satisfied: "none",
  hidden: "hidden",
  none: "none",
};

/**
 * Which edges of a rule can actually take a boundary. `word_boundary` can only
 * add `\b` where the edge is a literal ASCII word character; an edge that is a
 * group, class, quantifier or escape is reported as hidden rather than guessed
 * at, and `--doctor` warns so the rule does not look stricter than it is.
 */
export function customRuleBoundaries(rule: Pick<CustomRuleConfig, "pattern" | "word_boundary">): {
  lead: "added" | "hidden" | "none";
  trail: "added" | "hidden" | "none";
} {
  if (rule.word_boundary !== true) return { lead: "none", trail: "none" };
  return {
    lead: EDGE_CLASS[classifyEdge(firstToken(rule.pattern))],
    trail: EDGE_CLASS[classifyEdge(lastToken(rule.pattern))],
  };
}

/**
 * Pattern source with `word_boundary` applied. A `\b` is added only where the
 * edge is a literal ASCII word character; an already-written `\b`/`^`/`$` is
 * respected. A top-level alternation is refused because `\bfoo|bar\b` would
 * silently mean `(\bfoo)|(bar\b)`; group it as `(?:foo|bar)`.
 */
export function customRuleSource(rule: Pick<CustomRuleConfig, "pattern" | "word_boundary" | "description">): string {
  if (rule.word_boundary !== true) return rule.pattern;
  if (hasTopLevelAlternation(rule.pattern)) {
    throw new Error(
      `custom rule "${rule.description}": word_boundary cannot be applied to a top-level alternation; group it as (?:${rule.pattern})`,
    );
  }
  const lead = classifyEdge(firstToken(rule.pattern)) === "word" ? "\\b" : "";
  const trail = classifyEdge(lastToken(rule.pattern)) === "word" ? "\\b" : "";
  return lead + rule.pattern + trail;
}

/** Final flags: `g` is always present; `i` stays the default so existing rules
 * keep matching as they did before `flags` existed. */
export function customRuleFlags(rule: Pick<CustomRuleConfig, "flags">): string {
  const requested = rule.flags ?? "i";
  return Array.from(new Set(`g${requested}`)).join("");
}

/** The exact RegExp the scanner uses for a custom rule. */
export function customRulePattern(rule: CustomRuleConfig): RegExp {
  return new RegExp(customRuleSource(rule), customRuleFlags(rule));
}

// The timing check can land on either side of the limit from one run to the
// next, so the first verdict for a pattern is kept for the life of the
// process: `--doctor` and the scanner it smoke-tests then agree on which
// rules are enforced. Bounded so a long-lived process cannot grow it forever.
const MAX_REMEMBERED_VERDICTS = 1024;
const verdicts = new Map<string, CustomPatternVerdict>();

export function checkCustomPattern(pattern: string, flags = "gi"): CustomPatternVerdict {
  const key = `${flags}\u0000${pattern}`;
  const remembered = verdicts.get(key);
  if (remembered !== undefined) return remembered;
  const verdict = probeCustomPattern(pattern, flags);
  if (verdicts.size >= MAX_REMEMBERED_VERDICTS) verdicts.clear();
  verdicts.set(key, verdict);
  return verdict;
}

/** Probe the rule's final pattern (flags and boundaries included). */
export function checkCustomRule(rule: CustomRuleConfig): CustomPatternVerdict {
  let compiled: RegExp;
  try {
    compiled = customRulePattern(rule);
  } catch {
    return "invalid";
  }
  return checkCustomPattern(compiled.source, compiled.flags);
}

function probeCustomPattern(pattern: string, flags: string): CustomPatternVerdict {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, flags);
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
    const verdict = checkCustomRule(rule);
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
    const verdict = checkCustomRule(rule);
    if (verdict !== "ok") {
      console.warn(
        verdict === "invalid"
          ? `[leakshield] custom_rules: 略過無法編譯的 pattern —「${rule.description}」`
          : `[leakshield] custom_rules: 略過疑似 ReDoS 的 pattern（計時啟發式檢查，非保證）—「${rule.description}」`,
      );
      continue;
    }
    const allow = (rule.allow ?? []).filter((value) => value.length > 0);
    rules.push({
      type: "CUSTOM",
      severity: rule.severity,
      description: rule.description,
      pattern: customRulePattern(rule),
      ...(allow.length > 0 ? { allow: new Set(allow) } : {}),
    });
  }

  return rules;
}

/**
 * Encoding detection and decoding utilities
 * Prevents attackers from bypassing detection using Base64, URL encoding, etc.
 */

import type { Finding, GuardConfig, ScanResult } from "../types.js";
import { ZERO_WIDTH_CHARS, scanTextInternal, type ScanOptions } from "./engine.js";
import { foldConfusables } from "./unicode.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DecodingResult {
  decoded: string;
  encoding_type: string;
  confidence: number; // 0-1
}

/** A detected candidate and where it starts in the text it was detected in. */
interface EncodedCandidate {
  text: string;
  index: number;
}

// ─── Base64 Detection & Decoding ─────────────────────────────────────────────────

/**
 * Detects potential Base64 encoded strings.
 * Looks for:
 * - Length >= 32 characters
 * - Only contains Base64 alphabet (A-Za-z0-9+/=)
 * - Proper padding (0-2 '=' chars at end)
 * - Even length when padded
 */
function detectBase64Matches(text: string): EncodedCandidate[] {
  const candidates: EncodedCandidate[] = [];

  // Pattern for Base64 strings (16+ chars, lowered threshold for security)
  const base64Pattern = /[A-Za-z0-9+/]{16,}={0,2}/g;
  const matches = text.matchAll(base64Pattern);

  for (const match of matches) {
    const candidate = match[0];

    // Skip if it's clearly not Base64
    if (candidate.length % 4 !== 0 && !candidate.endsWith('=')) {
      continue;
    }

    // Check padding validity
    const padCount = (candidate.match(/=/g) || []).length;
    if (padCount > 2) continue;

    // Check if it's likely Base64 (has reasonable entropy)
    const uniqueChars = new Set(candidate).size;
    const entropy = uniqueChars / candidate.length;

    // Low entropy suggests it's not Base64 (e.g., "AAAAAAAAAA...")
    if (entropy < 0.3) continue;

    candidates.push({ text: candidate, index: match.index });
  }

  return candidates;
}

function detectBase64(text: string): string[] {
  return detectBase64Matches(text).map((c) => c.text);
}

/**
 * Attempts to decode a Base64 string and validate the result.
 * Returns null if decoding fails or result doesn't look like text.
 */
function tryDecodeBase64(encoded: string): DecodingResult | null {
  try {
    // Add padding if missing
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');

    const decoded = Buffer.from(padded, 'base64').toString('utf-8');

    // Validate the decoded result
    if (decoded.length < 10) return null; // Too short

    // Check if it looks like text (contains letters)
    if (!/[a-zA-Z]{2,}/.test(decoded)) return null;

    // Check for common sensitive patterns in decoded text
    const hasSensitivePattern = /(?:api|key|secret|token|password|sk-|ghp_|gho_)/i.test(decoded);

    return {
      decoded,
      encoding_type: 'Base64',
      confidence: hasSensitivePattern ? 0.9 : 0.6,
    };
  } catch {
    return null;
  }
}

// ─── URL Encoding Detection & Decoding ───────────────────────────────────────────

/**
 * Detects potential URL-encoded strings.
 * Looks for percent-encoded characters like %20, %2F, etc.
 */
function detectUrlEncoding(text: string): string[] {
  const candidates: string[] = [];

  // Look for strings with percent-encoded characters (lowered threshold)
  const urlEncodedPattern = /(?:%[0-9A-Fa-f]{2}){1,}/g;
  const matches = text.matchAll(urlEncodedPattern);

  for (const match of matches) {
    const candidate = match[0];

    // Extract a larger context (up to 200 chars around the encoded part)
    const start = Math.max(0, match.index - 50);
    const end = Math.min(text.length, match.index + candidate.length + 50);
    const context = text.slice(start, end);

    candidates.push(context);
  }

  return candidates;
}

/**
 * Attempts to decode URL-encoded text.
 */
function tryDecodeUrl(encoded: string): DecodingResult | null {
  try {
    const decoded = decodeURIComponent(encoded.replace(/\+/g, ' '));

    if (decoded === encoded) return null; // Nothing was decoded

    const hasSensitivePattern = /(?:api|key|secret|token|password|sk-|ghp_|gho_)/i.test(decoded);

    return {
      decoded,
      encoding_type: 'URL',
      confidence: hasSensitivePattern ? 0.85 : 0.5,
    };
  } catch {
    return null;
  }
}

// ─── Hex Encoding Detection ──────────────────────────────────────────────────────

/**
 * Detects potential hex-encoded strings.
 */
function detectHexMatches(text: string): EncodedCandidate[] {
  const candidates: EncodedCandidate[] = [];

  // Look for sequences of hex pairs
  const hexPattern = /(?:\\x[0-9a-fA-F]{2}|[0-9a-fA-F]{32,})/g;
  const matches = text.matchAll(hexPattern);

  for (const match of matches) {
    candidates.push({ text: match[0], index: match.index });
  }

  return candidates;
}

function detectHexEncoding(text: string): string[] {
  return detectHexMatches(text).map((c) => c.text);
}

/**
 * Attempts to decode hex-encoded text.
 */
function tryDecodeHex(encoded: string): DecodingResult | null {
  try {
    let decoded = encoded;

    // Handle \xHH format
    if (decoded.includes('\\x')) {
      decoded = decoded.replace(/\\x([0-9a-fA-F]{2})/g, (_, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      );
    } else {
      // Handle raw hex format
      if (decoded.length % 2 !== 0) return null;
      decoded = Buffer.from(decoded, 'hex').toString('utf-8');
    }

    if (decoded.length < 10) return null;

    const hasSensitivePattern = /(?:api|key|secret|token|password|sk-|ghp_|gho_)/i.test(decoded);

    return {
      decoded,
      encoding_type: 'Hex',
      confidence: hasSensitivePattern ? 0.8 : 0.5,
    };
  } catch {
    return null;
  }
}

// ─── Main Scanning with Decoding ───────────────────────────────────────────────────

export interface ScanWithDecodingResult {
  original: ScanResult;
  decoded: ScanResult[];
  was_decoded: boolean;
  encoding_types_found: string[];
  safe: boolean;
  total_findings: number;
  findings: import("../types.js").Finding[];
}

/**
 * Scans text with automatic decoding of common encodings.
 * This prevents attackers from bypassing detection using Base64, URL encoding, etc.
 */
export function scanTextWithDecoding(text: string, config: GuardConfig, opts?: ScanOptions): ScanWithDecodingResult {
  const results: ScanResult[] = [];
  const encodingTypesFound = new Set<string>();

  // 1. Scan the original text
  const originalResult = scanTextInternal(text, config, opts);
  results.push(originalResult);

  // A zero-width character inside an encoded run breaks candidate detection
  // (a ZWSP in Base64 or hex), so decode the stripped form as well. Each
  // candidate is decoded once even when both forms contain it.
  const stripped = text.replace(ZERO_WIDTH_CHARS, "");
  // A Cyrillic/Greek look-alike swapped into an encoded run hides it the same
  // way, so decode the folded form too (#46). Decoding never recurses.
  const folded = foldConfusables(stripped);
  const sources = [...new Set([text, stripped, folded])];
  const decodedCandidates = new Set<string>();
  const firstSighting = (kind: string, candidate: string): boolean => {
    const id = `${kind}\0${candidate}`;
    if (decodedCandidates.has(id)) return false;
    decodedCandidates.add(id);
    return true;
  };

  for (const source of sources) {
    // 2. Try Base64 decoding
    const base64Candidates = detectBase64(source);
    for (const candidate of base64Candidates) {
      if (!firstSighting("base64", candidate)) continue;
      const decoded = tryDecodeBase64(candidate);
      if (decoded && decoded.confidence >= 0.6) {
        const decodedResult = scanTextInternal(decoded.decoded, config, opts);
        if (!decodedResult.safe) {
          results.push(decodedResult);
          encodingTypesFound.add('Base64');

          // Add metadata about the encoding
          decodedResult.findings.forEach(f => {
            (f as any).encoding_detected = {
              type: 'Base64',
              confidence: decoded.confidence,
              encoded_length: candidate.length,
              decoded_length: decoded.decoded.length,
            };
          });
        }
      }
    }

    // 3. Try URL decoding
    const urlCandidates = detectUrlEncoding(source);
    for (const candidate of urlCandidates) {
      if (!firstSighting("url", candidate)) continue;
      const decoded = tryDecodeUrl(candidate);
      if (decoded && decoded.confidence >= 0.5) {
        const decodedResult = scanTextInternal(decoded.decoded, config, opts);
        if (!decodedResult.safe) {
          results.push(decodedResult);
          encodingTypesFound.add('URL');

          decodedResult.findings.forEach(f => {
            (f as any).encoding_detected = {
              type: 'URL',
              confidence: decoded.confidence,
            };
          });
        }
      }
    }

    // 4. Try Hex decoding
    const hexCandidates = detectHexEncoding(source);
    for (const candidate of hexCandidates) {
      if (!firstSighting("hex", candidate)) continue;
      const decoded = tryDecodeHex(candidate);
      if (decoded && decoded.confidence >= 0.5) {
        const decodedResult = scanTextInternal(decoded.decoded, config, opts);
        if (!decodedResult.safe) {
          results.push(decodedResult);
          encodingTypesFound.add('Hex');

          decodedResult.findings.forEach(f => {
            (f as any).encoding_detected = {
              type: 'Hex',
              confidence: decoded.confidence,
            };
          });
        }
      }
    }
  }

  // Merge results
  const encodingTypesFoundArray = Array.from(encodingTypesFound);
  const mergedResult = mergeScanResults(results, config, encodingTypesFoundArray);

  return {
    original: originalResult,
    decoded: results.slice(1), // Exclude original
    was_decoded: encodingTypesFound.size > 0,
    encoding_types_found: Array.from(encodingTypesFound),
    ...mergedResult,
  };
}

/**
 * Merges multiple scan results into a single result.
 * Deduplicates findings by position and type.
 */
function mergeScanResults(
  results: ScanResult[],
  config: GuardConfig,
  encodingTypesFound: string[]
): Omit<ScanResult, 'summary' | 'recommendation'> {
  const allFindings = results.flatMap(r => r.findings);

  // Deduplicate by type and position
  const seen = new Set<string>();
  const deduplicated: typeof allFindings = [];

  for (const finding of allFindings) {
    const key = `${finding.type}:${finding.match_start}:${finding.match_end}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(finding);
    }
  }

  const safe = deduplicated.length === 0;
  const highCount = deduplicated.filter(f => f.severity === "HIGH").length;
  const medCount = deduplicated.filter(f => f.severity === "MEDIUM").length;
  const lowCount = deduplicated.length - highCount - medCount;

  const hasEncodedFindings = encodingTypesFound.length > 0;

  return {
    safe,
    total_findings: deduplicated.length,
    findings: deduplicated,
  };
}

// ─── Source-span location of encoded runs ───────────────────────────────────────

/** Half-open UTF-16 source span of an encoded run whose decoded form has a finding. */
export interface EncodedRun {
  start: number;
  end: number;
  severity: Finding["severity"];
  /** match_text of the decoded findings behind this run. */
  decodedMatches: string[];
}

/**
 * True when masking the runs located in `text` accounts for EVERY decoded
 * finding in `decodedMatches` (the match_text values the whole-segment
 * decoding scan reported). Three checks:
 * - Normalization: any zero-width or look-alike character in `text` returns
 *   false, wherever it sits. The generic decoder also decodes the stripped and
 *   folded sources, whose runs the locator cannot map back, so partial
 *   masking of the raw source could erase the evidence that a hidden part
 *   remains.
 * - Evasion: a located decoded form that reports a Unicode evasion returns
 *   false. The same character can be percent-encoded, which the normalization
 *   check cannot see, and the finding it hides has no source span.
 * - Coverage: each decoded match must equal, or be a substring of, a decoded
 *   match of a located run or a direct match (substring because the generic
 *   decoder's +/-50 windows can clip a value the locator sees in full). Direct
 *   matches count because those windows also re-report plain findings near any
 *   percent run, and the direct findings are masked anyway.
 */
export function decodedFindingsAttributable(
  text: string,
  config: GuardConfig,
  opts: ScanOptions | undefined,
  decodedMatches: readonly string[],
  directMatches: readonly string[],
): boolean {
  if (foldConfusables(text.replace(ZERO_WIDTH_CHARS, "")) !== text) return false;
  const { runs, evasion } = locateEncoded(text, config, opts);
  if (evasion) return false;
  const located = new Set<string>(directMatches);
  for (const run of runs) {
    for (const match of run.decodedMatches) located.add(match);
  }
  for (const wanted of new Set(decodedMatches)) {
    if (located.has(wanted)) continue;
    let covered = false;
    for (const match of located) {
      if (match.includes(wanted)) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
  }
  return true;
}

const SEVERITY_ORDER: Record<Finding["severity"], number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function highestSeverity(findings: readonly Finding[]): Finding["severity"] {
  let best: Finding["severity"] = "LOW";
  for (const finding of findings) {
    if (SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[best]) best = finding.severity;
  }
  return best;
}

const PERCENT_RUNS = /(?:%[0-9A-Fa-f]{2})+/g;

/**
 * Locates the encoded runs of `text` whose decoded form holds a finding, as
 * exact spans of `text` itself. This is the ONLY place decoded offsets are
 * mapped back to the source, and it works on `text` alone: the zero-width
 * stripped and confusable-folded sources that scanTextWithDecoding also
 * decodes have offsets that do not map back, so runs hidden that way are not
 * located (the caller's strict rescan keeps refusing them).
 *
 * - Base64 and hex: the span is the whole candidate match, decoded with the
 *   same functions and confidence thresholds as scanTextWithDecoding.
 * - URL: the generic decoder's +/-50 window is NOT used, because a clipped
 *   window would mask part of a value and leak the rest. The text is split
 *   into percent runs and literal pieces and decoded into one string with a
 *   decoded-unit to source-range map: literal units map one to one, every
 *   unit of a decoded run maps to the WHOLE run. A finding becomes a span
 *   only if it covers a decoded-run unit or a "+" turned into a space (the
 *   direct scan already handles the rest) and its offsets are exact.
 */
export function locateEncodedRuns(text: string, config: GuardConfig, opts?: ScanOptions): EncodedRun[] {
  return locateEncoded(text, config, opts).runs;
}

function hasUnicodeEvasion(findings: readonly Finding[]): boolean {
  return findings.some((f) => (f as { unicode_detected?: unknown }).unicode_detected !== undefined);
}

function locateEncoded(text: string, config: GuardConfig, opts?: ScanOptions): { runs: EncodedRun[]; evasion: boolean } {
  const runs: EncodedRun[] = [];
  let evasion = false;

  const locate = (candidates: EncodedCandidate[], decode: (s: string) => DecodingResult | null, minConfidence: number): void => {
    for (const candidate of candidates) {
      const decoded = decode(candidate.text);
      if (!decoded || decoded.confidence < minConfidence) continue;
      const result = scanTextInternal(decoded.decoded, config, opts);
      if (!result.safe) {
        if (hasUnicodeEvasion(result.findings)) evasion = true;
        runs.push({
          start: candidate.index,
          end: candidate.index + candidate.text.length,
          severity: highestSeverity(result.findings),
          decodedMatches: result.findings.flatMap((f) => (typeof f.match_text === "string" ? [f.match_text] : [])),
        });
      }
    }
  };
  locate(detectBase64Matches(text), tryDecodeBase64, 0.6);
  locate(detectHexMatches(text), tryDecodeHex, 0.5);

  const locateUrl = (plusAsSpace: boolean): void => {
    const url = locateUrlRuns(text, config, plusAsSpace, opts);
    runs.push(...url.runs);
    if (url.evasion) evasion = true;
  };
  locateUrl(true);
  // "+" is ambiguous: as a space it splits "a+b%40example.com" and would leave
  // "a+" unmasked, so also locate with "+" kept literal. Callers merge overlaps.
  if (text.includes("+")) locateUrl(false);
  return { runs, evasion };
}

function locateUrlRuns(
  text: string,
  config: GuardConfig,
  plusAsSpace: boolean,
  opts?: ScanOptions,
): { runs: EncodedRun[]; evasion: boolean } {
  const pieces: string[] = [];
  // Per decoded UTF-16 unit: the source range it maps to, and whether it came
  // from a decoded run or a "+" (only those can hide a finding from the scan).
  const unitStart: number[] = [];
  const unitEnd: number[] = [];
  const unitHot: boolean[] = [];
  let anyHot = false;

  const addLiteral = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      const plus = plusAsSpace && text[i] === "+";
      pieces.push(plus ? " " : text[i]);
      unitStart.push(i);
      unitEnd.push(i + 1);
      unitHot.push(plus);
      if (plus) anyHot = true;
    }
  };

  let cursor = 0;
  for (const match of text.matchAll(PERCENT_RUNS)) {
    const start = match.index;
    const end = start + match[0].length;
    addLiteral(cursor, start);
    cursor = end;
    let decoded: string;
    try {
      decoded = decodeURIComponent(match[0]);
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
      addLiteral(start, end); // malformed run stays literal
      continue;
    }
    pieces.push(decoded);
    for (let i = 0; i < decoded.length; i += 1) {
      unitStart.push(start);
      unitEnd.push(end);
      unitHot.push(true);
    }
    anyHot = true;
  }
  addLiteral(cursor, text.length);
  if (!anyHot) return { runs: [], evasion: false };

  const decodedText = pieces.join("");
  const result = scanTextInternal(decodedText, config, opts);
  if (result.safe || result.was_truncated) return { runs: [], evasion: false };

  const runs: EncodedRun[] = [];
  for (const finding of result.findings) {
    const start = finding.match_start;
    const end = finding.match_end;
    const matched = finding.match_text;
    if (
      typeof start !== "number" || typeof end !== "number" || typeof matched !== "string" ||
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || start >= end || end > decodedText.length ||
      decodedText.slice(start, end) !== matched
    ) {
      continue; // synthetic or clipped finding: not attributable
    }
    let hot = false;
    for (let i = start; i < end && !hot; i += 1) hot = unitHot[i];
    if (!hot) continue;
    runs.push({ start: unitStart[start], end: unitEnd[end - 1], severity: finding.severity, decodedMatches: [matched] });
  }
  return { runs, evasion: hasUnicodeEvasion(result.findings) };
}

/**
 * Encoding detection and decoding utilities
 * Prevents attackers from bypassing detection using Base64, URL encoding, etc.
 */

import type { GuardConfig, ScanResult } from "../types.js";
import { ZERO_WIDTH_CHARS, scanTextInternal, type ScanOptions } from "./engine.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface DecodingResult {
  decoded: string;
  encoding_type: string;
  confidence: number; // 0-1
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
function detectBase64(text: string): string[] {
  const candidates: string[] = [];

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

    candidates.push(candidate);
  }

  return candidates;
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
function detectHexEncoding(text: string): string[] {
  const candidates: string[] = [];

  // Look for sequences of hex pairs
  const hexPattern = /(?:\\x[0-9a-fA-F]{2}|[0-9a-fA-F]{32,})/g;
  const matches = text.matchAll(hexPattern);

  for (const match of matches) {
    candidates.push(match[0]);
  }

  return candidates;
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
  const sources = stripped === text ? [text] : [text, stripped];
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

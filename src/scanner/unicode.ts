/**
 * Unicode security utilities
 * Prevents homograph attacks and zero-width character bypasses
 */

/**
 * Normalizes Unicode text to prevent homograph attacks.
 *
 * Uses NFC (Canonical Composition) to:
 * - Convert composed characters to canonical form
 * - Remove variation selectors
 * - Normalize different representations of the same character
 *
 * Example:
 * - "pa‌ssword" (with zero-width) → "password"
 * - "pᴀssword" (Cyrillic 'a') → "password" (detected as different)
 */
export function normalizeUnicode(text: string): {
  normalized: string;
  hadZeroWidth: boolean;
  hadVariants: boolean;
  removedChars: number;
} {
  let normalized = text;
  let hadZeroWidth = false;
  let hadVariants = false;
  let removedChars = 0;

  // Step 1: Remove zero-width characters
  // These are invisible and can be used to bypass detection
  const zeroWidthPattern = /[\u200B-\u200D\uFEFF\u2060\u180E]/g;
  const zeroWidthMatches = text.match(zeroWidthPattern);
  if (zeroWidthMatches) {
    hadZeroWidth = true;
    removedChars += zeroWidthMatches.length;
    normalized = normalized.replace(zeroWidthPattern, '');
  }

  // Step 2: Remove other invisible format characters
  // Soft hyphen, zero-width joiner/non-joiner, etc.
  const invisiblePattern = /[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFEFF]/g;
  const invisibleMatches = normalized.match(invisiblePattern);
  if (invisibleMatches) {
    removedChars += invisibleMatches.length;
    normalized = normalized.replace(invisiblePattern, '');
  }

  // Step 3: Normalize to NFC form
  // This combines characters where possible (e.g., "e" + "́" → "é")
  normalized = normalized.normalize('NFC');

  // Step 4: Remove variation selectors (used for emoji variants, but can be abused)
  const variationPattern = /[\uFE00-\uFE0F\uE0100-\uE01EF]/g;
  const variationMatches = normalized.match(variationPattern);
  if (variationMatches) {
    hadVariants = true;
    removedChars += variationMatches.length;
    normalized = normalized.replace(variationPattern, '');
  }

  return {
    normalized,
    hadZeroWidth,
    hadVariants,
    removedChars,
  };
}

/**
 * Detects if text contains suspicious Unicode patterns.
 * Returns details about what was found.
 * Only flags patterns that are likely used for bypassing detection.
 */
export function detectSuspiciousUnicode(text: string): {
  hasZeroWidth: boolean;
  hasVariationSelectors: boolean;
  hasMixedScripts: boolean;
  hasHomographs: boolean;
  details: string[];
} {
  const details: string[] = [];
  let hasZeroWidth = false;
  let hasVariationSelectors = false;
  let hasMixedScripts = false;
  let hasHomographs = false;

  // Web text can contain standalone ZWJ separators. Whitespace on both sides
  // means these joiners cannot splice a sensitive value. Exclude only those
  // separators from this heuristic; keep the original text and regular scans.
  // Embedded/adjacent joiners and every other zero-width character still flag.
  const zeroWidthProbe = text.replace(/(?<!\S)\u200D+(?!\S)/g, '');
  if (/[\u200B-\u200D\uFEFF]/.test(zeroWidthProbe)) {
    hasZeroWidth = true;
    details.push('包含零寬字符 (可被用於繞過檢測)');
  }

  // Check for variation selectors (usually not suspicious in isolation)
  if (/[\uFE00-\uFE0F\uE0100-\uE01EF]/.test(text)) {
    hasVariationSelectors = true;
    // Don't add details unless there are other suspicious patterns
  }

  // Check for mixed scripts (Latin + Cyrillic) only if suspicious keywords present
  const hasLatin = /[a-zA-Z]{3,}/.test(text); // Require at least 3 Latin chars
  const hasCyrillic = /[а-яА-ЯёЁ]{3,}/.test(text); // Require at least 3 Cyrillic chars
  const hasGreek = /[α-ωΑ-Ω]{3,}/.test(text); // Require at least 3 Greek chars

  // Check for suspicious keywords that might indicate an attack
  const hasSuspiciousKeywords = /(?:password|secret|key|token|api|sk-|ghp_|gho_)/i.test(text);

  if (hasSuspiciousKeywords && hasLatin && hasCyrillic) {
    hasMixedScripts = true;
    hasHomographs = true;
    details.push('混合拉丁字母和西里爾字母 (可能的同形異義字攻擊)');
  }

  if (hasSuspiciousKeywords && hasLatin && hasGreek) {
    hasMixedScripts = true;
    hasHomographs = true;
    details.push('混合拉丁字母和希臘字母 (可能的同形異義字攻擊)');
  }

  // Only check for specific homograph pairs if suspicious keywords present
  if (hasSuspiciousKeywords) {
    const homographPairs = [
      { latin: 'a', cyrillic: 'а', name: 'a/а' },
      { latin: 'e', cyrillic: 'е', name: 'e/е' },
      { latin: 'o', cyrillic: 'о', name: 'o/о' },
      { latin: 'p', cyrillic: 'р', name: 'p/р' },
      { latin: 'x', cyrillic: 'х', name: 'x/х' },
      { latin: 'y', cyrillic: 'у', name: 'y/у' },
    ];

    for (const pair of homographPairs) {
      const regex = new RegExp(`${pair.cyrillic}`, 'g');
      const matches = text.match(regex);
      if (matches && hasLatin) {
        hasHomographs = true;
        details.push(`包含西里爾字母 "${pair.cyrillic}" (易與拉丁字母 "${pair.latin}" 混淆)`);
      }
    }
  }

  return {
    hasZeroWidth,
    hasVariationSelectors,
    hasMixedScripts,
    hasHomographs,
    details,
  };
}

/**
 * Checks if a string likely contains a homograph attack.
 * This is a heuristic check - not 100% accurate but catches common patterns.
 */
export function isLikelyHomographAttack(text: string): boolean {
  const suspicious = detectSuspiciousUnicode(text);

  // High confidence indicators
  if (suspicious.hasZeroWidth) return true;
  if (suspicious.hasMixedScripts && suspicious.hasHomographs) return true;

  // Medium confidence: has homographs but not mixed scripts
  if (suspicious.hasHomographs && suspicious.details.length >= 2) return true;

  return false;
}

/**
 * Sanitizes text for scanning by applying Unicode normalization.
 * Returns both the normalized text and metadata about what was changed.
 */
export function sanitizeForScanning(text: string): {
  sanitized: string;
  metadata: {
    hadZeroWidth: boolean;
    hadVariants: boolean;
    removedChars: number;
    homographSuspected: boolean;
  };
} {
  const normalized = normalizeUnicode(text);
  const suspicious = detectSuspiciousUnicode(text);

  return {
    sanitized: normalized.normalized,
    metadata: {
      hadZeroWidth: normalized.hadZeroWidth,
      hadVariants: normalized.hadVariants,
      removedChars: normalized.removedChars,
      homographSuspected: suspicious.hasHomographs,
    },
  };
}

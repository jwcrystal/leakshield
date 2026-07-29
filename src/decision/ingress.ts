import { createHash } from "node:crypto";
import { scanText } from "../scanner/engine.js";
import { redactAndVerify } from "../scanner/redaction-verifier.js";
import type { GuardConfig } from "../types.js";

export type IngressMode = "block" | "redact";
export type ProtectionAction = "allow" | "block" | "redact";

export interface ProtectedText {
  action: ProtectionAction;
  text: string;
  totalFindings: number;
}

export interface ProtectionOptions {
  mode: IngressMode;
  context: string;
}

export type TextProtector = (
  text: string,
  config: GuardConfig,
  options: ProtectionOptions,
) => ProtectedText;

const DEFAULT_CACHE_SIZE = 512;

interface CachedDecision {
  action: "allow" | "block";
  totalFindings: number;
  blockedText?: string;
}

function blockedText(context: string, totalFindings: number): string {
  const count = totalFindings === 0 ? "unscanned" : `${totalFindings} sensitive item(s)`;
  return `[Sensitive Guard blocked ${context}: ${count}. Original content was not sent to the model.]`;
}

/**
 * Returns text that is safe to place in an LLM context. Content that exceeds
 * the scanner limit is blocked rather than forwarding an unscanned suffix.
 */
export function protectText(
  text: string,
  config: GuardConfig,
  options: ProtectionOptions,
): ProtectedText {
  try {
    const scan = scanText(text, config);
    if (scan.safe && !scan.was_truncated) {
      return { action: "allow", text, totalFindings: 0 };
    }

    if (options.mode === "redact" && !scan.was_truncated) {
      const verified = redactAndVerify(text, config);
      if (verified.verified && verified.redacted !== text) {
        return {
          action: "redact",
          text: verified.redacted,
          totalFindings: scan.total_findings,
        };
      }
    }

    return {
      action: "block",
      text: blockedText(options.context, scan.total_findings),
      totalFindings: scan.total_findings,
    };
  } catch {
    // A scanner failure must never result in the original content reaching a model.
    return { action: "block", text: blockedText(options.context, 0), totalFindings: 0 };
  }
}

/**
 * Bounded LRU cache for history replay. Entries store only a content hash and
 * an allow/block decision; original text and redacted text are never retained.
 */
export class ContentHashCache {
  private readonly entries = new Map<string, CachedDecision>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries = DEFAULT_CACHE_SIZE) {}

  get size(): number {
    return this.entries.size;
  }

  get stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }

  protect(text: string, config: GuardConfig, options: ProtectionOptions): ProtectedText {
    const key = this.keyFor(text, config, options);
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.action === "allow"
        ? { action: "allow", text, totalFindings: 0 }
        : { action: "block", text: cached.blockedText!, totalFindings: cached.totalFindings };
    }

    this.misses++;
    const result = protectText(text, config, options);
    if (result.action !== "redact") {
      this.set(key, result);
    }
    return result;
  }

  private keyFor(text: string, config: GuardConfig, options: ProtectionOptions): string {
    const { exact_value_detector, ...serializableConfig } = config;
    return createHash("sha256")
      .update(JSON.stringify({
        text,
        config: serializableConfig,
        exactValueFingerprint: exact_value_detector?.fingerprint,
        mode: options.mode,
        context: options.context,
      }))
      .digest("hex");
  }

  private set(key: string, result: ProtectedText): void {
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }

    this.entries.set(key, result.action === "allow"
      ? { action: "allow", totalFindings: 0 }
      : { action: "block", totalFindings: result.totalFindings, blockedText: result.text });
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Recursively protects strings embedded in JSON-like tool metadata. */
export function protectUnknownStrings(
  value: unknown,
  config: GuardConfig,
  options: ProtectionOptions,
  protector: TextProtector = protectText,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") {
    return protector(value, config, options).text;
  }

  if (typeof value !== "object" || value === null) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((item) => protectUnknownStrings(item, config, options, protector, seen)));
    return copy;
  }

  if (!isPlainRecord(value)) {
    return "[Sensitive Guard blocked unsupported metadata value.]";
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = protectUnknownStrings(item, config, options, protector, seen);
  }
  return copy;
}

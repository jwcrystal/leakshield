import { redactText, scanText } from "../scanner/engine.js";
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
      const redacted = redactText(text, config).redacted;
      if (redacted !== text) {
        const verification = scanText(redacted, config);
        if (verification.safe && !verification.was_truncated) {
          return {
            action: "redact",
            text: redacted,
            totalFindings: scan.total_findings,
          };
        }
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
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") {
    return protectText(value, config, options).text;
  }

  if (typeof value !== "object" || value === null) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((item) => protectUnknownStrings(item, config, options, seen)));
    return copy;
  }

  if (!isPlainRecord(value)) {
    return "[Sensitive Guard blocked unsupported metadata value.]";
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = protectUnknownStrings(item, config, options, seen);
  }
  return copy;
}

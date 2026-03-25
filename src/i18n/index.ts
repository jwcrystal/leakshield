import { en } from "./en.js";
import { zhTW } from "./zh-TW.js";

type Messages = typeof en;
type MessageKey = keyof Messages;

const SUPPORTED_LOCALES = ["en", "zh-TW"] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

function resolveLocale(): Locale {
  const lang = process.env.SENSITIVE_GUARD_LANG ?? "en";
  if (lang === "zh-TW" || lang === "zh") return "zh-TW";
  return "en";
}

const locale: Locale = resolveLocale();

const catalog: Messages = locale === "zh-TW" ? (zhTW as Messages) : en;

/**
 * Translate a message key, interpolating `{param}` placeholders.
 *
 * @example
 * t("scan.safe_summary")
 * t("cli.found_files", { count: 12 })
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let msg: string = catalog[key] ?? en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

export { locale };

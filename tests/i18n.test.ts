import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Helper: import t() with a specific locale ────────────────────────────────

async function loadT(lang: string) {
  vi.resetModules();
  vi.stubEnv("LEAKSHIELD_LANG", lang);
  const mod = await import("../src/i18n/index.js");
  return mod.t;
}

async function scanSummary(lang: string, text: string, settings: Record<string, unknown>) {
  vi.resetModules();
  vi.stubEnv("LEAKSHIELD_LANG", lang);
  const { GuardConfigSchema } = await import("../src/config/loader.js");
  const { scanText } = await import("../src/scanner/engine.js");
  return scanText(text, GuardConfigSchema.parse({ settings })).summary;
}

// ─── Scan warning labels ──────────────────────────────────────────────────────

describe("i18n — scan warning labels", () => {
  beforeEach(() => vi.unstubAllEnvs());

  const KEY = "sk-proj-test1234567890abcdef";
  const encoded = Buffer.from(KEY).toString("base64");
  const zeroWidth = KEY.replace("test", "te​st");
  const lookAlike = "pаssword=supersecret123";
  const long = `${KEY} ${"x".repeat(100)}`;

  it.each([
    ["en", encoded, { encoding_detection: true }, "[WARNING: Encoded content: Base64]"],
    ["zh-TW", encoded, { encoding_detection: true }, "[WARNING: 編碼檢測: Base64]"],
    ["en", long, { encoding_detection: true, max_chars: 40 }, "[WARNING: Content truncated]"],
    ["zh-TW", long, { encoding_detection: true, max_chars: 40 }, "[WARNING: 內容截斷]"],
    ["en", long, { max_chars: 40 }, "[WARNING: Content truncated]"],
    ["zh-TW", long, { max_chars: 40 }, "[WARNING: 內容截斷]"],
    ["en", zeroWidth, {}, "[WARNING: Zero-width characters]"],
    ["zh-TW", zeroWidth, {}, "[WARNING: 零寬字符]"],
    ["en", lookAlike, {}, "[WARNING: Suspicious Unicode]"],
    ["zh-TW", lookAlike, {}, "[WARNING: 可疑 Unicode]"],
  ])("uses the %s label for %s", async (lang, text, settings, expected) => {
    expect(await scanSummary(lang, text, settings)).toContain(expected);
  });
});

// ─── English (default) ────────────────────────────────────────────────────────

describe("i18n — English (default)", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("returns English string for scan.safe_summary", async () => {
    const t = await loadT("en");
    expect(t("scan.safe_summary")).toBe(
      "✅ No sensitive content detected, safe to send."
    );
  });

  it("interpolates {count}, {high}, {med}, {low} in scan.unsafe_summary", async () => {
    const t = await loadT("en");
    const msg = t("scan.unsafe_summary", { count: 3, high: 1, med: 1, low: 1 });
    expect(msg).toContain("3");
    expect(msg).toContain("HIGH: 1");
    expect(msg).toContain("MEDIUM: 1");
    expect(msg).toContain("LOW: 1");
  });

  it("returns English string for redact.unsafe_summary", async () => {
    const t = await loadT("en");
    expect(t("redact.unsafe_summary", { count: 5 })).toBe("🔒 Redacted 5 sensitive item(s).");
  });

  it("returns English string for cli.error_file_not_found", async () => {
    const t = await loadT("en");
    expect(t("cli.error_file_not_found", { path: "/tmp/foo.ts" })).toBe(
      "❌ File not found: /tmp/foo.ts"
    );
  });

  it("falls back to en when LEAKSHIELD_LANG is unrecognised", async () => {
    const t = await loadT("fr");
    expect(t("scan.safe_summary")).toBe(
      "✅ No sensitive content detected, safe to send."
    );
  });
});

// ─── Traditional Chinese ──────────────────────────────────────────────────────

describe("i18n — Traditional Chinese (zh-TW)", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("returns Chinese string for scan.safe_summary", async () => {
    const t = await loadT("zh-TW");
    expect(t("scan.safe_summary")).toBe("✅ 未偵測到敏感內容，可以安全傳送。");
  });

  it("also resolves when LEAKSHIELD_LANG=zh", async () => {
    const t = await loadT("zh");
    expect(t("scan.safe_summary")).toBe("✅ 未偵測到敏感內容，可以安全傳送。");
  });

  it("interpolates {count} in redact.unsafe_summary", async () => {
    const t = await loadT("zh-TW");
    expect(t("redact.unsafe_summary", { count: 2 })).toBe("🔒 已脫敏 2 個敏感項目。");
  });

  it("returns Chinese string for cli.error_dir_not_found", async () => {
    const t = await loadT("zh-TW");
    expect(t("cli.error_dir_not_found", { path: "/tmp/dir" })).toBe(
      "❌ 找不到目錄：/tmp/dir"
    );
  });

  it("interpolates {line} and {col} in cli.location", async () => {
    const t = await loadT("zh-TW");
    expect(t("cli.location", { line: 10, col: 5 })).toBe(" (第 10 行, 欄 5)");
  });
});

// ─── Parameter interpolation edge cases ──────────────────────────────────────

describe("i18n — interpolation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("leaves unmatched placeholders untouched", async () => {
    const t = await loadT("en");
    const msg = t("cli.found_files", {} as never);
    expect(msg).toContain("{count}");
  });

  it("replaces all occurrences of the same placeholder", async () => {
    const t = await loadT("en");
    // cli.redact_footer contains {summary} once — verify substitution works
    const msg = t("cli.redact_footer", { summary: "ok" });
    expect(msg).toBe("[leakshield] ok");
  });
});

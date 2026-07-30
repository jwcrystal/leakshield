/**
 * Windows terminal encoding initialisation.
 *
 * Windows cmd/PowerShell defaults to legacy code pages (437, 936, 950)
 * instead of UTF-8 (65001). This module sets UTF-8 so Chinese / emoji
 * output is not garbled.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

let inited = false;

/** Try to switch Windows console to UTF-8 code page (65001). */
export function initWindowsEncoding(): void {
  if (inited) return;
  inited = true;
  if (process.platform !== "win32") return;

  try {
    execSync("chcp 65001", { stdio: "pipe" });
  } catch {
    // chcp may not exist in msys / cygwin / stripped environments
  }
}

/**
 * Read a file with BOM-aware encoding detection.
 *
 * Windows editors sometimes save files as UTF-16LE or UTF-8 with BOM.
 * Plain `readFileSync(p, "utf-8")` mangles those.
 */
export function readFileWithEncoding(path: string): string {
  const raw = readFileSync(path);
  const bomUtf16le = raw[0] === 0xff && raw[1] === 0xfe;
  const bomUtf16be = raw[0] === 0xfe && raw[1] === 0xff;
  const bomUtf8 = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;

  if (bomUtf16le) {
    return new TextDecoder("utf-16le").decode(raw).replace(/\r\n/g, "\n");
  }
  if (bomUtf16be) {
    return new TextDecoder("utf-16be").decode(raw).replace(/\r\n/g, "\n");
  }
  // Strip UTF-8 BOM if present
  const content = bomUtf8 ? raw.toString("utf-8").slice(1) : raw.toString("utf-8");
  return content.replace(/\r\n/g, "\n");
}

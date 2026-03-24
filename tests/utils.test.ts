import { describe, it, expect } from "vitest";
import { redact, getLineCol } from "../src/scanner/utils.js";

// ─── redact() ────────────────────────────────────────────────────────────────

describe("redact()", () => {
  it("短字串（≤8 字元）一律回傳 ****", () => {
    expect(redact("abc", 60)).toBe("****");
    expect(redact("12345678", 60)).toBe("****");
  });

  it("長字串保留前 4 碼 + **** + 後 2 碼", () => {
    expect(redact("sk-abc123xyz789", 60)).toBe("sk-a****89");
    expect(redact("ghp_ABCDEFGHIJ123456789012345678901234", 60)).toBe(
      "ghp_****34"
    );
  });

  it("剛好 9 個字元仍套用長字串格式", () => {
    const val = "123456789"; // length = 9
    expect(redact(val, 60)).toBe("1234****89");
  });
});

// ─── getLineCol() ─────────────────────────────────────────────────────────────

describe("getLineCol()", () => {
  it("index 0 → 第 1 行第 1 欄", () => {
    expect(getLineCol("hello", 0)).toEqual({ line: 1, col: 1 });
  });

  it("單行文字中間位置", () => {
    // "hello" index 3 → 'd' → 第 1 行第 4 欄
    expect(getLineCol("hello", 3)).toEqual({ line: 1, col: 4 });
  });

  it("跨越換行後回到第 2 行", () => {
    const text = "line1\nline2";
    // index 6 → 'l' of 'line2' → 第 2 行第 1 欄
    expect(getLineCol(text, 6)).toEqual({ line: 2, col: 1 });
  });

  it("第 3 行中間位置", () => {
    const text = "aaa\nbbb\nccc";
    // index 9 → 'c' → 第 3 行第 2 欄
    expect(getLineCol(text, 9)).toEqual({ line: 3, col: 2 });
  });

  it("index 等於文字末尾", () => {
    const text = "ab\ncd";
    // index 5 → end → 第 2 行第 3 欄
    expect(getLineCol(text, 5)).toEqual({ line: 2, col: 3 });
  });
});

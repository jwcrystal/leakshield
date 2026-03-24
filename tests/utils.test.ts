import { describe, it, expect } from "vitest";
import { redact, getLineCol, getIgnoredLines } from "../src/scanner/utils.js";

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

// ─── getIgnoredLines() ────────────────────────────────────────────────────────

describe("getIgnoredLines()", () => {
  it("無 ignore 標記時回傳空 Set", () => {
    expect(getIgnoredLines("no ignore here")).toEqual(new Set());
  });

  it("偵測 // sensitive-guard-ignore（行內尾部）", () => {
    const text = "line1\nconst x = 'secret'; // sensitive-guard-ignore\nline3";
    expect(getIgnoredLines(text)).toEqual(new Set([2]));
  });

  it("偵測 # sensitive-guard-ignore（Python/YAML/Shell 風格）", () => {
    const text = "line1\nAPI_KEY=secret # sensitive-guard-ignore\nline3";
    expect(getIgnoredLines(text)).toEqual(new Set([2]));
  });

  it("大小寫不敏感", () => {
    const text = "// SENSITIVE-GUARD-IGNORE\nline2";
    expect(getIgnoredLines(text)).toEqual(new Set([1]));
  });

  it("多行各自標記", () => {
    const text = [
      "line1 // sensitive-guard-ignore",
      "line2",
      "line3 # sensitive-guard-ignore",
    ].join("\n");
    expect(getIgnoredLines(text)).toEqual(new Set([1, 3]));
  });
});

import { describe, it, expect } from "vitest";
import { redact, getLineCol, getIgnoredLines, createLineIndex, lineColAt } from "../src/scanner/utils.js";

// ─── redact() ────────────────────────────────────────────────────────────────

describe("redact()", () => {
  it("短字串（≤8 字元）一律回傳 ****", () => {
    expect(redact("abc", 60)).toBe("****");
    expect(redact("12345678", 60)).toBe("****");
  });

  it("長字串也完整遮罩，不保留任何前後綴", () => {
    expect(redact("sk-abc123xyz789", 60)).toBe("****");
    expect(redact("ghp_ABCDEFGHIJ123456789012345678901234", 60)).toBe("****");
  });

  it("任意長度字串均回傳 ****", () => {
    const val = "123456789"; // length = 9
    expect(redact(val, 60)).toBe("****");
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

  it("index 剛好在 \\n 上 → 仍屬前一行", () => {
    // "ab\ncd" index 2 → '\n' → 第 1 行第 3 欄
    expect(getLineCol("ab\ncd", 2)).toEqual({ line: 1, col: 3 });
  });

  it("index 緊接 \\n 之後 → 下一行第 1 欄", () => {
    expect(getLineCol("ab\ncd", 3)).toEqual({ line: 2, col: 1 });
  });

  it("\\r\\n 算一個換行；其後為第 2 行第 1 欄", () => {
    expect(getLineCol("a\r\nb", 3)).toEqual({ line: 2, col: 1 });
  });

  it("index 在 \\r 與 \\n 之間 → 第 1 行第 3 欄（\\r 計入欄位）", () => {
    expect(getLineCol("a\r\nb", 2)).toEqual({ line: 1, col: 3 });
  });

  it("單獨的 \\r 不是換行", () => {
    expect(getLineCol("a\rb", 3)).toEqual({ line: 1, col: 4 });
  });

  it("空字串", () => {
    expect(getLineCol("", 0)).toEqual({ line: 1, col: 1 });
  });

  it("連續換行", () => {
    expect(getLineCol("\n\n", 2)).toEqual({ line: 3, col: 1 });
    expect(getLineCol("\n\n", 1)).toEqual({ line: 2, col: 1 });
    expect(getLineCol("\r\n\r\n", 4)).toEqual({ line: 3, col: 1 });
    expect(getLineCol("\r\n\r\n", 3)).toEqual({ line: 2, col: 2 });
  });

  it("文字以換行結尾", () => {
    expect(getLineCol("ab\n", 3)).toEqual({ line: 2, col: 1 });
    expect(getLineCol("ab\r\n", 4)).toEqual({ line: 2, col: 1 });
  });

  it("超出範圍的 index 沿用 String.prototype.slice 行為", () => {
    // index > length → 夾到文字末尾
    expect(getLineCol("ab\ncd", 99)).toEqual({ line: 2, col: 3 });
    // 負數 → 從尾端起算
    expect(getLineCol("ab\ncd", -1)).toEqual({ line: 2, col: 2 });
    // NaN → 0
    expect(getLineCol("ab\ncd", NaN)).toEqual({ line: 1, col: 1 });
    // 小數 → 截斷
    expect(getLineCol("ab\ncd", 3.9)).toEqual({ line: 2, col: 1 });
  });
});

// ─── createLineIndex() / lineColAt() ─────────────────────────────────────────

/** 舊實作（slice + split）的參考拷貝，用來做差異比對。 */
function referenceLineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

describe("createLineIndex() / lineColAt()", () => {
  it("createLineIndex 回傳每行起點", () => {
    expect(createLineIndex("")).toEqual([0]);
    expect(createLineIndex("ab\ncd")).toEqual([0, 3]);
    expect(createLineIndex("a\r\nb\rc\n")).toEqual([0, 3, 7]);
  });

  const texts = ["", "\n", "\r", "\r\n", "\n\r", "\r\r\n", "a\r\nb\nc\rd\n", "\n\n\r\n", "abc", "x\n"];
  for (const text of texts) {
    it(`與舊實作逐 index 一致：${JSON.stringify(text)}`, () => {
      const starts = createLineIndex(text);
      for (let i = 0; i <= text.length; i++) {
        const expected = referenceLineCol(text, i);
        expect(lineColAt(starts, i), `lineColAt i=${i}`).toEqual(expected);
        expect(getLineCol(text, i), `getLineCol i=${i}`).toEqual(expected);
      }
    });
  }
});

// ─── getIgnoredLines() ────────────────────────────────────────────────────────

describe("getIgnoredLines()", () => {
  it("無 ignore 標記時回傳空 Set", () => {
    expect(getIgnoredLines("no ignore here")).toEqual(new Set());
  });

  it("偵測 // leakshield-ignore（行內尾部）", () => {
    const text = "line1\nconst x = 'secret'; // leakshield-ignore\nline3";
    expect(getIgnoredLines(text)).toEqual(new Set([2]));
  });

  it("偵測 # leakshield-ignore（Python/YAML/Shell 風格）", () => {
    const text = "line1\nAPI_KEY=secret # leakshield-ignore\nline3";
    expect(getIgnoredLines(text)).toEqual(new Set([2]));
  });

  it("大小寫不敏感", () => {
    const text = "// LEAKSHIELD-IGNORE\nline2";
    expect(getIgnoredLines(text)).toEqual(new Set([1]));
  });

  it("多行各自標記", () => {
    const text = [
      "line1 // leakshield-ignore",
      "line2",
      "line3 # leakshield-ignore",
    ].join("\n");
    expect(getIgnoredLines(text)).toEqual(new Set([1, 3]));
  });
});

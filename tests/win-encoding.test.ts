import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileWithEncoding } from "../src/utils/win-encoding.js";

const tempDirs: string[] = [];

function writeTempFile(bytes: Buffer): string {
  const directory = mkdtempSync(join(tmpdir(), "leakshield-"));
  tempDirs.push(directory);
  const file = join(directory, "input.txt");
  writeFileSync(file, bytes);
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("readFileWithEncoding", () => {
  it("removes a UTF-8 BOM and normalizes CRLF", () => {
    const file = writeTempFile(Buffer.from("\uFEFFfirst\r\nsecond", "utf-8"));

    expect(readFileWithEncoding(file)).toBe("first\nsecond");
  });

  it("decodes a UTF-16LE BOM", () => {
    const file = writeTempFile(Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("繁體中文\r\nnext", "utf-16le"),
    ]));

    expect(readFileWithEncoding(file)).toBe("繁體中文\nnext");
  });

  it("decodes a UTF-16BE BOM", () => {
    const utf16le = Buffer.from("繁體中文\r\nnext", "utf-16le");
    const utf16be = Buffer.alloc(utf16le.length);
    for (let index = 0; index < utf16le.length; index += 2) {
      utf16be[index] = utf16le[index + 1];
      utf16be[index + 1] = utf16le[index];
    }
    const file = writeTempFile(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]));

    expect(readFileWithEncoding(file)).toBe("繁體中文\nnext");
  });
});

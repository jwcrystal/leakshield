/**
 * The masking path's exact-value search. Both strategies must report the same
 * occurrences in the same order: which one runs is a cost estimate, so a
 * difference between them would make masking depend on input size.
 */

import { describe, expect, it } from "vitest";
import { createValueSearch, type ValueSearchStrategy } from "../src/decision/value-search.js";

const STRATEGIES: ValueSearchStrategy[] = ["indexOf", "automaton", "auto"];

function searchOver(values: string[], strategy: ValueSearchStrategy) {
  return createValueSearch(values, values.length, strategy);
}

/** Every occurrence offered when nothing is taken, as "value@start". */
function offered(values: string[], text: string, strategy: ValueSearchStrategy): string[] {
  const seen: string[] = [];
  searchOver(values, strategy).visitOccurrences(text, (start, end, value) => {
    expect(text.slice(start, end)).toBe(value);
    seen.push(`${value}@${start}`);
    return false;
  });
  return seen;
}

/** The same disjoint-taking rule as repeatOccurrences. */
function taken(values: string[], text: string, strategy: ValueSearchStrategy): string[] {
  const flags = new Uint8Array(text.length);
  const kept: string[] = [];
  searchOver(values, strategy).visitOccurrences(text, (start, end, value) => {
    for (let i = start; i < end; i++) if (flags[i] === 1) return false;
    flags.fill(1, start, end);
    kept.push(`${value}@${start}`);
    return true;
  });
  return kept;
}

describe.each(STRATEGIES)("value search (%s)", (strategy) => {
  it("offers shared-prefix values longest first, each in position order", () => {
    const values = ["user1@x.co", "user10@x.co", "user100@x.co"];
    const text = "user100@x.co user1@x.co user10@x.co user1@x.co";
    expect(offered(values, text, strategy)).toEqual([
      "user100@x.co@0",
      "user10@x.co@24",
      "user1@x.co@13",
      "user1@x.co@36",
    ]);
  });

  it("offers overlapping occurrences of one value, unless the first was taken", () => {
    expect(offered(["aa"], "aaaa", strategy)).toEqual(["aa@0", "aa@1", "aa@2"]);
    expect(taken(["aa"], "aaaa", strategy)).toEqual(["aa@0", "aa@2"]);
  });

  it("falls back to a shorter suffix value only when the longer one is not taken", () => {
    const values = ["abcd", "bcd", "cd"];
    expect(offered(values, "abcd", strategy)).toEqual(["abcd@0", "bcd@1", "cd@2"]);
    expect(taken(values, "abcd bcd cd", strategy)).toEqual(["abcd@0", "bcd@5", "cd@9"]);

    const blockedLongest: string[] = [];
    searchOver(values, strategy).visitOccurrences("abcd", (start, end, value) => {
      blockedLongest.push(value);
      return value === "bcd";
    });
    // Whether anything is offered after a take is the visitor's to reject.
    expect(blockedLongest.slice(0, 2)).toEqual(["abcd", "bcd"]);
  });

  it("does not let a shorter value split a longer one overlapping it", () => {
    expect(taken(["bc", "abcd"], "abcd", strategy)).toEqual(["abcd@0"]);
    expect(taken(["ab", "bcd"], "abcd", strategy)).toEqual(["bcd@1"]);
  });

  it("breaks equal-length overlaps by input order", () => {
    expect(taken(["aab", "baa"], "baab", strategy)).toEqual(["aab@1"]);
    expect(taken(["baa", "aab"], "baab", strategy)).toEqual(["baa@0"]);
  });

  it("finds a value that starts inside a failed longer match", () => {
    const values = ["abcabd", "bca", "cab"];
    expect(offered(values, "abcabcabd", strategy)).toEqual([
      "abcabd@3",
      "bca@1",
      "bca@4",
      "cab@2",
      "cab@5",
    ]);
  });

  it("matches by UTF-16 unit, so a lone half of a pair or U+FFFF is a value too", () => {
    const pair = "\u{1F600}";
    const values = [`x${pair}`, pair[1], "￿", "\u0000"];
    expect(offered(values, `x${pair} ￿\u0000`, strategy)).toEqual([
      `x${pair}@0`,
      `${pair[1]}@2`,
      "￿@4",
      "\u0000@5",
    ]);
  });

  it("ignores empty and repeated values", () => {
    expect(offered(["", "ab", "ab"], "ab", strategy)).toEqual(["ab@0"]);
    expect(offered([], "ab", strategy)).toEqual([]);
    expect(searchOver([""], strategy).everyOccurrenceCovered("ab", [])).toBe(true);
  });

  it("requires every occurrence inside one span", () => {
    const covered = (values: string[], text: string, spans: Array<{ start: number; end: number }>) =>
      searchOver(values, strategy).everyOccurrenceCovered(text, spans);

    expect(covered(["ab"], "xx", [])).toBe(true);
    expect(covered(["ab"], "ab", [])).toBe(false);
    expect(covered(["ab"], "ab", [{ start: 0, end: 2 }])).toBe(true);
    expect(covered(["ab"], "ab ab", [{ start: 0, end: 2 }])).toBe(false);
    expect(covered(["ab"], "ab ab", [{ start: 0, end: 2 }, { start: 3, end: 5 }])).toBe(true);
    // Touching spans are still two spans: an occurrence across them is outside.
    expect(covered(["ab"], "ab", [{ start: 0, end: 1 }, { start: 1, end: 2 }])).toBe(false);
  });

  it("checks overlapping occurrences, not only the first of a run", () => {
    const search = searchOver(["aa"], strategy);
    expect(search.everyOccurrenceCovered("aaa", [{ start: 0, end: 2 }])).toBe(false);
    expect(search.everyOccurrenceCovered("aaa", [{ start: 1, end: 3 }])).toBe(false);
    expect(search.everyOccurrenceCovered("aaa", [{ start: 0, end: 3 }])).toBe(true);
  });

  it("checks nested and overlapping values independently of each other", () => {
    const span = [{ start: 0, end: 4 }];
    // A value crossing the span's end, overlapping one inside it.
    expect(searchOver(["abcd", "cde"], strategy).everyOccurrenceCovered("abcde", span)).toBe(false);
    // Shared prefix: the shorter value fits, the longer one crosses.
    expect(searchOver(["abcd", "abcde"], strategy).everyOccurrenceCovered("abcde", span)).toBe(false);
    // Shared suffix: the shorter value fits, the longer one crosses the start.
    const late = [{ start: 1, end: 5 }];
    expect(searchOver(["bcde", "abcde"], strategy).everyOccurrenceCovered("abcde", late)).toBe(false);
    // All of them inside.
    expect(searchOver(["abcd", "bcd", "cd"], strategy).everyOccurrenceCovered("abcd", span)).toBe(true);
  });

  it("never reports coverage from spans out of order that do not contain the value", () => {
    const shuffled = [{ start: 6, end: 8 }, { start: 0, end: 1 }];
    expect(searchOver(["ab"], strategy).everyOccurrenceCovered("ab", shuffled)).toBe(false);
  });

  it("handles values nested at every position without losing any", () => {
    const values = Array.from({ length: 200 }, (_, i) => "a".repeat(i + 1));
    const text = "a".repeat(5000);
    expect(taken(values, text, strategy)).toEqual(
      Array.from({ length: 25 }, (_, i) => `${values[199]}@${i * 200}`),
    );
    const spanWhole = [{ start: 0, end: text.length }];
    expect(searchOver(values, strategy).everyOccurrenceCovered(text, spanWhole)).toBe(true);
    const short = [{ start: 0, end: text.length - 1 }];
    expect(searchOver(values, strategy).everyOccurrenceCovered(text, short)).toBe(false);
  });
});

describe("value search strategies agree", () => {
  // Fixed seed: a failure here must reproduce.
  function randomFrom(seed: number): (limit: number) => number {
    let state = seed;
    return (limit) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return Math.floor((state / 0x100000000) * limit);
    };
  }

  it("on random small-alphabet inputs, where overlaps are common", () => {
    const random = randomFrom(47);
    const stringOf = (length: number, alphabet: string): string => {
      let out = "";
      for (let i = 0; i < length; i++) out += alphabet[random(alphabet.length)];
      return out;
    };
    for (let round = 0; round < 1500; round++) {
      const alphabet = round % 3 === 0 ? "a" : round % 3 === 1 ? "ab" : "abc";
      const text = stringOf(random(80), alphabet);
      const values: string[] = [];
      for (let i = random(8); i >= 0; i--) {
        // Half are cut from the text, so that they occur.
        const start = random(text.length + 1);
        values.push(random(2) === 0 ? text.slice(start, start + random(6)) : stringOf(random(6), alphabet));
      }
      const spans: Array<{ start: number; end: number }> = [];
      for (let at = random(10); at < text.length; at += 1 + random(12)) {
        const end = at + 1 + random(8);
        spans.push({ start: at, end });
        at = end;
      }
      const context = JSON.stringify({ text, values, spans });

      const reference = {
        offered: offered(values, text, "indexOf"),
        taken: taken(values, text, "indexOf"),
        covered: searchOver(values, "indexOf").everyOccurrenceCovered(text, spans),
      };
      expect({
        offered: offered(values, text, "automaton"),
        taken: taken(values, text, "automaton"),
        covered: searchOver(values, "automaton").everyOccurrenceCovered(text, spans),
      }, context).toEqual(reference);

      // Independent of both strategies, against the definition.
      let brute = true;
      for (const value of new Set(values)) {
        if (value.length === 0) continue;
        for (let at = 0; at + value.length <= text.length; at++) {
          if (!text.startsWith(value, at)) continue;
          if (!spans.some((span) => span.start <= at && at + value.length <= span.end)) brute = false;
        }
      }
      expect(reference.covered, context).toBe(brute);
    }
  });

  it("reuses a built automaton across texts", () => {
    const search = searchOver(["needle", "dle"], "automaton");
    const seenIn = (text: string) => {
      const seen: string[] = [];
      search.visitOccurrences(text, (start, _end, value) => {
        seen.push(`${value}@${start}`);
        return false;
      });
      return seen;
    };
    expect(seenIn("a needle")).toEqual(["needle@2", "dle@5"]);
    expect(seenIn("dle needle")).toEqual(["needle@4", "dle@0", "dle@7"]);
  });
});

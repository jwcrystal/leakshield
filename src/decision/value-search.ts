/**
 * Exact-value search for the masking path: every occurrence of a set of
 * detected values in one string, overlapping occurrences included.
 *
 * Searching each value with indexOf costs (values × text length), which is
 * what limited how large a string the model path could afford. An Aho-Corasick
 * automaton over UTF-16 code units costs (total value length + text length),
 * plus the occurrences visited, but building one costs far more than a few
 * indexOf calls and the value set can grow with every string of a request. So
 * indexOf stays for small searches and the automaton takes over when the
 * estimate favours it. Both strategies yield the same occurrences in the same
 * order; tests/value-search.test.ts holds them to that.
 */

export type ValueSearchStrategy = "auto" | "indexOf" | "automaton";

/**
 * Called for an occurrence of `value` at [start, end). Return true when the
 * occurrence was taken. That promises every occurrence overlapping it would be
 * rejected, so the search may skip those.
 */
export type OccurrenceVisitor = (start: number, end: number, value: string) => boolean;

export interface ValueSearch {
  /** Number of distinct values the caller supplied, for detecting staleness. */
  readonly sourceSize: number;
  /**
   * Visits occurrences longest value first, ties in input order, and each
   * value's occurrences in ascending position.
   */
  visitOccurrences(text: string, visit: OccurrenceVisitor): void;
  /**
   * True when every occurrence of every value lies inside one of `spans`, which
   * must be ascending and disjoint. Spans out of order can only make this return
   * false, never true.
   */
  everyOccurrenceCovered(text: string, spans: readonly { start: number; end: number }[]): boolean;
}

/**
 * Relative costs in units of one indexOf per character (about 0.2 ns). Measured
 * at about 2-20 ns per text unit to scan and 15-150 ns per value unit to build,
 * and rounded so a wrong guess near the boundary costs little either way.
 */
const AUTOMATON_SCAN_COST = 32;
const AUTOMATON_BUILD_COST_PER_UNIT = 256;

const ROOT = 0;
const NO_VALUE = -1;

class Automaton {
  /** Children of ROOT, by code unit; 0 means none. Most positions stop here. */
  private readonly rootChild = new Int32Array(0x10000);
  // Open-addressed table of (node, code unit) -> child for every other node.
  private readonly slotParent: Int32Array;
  private readonly slotUnit: Uint16Array;
  private readonly slotChild: Int32Array;
  private readonly slotMask: number;
  private readonly fail: Int32Array;
  /** Longest value that is a suffix of each node's string, or NO_VALUE. */
  private readonly longest: Int32Array;
  /** For each value, the next longest value that is a suffix of it. */
  readonly nextShorter: Int32Array;

  constructor(values: readonly string[], totalUnits: number) {
    const capacity = totalUnits + 1;
    let slots = 16;
    while (slots < capacity * 2) slots *= 2;
    this.slotParent = new Int32Array(slots).fill(-1);
    this.slotUnit = new Uint16Array(slots);
    this.slotChild = new Int32Array(slots);
    this.slotMask = slots - 1;
    this.fail = new Int32Array(capacity);
    this.longest = new Int32Array(capacity).fill(NO_VALUE);
    this.nextShorter = new Int32Array(values.length).fill(NO_VALUE);

    // Trie. A shared prefix shares nodes, so `nodes` can end below `capacity`.
    const parent = new Int32Array(capacity);
    const unitOf = new Uint16Array(capacity);
    const depth = new Int32Array(capacity);
    const terminal = new Int32Array(values.length);
    let nodes = 1;
    for (let rank = 0; rank < values.length; rank++) {
      const value = values[rank];
      let node = ROOT;
      for (let i = 0; i < value.length; i++) {
        const unit = value.charCodeAt(i);
        let child = this.child(node, unit);
        if (child === ROOT) {
          child = nodes++;
          this.insert(node, unit, child);
          parent[child] = node;
          unitOf[child] = unit;
          depth[child] = i + 1;
        }
        node = child;
      }
      terminal[rank] = node;
      this.longest[node] = rank; // input is distinct, so each node ends one value
    }

    // Failure links, shallowest first: a link always points to a shallower node.
    const startOfDepth = new Int32Array((values[0]?.length ?? 0) + 2);
    for (let node = 1; node < nodes; node++) startOfDepth[depth[node] + 1]++;
    for (let d = 1; d < startOfDepth.length; d++) startOfDepth[d] += startOfDepth[d - 1];
    const byDepth = new Int32Array(nodes - 1);
    for (let node = 1; node < nodes; node++) byDepth[startOfDepth[depth[node]]++] = node;
    for (const node of byDepth) {
      if (parent[node] !== ROOT) {
        const unit = unitOf[node];
        let link = this.fail[parent[node]];
        let child = this.child(link, unit);
        while (child === ROOT && link !== ROOT) {
          link = this.fail[link];
          child = this.child(link, unit);
        }
        this.fail[node] = child;
      }
      // A node's own value is longer than any proper suffix of it.
      if (this.longest[node] === NO_VALUE) this.longest[node] = this.longest[this.fail[node]];
    }
    for (let rank = 0; rank < values.length; rank++) {
      this.nextShorter[rank] = this.longest[this.fail[terminal[rank]]];
    }
  }

  private child(node: number, unit: number): number {
    if (node === ROOT) return this.rootChild[unit];
    const mask = this.slotMask;
    let slot = (Math.imul(node, 0x9e3779b1) ^ Math.imul(unit, 0x85ebca6b)) & mask;
    for (;;) {
      const owner = this.slotParent[slot];
      if (owner === -1) return ROOT;
      if (owner === node && this.slotUnit[slot] === unit) return this.slotChild[slot];
      slot = (slot + 1) & mask;
    }
  }

  private insert(node: number, unit: number, child: number): void {
    if (node === ROOT) {
      this.rootChild[unit] = child;
      return;
    }
    const mask = this.slotMask;
    let slot = (Math.imul(node, 0x9e3779b1) ^ Math.imul(unit, 0x85ebca6b)) & mask;
    while (this.slotParent[slot] !== -1) slot = (slot + 1) & mask;
    this.slotParent[slot] = node;
    this.slotUnit[slot] = unit;
    this.slotChild[slot] = child;
  }

  /**
   * Reports, per end position in ascending order, only the longest value ending
   * there; nextShorter gives the rest. Stops when `visit` returns false.
   */
  scan(text: string, visit: (end: number, rank: number) => boolean): void {
    const { rootChild, fail, longest } = this;
    let node = ROOT;
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      if (node === ROOT) {
        node = rootChild[unit];
        if (node === ROOT) continue;
      } else {
        let child = this.child(node, unit);
        while (child === ROOT && node !== ROOT) {
          node = fail[node];
          child = this.child(node, unit);
        }
        node = child;
      }
      const rank = longest[node];
      if (rank !== NO_VALUE && !visit(i + 1, rank)) return;
    }
  }
}

export function createValueSearch(
  source: Iterable<string>,
  sourceSize: number,
  strategy: ValueSearchStrategy = "auto",
): ValueSearch {
  // Stable sort: equal lengths keep input order, which decides which of two
  // overlapping values of the same length is masked.
  const values = [...new Set(source)]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
  let totalUnits = 0;
  for (const value of values) totalUnits += value.length;

  let automaton: Automaton | undefined;
  const automatonFor = (text: string): Automaton | undefined => {
    if (strategy === "indexOf") return undefined;
    if (strategy === "auto") {
      const indexOfCost = values.length * text.length;
      const scanCost = AUTOMATON_SCAN_COST * text.length;
      const buildCost = automaton === undefined ? AUTOMATON_BUILD_COST_PER_UNIT * totalUnits : 0;
      if (indexOfCost < scanCost + buildCost) return undefined;
    }
    automaton ??= new Automaton(values, totalUnits);
    return automaton;
  };

  return {
    sourceSize,
    visitOccurrences(text, visit) {
      const built = automatonFor(text);
      if (built === undefined) {
        for (const value of values) {
          let from = 0;
          for (;;) {
            const at = text.indexOf(value, from);
            if (at === -1) break;
            from = visit(at, at + value.length, value) ? at + value.length : at + 1;
          }
        }
        return;
      }
      // One pending list per value, holding end positions. A position sits in
      // exactly one list at a time, so memory stays bounded by the text even
      // when values nest inside each other at every position.
      const pending: Array<number[] | undefined> = new Array(values.length);
      built.scan(text, (end, rank) => {
        (pending[rank] ??= []).push(end);
        return true;
      });
      for (let rank = 0; rank < values.length; rank++) {
        const ends = pending[rank];
        if (ends === undefined) continue;
        pending[rank] = undefined;
        ends.sort((a, b) => a - b);
        const value = values[rank];
        const shorter = built.nextShorter[rank];
        for (const end of ends) {
          // A shorter value ending here lies inside this occurrence, so taking
          // this one settles it; otherwise it is still to be offered.
          if (!visit(end - value.length, end, value) && shorter !== NO_VALUE) {
            (pending[shorter] ??= []).push(end);
          }
        }
      }
    },
    everyOccurrenceCovered(text, spans) {
      const coveredFrom = (cursor: number, start: number, end: number): number => {
        while (cursor < spans.length && spans[cursor].end < end) cursor++;
        return cursor < spans.length && spans[cursor].start <= start ? cursor : -1;
      };
      const built = automatonFor(text);
      if (built === undefined) {
        for (const value of values) {
          let cursor = 0;
          for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
            cursor = coveredFrom(cursor, at, at + value.length);
            if (cursor === -1) return false;
          }
        }
        return true;
      }
      // Only the longest value per end position needs checking: the shorter
      // ones lie inside it, so if it is covered they are, and if it is not the
      // answer is already false.
      let cursor = 0;
      let covered = true;
      built.scan(text, (end, rank) => {
        cursor = coveredFrom(cursor, end - values[rank].length, end);
        covered = cursor !== -1;
        return covered;
      });
      return covered;
    },
  };
}

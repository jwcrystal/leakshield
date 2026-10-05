/**
 * Session-scoped reversible pseudonymization core (issue #22, offline core).
 *
 * This module is a PURE IN-MEMORY DATA SUBSTITUTION engine over strings and
 * strict-JSON values. It performs exact, reversible replacement of scanner
 * findings with opaque session-scoped tokens. It does NOT provide, and must
 * not be described as providing: shell escaping, tool permission decisions,
 * model dispatch, provider/streaming/WebSocket rewriting, UI restoration, or
 * persistence. Runtime adapters are not wired in this module; integrating it
 * into OpenCode hooks remains gated on runtime evidence.
 *
 * Guarantees implemented here:
 * - Bidirectional exact-string mapping per session identity (never normalized,
 *   never shared across sessions, never persisted; no TTL, no eviction, no fs).
 * - Opaque reserved token namespace `[SGP1:<epoch32hex>-<counter>]` with a
 *   fresh 128-bit random epoch per session creation. Strict protection and
 *   restoration entrypoints reject foreign, expired, or malformed markers.
 *   Explicit model-text entrypoints preserve unknown markers as literal text,
 *   scan them normally, and never grant them mapping ownership.
 * - Every protect/restore operation is an atomic transaction: the live
 *   registry is mutated only after the whole operation (including rescans,
 *   token-neighbor scans, capacity checks and independent absence checks)
 *   succeeds. Failed restores never mutate anything; inputs are never mutated.
 * - Issued tokens are validated FIRST, as a unit: their spans are exempt
 *   (interior findings included, before overlap checks) on input and output,
 *   crossing matches still fail, and token epochs are never decoded as user
 *   content — decoding runs only over separate non-token segments, while
 *   the decoder's URL-context windows crossing a token retain that token's
 *   fragment verbatim and decode only the surrounding pieces.
 * - Failures carry ONLY a static reason string: no originals, findings,
 *   previews, exception messages, partial output, or blocked-content notices.
 *
 * Non-goals documented up front: this is not universal detection. The engine's
 * own finding collapse can hide values; the rescan plus independent absence
 * check below is defense in depth over WHAT the scanner reports, not a claim
 * that every sensitive value is detected.
 */

import { randomBytes } from "node:crypto";
import { types } from "node:util";
import { scanTextWithDecoding } from "../scanner/encoding.js";
import { scanTextInternal, type ScanOptions } from "../scanner/engine.js";
import type { Finding, GuardConfig, ScanResult } from "../types.js";

// ─── Public result types ─────────────────────────────────────────────────────

/** Static failure codes. Every failure result contains only `reason`. */
export type PseudonymFailureReason =
  | "invalid_session"
  | "invalid_input"
  | "session_limit"
  | "entry_limit"
  | "session_capacity"
  | "aggregate_capacity"
  | "operation_limit"
  | "truncated_content"
  | "encoded_content"
  | "invalid_finding_span"
  | "overlapping_findings"
  | "token_overlap"
  | "malformed_token"
  | "unknown_token"
  | "residual_sensitive_content"
  | "unsafe_structure"
  | "key_collision"
  | "epoch_collision"
  | "token_collision"
  | "scanner_failure"
  | "internal_failure";

export interface PseudonymFailure {
  ok: false;
  reason: PseudonymFailureReason;
}

export type PseudonymTextResult = { ok: true; text: string } | PseudonymFailure;
export type PseudonymJsonResult = { ok: true; value: unknown } | PseudonymFailure;

/** Documented conservative budgets. All values are positive safe integers. */
export interface PseudonymLimits {
  /** Live sessions with at least one committed mapping. Default 128. */
  maxSessions: number;
  /** Mapping entries (original+token pairs) per session. Default 4096. */
  maxEntriesPerSession: number;
  /**
   * Per-session charge in UTF-16 code units: originals + tokens + the session
   * identity + ENTRY_OVERHEAD_UNITS per entry. 2 bytes/unit ⇒ 2,097,152 units
   * ≈ 4 MiB. A conservative accounting bound, not an actual-JS-RSS guarantee.
   */
  maxSessionUnits: number;
  /** Aggregate mapping entries across all sessions of THIS service instance. Default 65536. */
  maxEntriesTotal: number;
  /**
   * Aggregate UTF-16-unit charge across all sessions (16,777,216 ≈ 32 MiB at
   * 2 bytes/unit). Per service instance only — not a claim about every
   * possible instance or process RSS.
   */
  maxUnitsTotal: number;
  /** Maximum strict-JSON nesting depth per operation. Default 32. */
  maxDepth: number;
  /** Maximum visited value nodes per JSON operation. Default 10000. */
  maxNodes: number;
  /**
   * Combined input+output UTF-16-unit budget per operation (text and JSON),
   * bounding traversal and restored/output growth. Default 1 Mi units.
   */
  maxUnitsPerOperation: number;
}

export interface PseudonymizerService {
  isTextSafe(text: string): boolean;
  protectText(sessionId: string, text: string): PseudonymTextResult;
  protectTextForModel(sessionId: string, text: string): PseudonymTextResult;
  restoreText(sessionId: string, text: string): PseudonymTextResult;
  restoreTextForDisplay(sessionId: string, text: string): PseudonymTextResult;
  protectJson(sessionId: string, value: unknown): PseudonymJsonResult;
  protectJsonForModel(sessionId: string, value: unknown): PseudonymJsonResult;
  restoreJson(sessionId: string, value: unknown): PseudonymJsonResult;
  /** Drops one session's mappings and releases its budgets. Safe if absent. */
  clearSession(sessionId: string): void;
}

export type CreatePseudonymizerResult =
  | ({ ok: true } & PseudonymizerService)
  | { ok: false; reason: "STATIC_CODE" };

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Reserved, recognizable token namespace. Tokens are
 * `[SGP1:<32 lowercase hex epoch>-<zero-padded counter>]`, e.g.
 * `[SGP1:0f1e...-00000001]`. Any occurrence of the prefix in any scanned or
 * restored string is validated strictly; unknown shapes fail the operation.
 */
export const PSEUDONYM_TOKEN_PREFIX = "[SGP1:";

const TOKEN_SHAPE = /\[SGP1:[0-9a-f]{32}-\d{8,12}\]/y;
const EPOCH_HEX_CHARS = 32; // 128-bit random session epoch
const COUNTER_PAD = 8;

/** Conservative per-entry accounting overhead in UTF-16 units. */
const ENTRY_OVERHEAD_UNITS = 64;
/** Conservative per-JSON-node accounting overhead in UTF-16 units. */
const NODE_OVERHEAD_UNITS = 8;
const SESSION_ID_MAX_UNITS = 256;

const DEFAULT_LIMITS: PseudonymLimits = {
  maxSessions: 128,
  maxEntriesPerSession: 4096,
  maxSessionUnits: 2 * 1024 * 1024, // ≈ 4 MiB at 2 bytes per UTF-16 unit
  maxEntriesTotal: 65536,
  maxUnitsTotal: 16 * 1024 * 1024, // ≈ 32 MiB at 2 bytes per UTF-16 unit
  maxDepth: 32,
  maxNodes: 10000,
  maxUnitsPerOperation: 1024 * 1024,
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function fail(reason: PseudonymFailureReason): PseudonymFailure {
  return { ok: false, reason };
}

function isValidSessionId(value: unknown): value is string {
  // Exact identity: no trimming, no normalization, no shared fallback.
  return typeof value === "string" && value.length > 0 && value.length <= SESSION_ID_MAX_UNITS;
}

function isPositiveSafeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidConfigShape(config: unknown): config is GuardConfig {
  if (typeof config !== "object" || config === null) return false;
  const settings = (config as { settings?: unknown }).settings;
  if (typeof settings !== "object" || settings === null) return false;
  return isPositiveSafeInt((settings as { max_chars?: unknown }).max_chars);
}

/**
 * Durable snapshot of the validated scanner configuration. The service must
 * never re-read caller-owned objects after the factory returns: post-
 * construction mutations (settings.max_chars = NaN, custom_rules array
 * edits, nested pattern rewrites) must not be able to weaken or enlarge
 * scanning. Plain data (settings, nested rules, keyword/domain arrays,
 * exclusions) is deep-copied. The exact-value detector is snapshotted as a
 * private facade whose scanner-facing callable (findAll — the only method
 * the scanner invokes, plus the public fingerprint) is captured AND bound
 * at factory time, so no later instance or prototype lookup can weaken
 * detection. The facade exposes no detector values and never mutates the
 * caller's detector or class. Returns null when the config cannot be
 * snapshotted without invoking unsupported behavior — the factory then
 * fails statically instead of scanning weakened.
 */
function snapshotConfig(config: GuardConfig): GuardConfig | null {
  try {
    const { exact_value_detector, ...dataOnly } = config;
    const snapshot: GuardConfig = structuredClone(dataOnly);
    if (exact_value_detector !== undefined) {
      const findAll = exact_value_detector.findAll;
      if (typeof findAll !== "function") return null;
      snapshot.exact_value_detector = {
        fingerprint: exact_value_detector.fingerprint,
        findAll: findAll.bind(exact_value_detector),
      } as unknown as NonNullable<GuardConfig["exact_value_detector"]>;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function resolveLimits(
  limits: Partial<PseudonymLimits> | undefined,
): PseudonymLimits | null {
  if (limits === undefined) return { ...DEFAULT_LIMITS };
  if (typeof limits !== "object" || limits === null) return null;
  const resolved = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof PseudonymLimits>) {
    const provided = (limits as Partial<PseudonymLimits>)[key];
    if (provided === undefined) continue;
    if (!isPositiveSafeInt(provided)) return null;
    resolved[key] = provided;
  }
  return resolved;
}

interface Span {
  start: number;
  end: number;
}

function spansOverlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function containedInSpan(inner: Span, outer: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function containedInAnySpan(inner: Span, spans: Span[]): boolean {
  return spans.some((outer) => containedInSpan(inner, outer));
}

// ─── Registry ────────────────────────────────────────────────────────────────

interface SessionMaps {
  epoch: string;
  counter: number;
  forward: Map<string, string>; // exact original -> token
  reverse: Map<string, string>; // token -> exact original
  entries: number;
  units: number; // includes sessionId charge for fresh sessions
}

/**
 * One atomic protect transaction. Staging copies the live maps (bounded by
 * maxEntriesPerSession), is charged against every budget BEFORE publication,
 * and is published only when the whole operation has been verified.
 */
interface Transaction {
  registry: RegistryState;
  sessionId: string;
  live: SessionMaps | undefined;
  staged: SessionMaps | undefined;
  baseline: { entries: number; units: number };
  detectedOriginals: Set<string>;
  outputStrings: string[];
}

// ─── Token occurrence scanning ───────────────────────────────────────────────

/**
 * Finds registered token spans. Strict callers reject every malformed or
 * unowned marker; model-text callers may leave those occurrences literal.
 */
function scanOwnedTokenSpans(
  text: string,
  isOwned: (token: string) => boolean,
  preserveUnknown = false,
): { ok: true; spans: Span[] } | PseudonymFailure {
  const spans: Span[] = [];
  let at = text.indexOf(PSEUDONYM_TOKEN_PREFIX);
  while (at !== -1) {
    TOKEN_SHAPE.lastIndex = at;
    const match = TOKEN_SHAPE.exec(text);
    if (match === null) {
      if (!preserveUnknown) return fail("malformed_token");
      const nextPrefix = text.indexOf(PSEUDONYM_TOKEN_PREFIX, at + PSEUDONYM_TOKEN_PREFIX.length);
      const close = text.indexOf("]", at + PSEUDONYM_TOKEN_PREFIX.length);
      at = nextPrefix !== -1 && (close === -1 || nextPrefix < close)
        ? nextPrefix
        : text.indexOf(PSEUDONYM_TOKEN_PREFIX, close === -1 ? text.length : close + 1);
      continue;
    }
    const end = at + match[0].length;
    if (!isOwned(match[0])) {
      if (!preserveUnknown) return fail("unknown_token");
      at = text.indexOf(PSEUDONYM_TOKEN_PREFIX, end);
      continue;
    }
    spans.push({ start: at, end });
    at = text.indexOf(PSEUDONYM_TOKEN_PREFIX, end);
  }
  return { ok: true, spans };
}

// ─── Scanner plumbing ────────────────────────────────────────────────────────

/** The model boundary never honors in-text ignore directives. */
const MODEL_BOUNDARY_SCAN: ScanOptions = { honorIgnoreDirectives: false };

type RawScanOutcome = { ok: true; original: ScanResult } | PseudonymFailure;

function rawScan(text: string, config: GuardConfig): RawScanOutcome {
  try {
    return { ok: true, original: scanTextInternal(text, config, MODEL_BOUNDARY_SCAN) };
  } catch {
    return fail("scanner_failure");
  }
}

/**
 * Decoding hazards of ONE non-token segment, scanned strictly in isolation.
 * Any truncated scanned representation or any decoded sensitive finding
 * fails closed with a static reason.
 */
function segmentDecodingHazard(segment: string, config: GuardConfig): PseudonymFailure | null {
  if (segment.length === 0) return null;
  try {
    const scan = scanTextWithDecoding(segment, config, MODEL_BOUNDARY_SCAN);
    if (scan.original.was_truncated) return fail("truncated_content");
    for (const decoded of scan.decoded) {
      if (decoded.was_truncated) return fail("truncated_content");
    }
    // `decoded` results only exist when a decoded representation was unsafe,
    // i.e. encoded sensitive content was detected in this segment.
    if (scan.decoded.length > 0) return fail("encoded_content");
    return null;
  } catch {
    return fail("scanner_failure");
  }
}

// Percent-run detector identical to the generic decoder's URL detection
// (src/scanner/encoding.ts detectUrlEncoding), evaluated over the FULL text
// so candidate discovery matches exactly; only decoding differs below.
const URL_PERCENT_RUN = /(?:%[0-9A-Fa-f]{2}){1,}/g;
const URL_CONTEXT_UNITS = 50;

/**
 * URL-decoded context hazard across validated owned tokens — the seam
 * per-segment decoding cannot cover. The generic decoder URL-decodes a
 * window of up to 50 units before and after every percent run of the WHOLE
 * text; that is exactly how a percent-encoded marker plus text inside an
 * issued token forms a sensitive match ACROSS the token. This private check
 * re-evaluates those windows without ever decoding token interiors:
 *
 * - Only windows intersecting a validated owned-token span are examined. A
 *   window intersecting no token lies wholly inside one non-token segment,
 *   where segmentDecodingHazard already decodes it with identical bounds.
 * - The window is split at token boundaries. Owned-token fragments are
 *   retained VERBATIM (a clipped fragment's ownership derives from the full
 *   validated token in the source, never from a grammar lookalike) and only
 *   the separate non-token pieces are decoded with the exact tryDecodeUrl
 *   transform, decodeURIComponent(piece.replace(/\+/g, " ")). Token grammar
 *   contains no "%" or "+", so no percent run can cross a fragment and the
 *   separately decoded pieces equal whole-window decoding of the
 *   user-authored parts without decoding the token as content. Token-free
 *   gaps are never concatenated with each other.
 * - The reassembled changed representation is scanned ONCE with the raw
 *   direct scanner (no recursive decoding) and truncation is enforced.
 *   Each retained fragment's decoded-coordinate range is tracked; findings
 *   wholly inside a fragment are that token's own interior and are exempt
 *   BEFORE any overlap consideration, exactly like the full-text seam.
 *   Every other finding — crossing matches and suspicious-Unicode
 *   synthetics included — fails encoded_content; malformed ordinary spans
 *   fail statically. Decoded offsets are never mapped back to the source.
 * - URIError in any piece skips the whole candidate, matching the existing
 *   decoder's null return; unexpected exceptions fail scanner_failure.
 *
 * Bounds: candidates come from the source text itself (URI decoding never
 * expands UTF-16 length beyond its piece), windows are processed
 * sequentially with a monotonically advanced token cursor (window starts
 * never move backwards), and each reassembled scan covers at most the
 * percent run plus 100 units.
 */
function urlContextHazard(
  text: string,
  config: GuardConfig,
  tokenSpans: readonly Span[],
): PseudonymFailure | null {
  if (tokenSpans.length === 0) return null;
  URL_PERCENT_RUN.lastIndex = 0;
  let tokenCursor = 0;
  for (
    let run = URL_PERCENT_RUN.exec(text);
    run !== null;
    run = URL_PERCENT_RUN.exec(text)
  ) {
    const winStart = Math.max(0, run.index - URL_CONTEXT_UNITS);
    const winEnd = Math.min(text.length, run.index + run[0].length + URL_CONTEXT_UNITS);
    // Window starts are non-decreasing, so spans ending at or before this
    // window's start can never intersect a later window: advance past them.
    while (tokenCursor < tokenSpans.length && tokenSpans[tokenCursor].end <= winStart) {
      tokenCursor += 1;
    }
    // Fragment of every validated token intersecting the window.
    const fragments: Span[] = [];
    for (let i = tokenCursor; i < tokenSpans.length && tokenSpans[i].start < winEnd; i += 1) {
      const span = tokenSpans[i];
      if (span.end > winStart) {
        fragments.push({ start: Math.max(span.start, winStart), end: Math.min(span.end, winEnd) });
      }
    }
    if (fragments.length === 0) continue; // covered by segment decoding

    const ownedRanges: Array<Span> = []; // decoded-coordinate fragment ranges
    let reassembled: string;
    try {
      const pieces: string[] = [];
      let decodedUnits = 0;
      let pos = winStart;
      for (const fragment of fragments) {
        if (fragment.start > pos) {
          const decoded = decodeURIComponent(
            text.slice(pos, fragment.start).replace(/\+/g, " "),
          );
          pieces.push(decoded);
          decodedUnits += decoded.length;
        }
        pieces.push(text.slice(fragment.start, fragment.end));
        ownedRanges.push({ start: decodedUnits, end: decodedUnits + (fragment.end - fragment.start) });
        decodedUnits += fragment.end - fragment.start;
        pos = fragment.end;
      }
      if (pos < winEnd) {
        const decoded = decodeURIComponent(text.slice(pos, winEnd).replace(/\+/g, " "));
        pieces.push(decoded);
        decodedUnits += decoded.length;
      }
      reassembled = pieces.join("");
    } catch (error) {
      if (error instanceof URIError) continue; // skip whole candidate, like tryDecodeUrl
      return fail("scanner_failure");
    }

    let scan: ScanResult;
    try {
      scan = scanTextInternal(reassembled, config, MODEL_BOUNDARY_SCAN);
    } catch {
      return fail("scanner_failure");
    }
    if (scan.was_truncated) return fail("truncated_content");
    for (const finding of scan.findings) {
      if ((finding as { unicode_detected?: unknown }).unicode_detected !== undefined) {
        return fail("encoded_content");
      }
      const start = finding.match_start;
      const end = finding.match_end;
      const matched = finding.match_text;
      if (
        typeof start !== "number" || typeof end !== "number" || typeof matched !== "string" ||
        !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || start >= end || end > reassembled.length ||
        reassembled.slice(start, end) !== matched
      ) {
        return fail("invalid_finding_span");
      }
      // Token interior in the changed representation: exempt before overlap.
      if (containedInAnySpan({ start, end }, ownedRanges)) continue;
      // Everything else, including matches crossing a retained fragment,
      // is decoded sensitive content.
      return fail("encoded_content");
    }
  }
  return null;
}

/**
 * The model-boundary scan seam. The RAW DIRECT scanner runs over the FULL
 * string — including validated token spans — so findings that CROSS a token
 * boundary keep their full-text offsets. The URL-context hazard re-examines
 * the decoder's percent-run windows that cross validated tokens, retaining
 * token fragments verbatim while decoding the surrounding pieces. Decoding
 * then runs over each separate non-token segment: an issued token's epoch
 * hex is never decoded as user-encoded content, and no encoding candidate
 * is ever formed across a token gap (token delimiters break every candidate
 * run anyway, so no genuine user-side candidate is lost by splitting). With
 * no owned tokens this is exactly the historical whole-text scan-then-decode
 * behavior. `tokenSpans` must come from scanOwnedTokenSpans (ascending,
 * disjoint) and must already be strictly validated BEFORE this scan runs.
 * Input scan and output verification rescan share this seam.
 */
function scanForModelBoundary(
  text: string,
  config: GuardConfig,
  tokenSpans: readonly Span[],
): RawScanOutcome {
  const direct = rawScan(text, config);
  if (!direct.ok) return direct;
  // Full-text truncation is checked on the whole string, independent of any
  // per-segment accounting.
  if (direct.original.was_truncated) return fail("truncated_content");
  const urlHazard = urlContextHazard(text, config, tokenSpans);
  if (urlHazard !== null) return urlHazard;
  let cursor = 0;
  for (const span of tokenSpans) {
    if (span.start > cursor) {
      const hazard = segmentDecodingHazard(text.slice(cursor, span.start), config);
      if (hazard !== null) return hazard;
    }
    cursor = span.end;
  }
  if (cursor < text.length) {
    const hazard = segmentDecodingHazard(text.slice(cursor), config);
    if (hazard !== null) return hazard;
  }
  return direct;
}

/**
 * Validates finding spans against the exact text: integer UTF-16 offsets,
 * in-range, and slice(start,end) === match_text. Synthetic spans (the engine's
 * suspicious-Unicode whole-text finding) are rejected outright. Identical
 * spans from different rules are deduplicated. Overlap rejection is
 * deliberately NOT performed here: callers must first exempt findings
 * wholly inside strictly validated owned tokens (an issued token's interior
 * may legitimately contain overlapping custom-rule matches), and only then
 * reject every remaining overlap.
 */
function validateFindingSpans(
  text: string,
  findings: readonly Finding[],
): { ok: true; spans: Array<Span & { value: string }> } | PseudonymFailure {
  const spans: Array<Span & { value: string }> = [];
  for (const finding of findings) {
    if ((finding as { unicode_detected?: unknown }).unicode_detected !== undefined) {
      return fail("invalid_finding_span");
    }
    const start = finding.match_start;
    const end = finding.match_end;
    const matched = finding.match_text;
    if (
      typeof start !== "number" || typeof end !== "number" || typeof matched !== "string" ||
      !Number.isInteger(start) || !Number.isInteger(end) ||
      start < 0 || start >= end || end > text.length ||
      text.slice(start, end) !== matched
    ) {
      return fail("invalid_finding_span");
    }
    spans.push({ start, end, value: matched });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const deduped: Array<Span & { value: string }> = [];
  for (const span of spans) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.start === span.start && previous.end === span.end) continue;
    deduped.push(span);
  }
  return { ok: true, spans: deduped };
}

/** Every occurrence of `original` must sit inside a validated token span. */
function absenceHolds(text: string, original: string, tokenSpans: Span[]): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(original, from);
    if (at === -1) return true;
    if (!containedInAnySpan({ start: at, end: at + original.length }, tokenSpans)) return false;
    from = at + 1;
  }
}

// ─── Protect pipeline (per string, inside a transaction) ─────────────────────

/**
 * Protects one string inside a transaction. `chargedUnits` is the UTF-16-unit
 * amount already charged against limits.maxUnitsPerOperation for this
 * operation INCLUDING this input string (text.length for the text entry
 * point, the walk's aggregate budget for JSON strings/keys), so the combined
 * input+output charge is enforced exactly once and before materialization.
 */
function protectStringTx(
  tx: Transaction,
  config: GuardConfig,
  limits: PseudonymLimits,
  text: string,
  chargedUnits: number,
  preserveUnknownMarkers = false,
): PseudonymTextResult {
  // Per-string scanner bound: the scanner truncates beyond max_chars, which
  // this core must never accept, so reject before scanning.
  if (text.length > config.settings.max_chars) return fail("truncated_content");

  // Registered tokens are identified before scanning. Strict tool-facing
  // callers reject unknown/malformed markers; model-facing callers keep them
  // literal and scan their contents as ordinary text without exempting them.
  const owned = scanOwnedTokenSpans(
    text,
    (token) => tx.live?.reverse.get(token) !== undefined || tx.staged?.reverse.get(token) !== undefined,
    preserveUnknownMarkers,
  );
  if (!owned.ok) return owned;

  // Raw direct scan over the FULL string (cross-boundary findings keep
  // full-text offsets); decoding runs only over each separate non-token
  // segment, so issued-token epochs are never decoded as user content,
  // while URL-context windows crossing tokens are checked with the token
  // fragments retained verbatim (see scanForModelBoundary).
  const scanned = scanForModelBoundary(text, config, owned.spans);
  if (!scanned.ok) return scanned;

  const collected = validateFindingSpans(text, scanned.original.findings);
  if (!collected.ok) return collected;

  const actionable: Array<Span & { value: string }> = [];
  for (const span of collected.spans) {
    // Findings wholly inside a previously validated owned token are that
    // token's own interior (e.g. overlapping custom rules matching the
    // counter digits): already pseudonymized. Exempt them BEFORE overlap
    // rejection — substituting inside a token would corrupt it — exactly
    // like the output-side check below.
    if (containedInAnySpan(span, owned.spans)) continue;
    const previous = actionable[actionable.length - 1];
    if (previous && span.start < previous.end) return fail("overlapping_findings");
    // Crossing matches (partially overlapping a token) stay fail-closed.
    if (owned.spans.some((tokenSpan) => spansOverlap(span, tokenSpan))) {
      return fail("token_overlap");
    }
    tx.detectedOriginals.add(span.value);
    actionable.push(span);
  }

  // Stage every mapping first (charging all budgets), then substitute.
  const stagedSpans: Array<Span & { token: string }> = [];
  for (const span of actionable) {
    const staged = stageToken(tx, limits, span.value);
    if (!staged.ok) return staged;
    stagedSpans.push({ start: span.start, end: span.end, token: staged.token });
  }

  // Pre-allocation operation guard: the exact prospective substituted
  // output length follows from the validated disjoint spans and the staged
  // fixed tokens (spans never overlap, so each substitution contributes
  // token.length - span length). Refuse BEFORE any substituted string is
  // built or rescanned; a failed transaction below rolls the staged
  // mappings back completely (no committed capacity, counter or epoch).
  let prospectiveUnits = text.length;
  for (const staged of stagedSpans) {
    prospectiveUnits += staged.token.length - (staged.end - staged.start);
  }
  if (chargedUnits + prospectiveUnits > limits.maxUnitsPerOperation) {
    return fail("operation_limit");
  }

  // Assemble the output once from checked pieces instead of repeated
  // large-slice concatenations.
  const pieces: string[] = [];
  let cursor = 0;
  for (const staged of stagedSpans) {
    if (cursor < staged.start) pieces.push(text.slice(cursor, staged.start));
    pieces.push(staged.token);
    cursor = staged.end;
  }
  if (cursor < text.length) pieces.push(text.slice(cursor));
  const substituted = pieces.join("");

  // Rescan the substituted output (defense in depth against engine collapse).
  // Current/staged issued tokens are validated FIRST and never decoded as
  // user content; the shared scanForModelBoundary seam also re-examines
  // URL-context windows the replacement may have pulled a token into.
  // Every remaining finding must live fully inside a validated token.
  // Crossing findings and any residual content are rejected.
  const outTokens = scanOwnedTokenSpans(
    substituted,
    (token) => tx.live?.reverse.get(token) !== undefined || tx.staged?.reverse.get(token) !== undefined,
    preserveUnknownMarkers,
  );
  if (!outTokens.ok) return outTokens;
  const rescan = scanForModelBoundary(substituted, config, outTokens.spans);
  if (!rescan.ok) return rescan;
  const rescanSpans = validateFindingSpans(substituted, rescan.original.findings);
  if (!rescanSpans.ok) return rescanSpans;
  for (const span of rescanSpans.spans) {
    if (!containedInAnySpan(span, outTokens.spans)) return fail("residual_sensitive_content");
  }

  // Independent absence check of every detected original outside validated
  // owned tokens (covers key/value strings for JSON operations too).
  for (const original of tx.detectedOriginals) {
    if (!absenceHolds(substituted, original, outTokens.spans)) {
      return fail("residual_sensitive_content");
    }
  }

  return { ok: true, text: substituted };
}

function stageToken(
  tx: Transaction,
  limits: PseudonymLimits,
  original: string,
): { ok: true; token: string } | PseudonymFailure {
  const existing = tx.staged?.forward.get(original) ?? tx.live?.forward.get(original);
  if (existing !== undefined) return { ok: true, token: existing }; // idempotent reuse

  if (tx.staged === undefined) {
    if (tx.live === undefined && tx.registry.sessions.size >= limits.maxSessions) {
      return fail("session_limit");
    }
    // Fresh 128-bit epoch per session creation; existing sessions keep theirs.
    const epoch = tx.live ? tx.live.epoch : randomBytes(EPOCH_HEX_CHARS / 2).toString("hex");
    if (tx.live === undefined && tx.registry.epochs.has(epoch)) {
      return fail("epoch_collision"); // bounded fail-closed, no retry loop
    }
    tx.staged = {
      epoch,
      counter: tx.live?.counter ?? 0,
      forward: new Map(tx.live?.forward),
      reverse: new Map(tx.live?.reverse),
      entries: tx.live?.entries ?? 0,
      units: tx.live?.units ?? 0,
    };
    tx.baseline = { entries: tx.staged.entries, units: tx.staged.units };
    if (tx.live === undefined) {
      // Session identity is charged once, when the session is first committed.
      if (tx.sessionId.length > limits.maxSessionUnits) return fail("session_capacity");
      tx.staged.units += tx.sessionId.length;
    }
  }

  const staged = tx.staged;
  const counter = staged.counter + 1;
  const token = `${PSEUDONYM_TOKEN_PREFIX}${staged.epoch}-${String(counter).padStart(COUNTER_PAD, "0")}]`;
  if (staged.reverse.has(token) || tx.live?.reverse.has(token)) return fail("token_collision");

  const entryUnits = original.length + token.length + ENTRY_OVERHEAD_UNITS;
  if (staged.entries + 1 > limits.maxEntriesPerSession) return fail("entry_limit");
  if (staged.units + entryUnits > limits.maxSessionUnits) return fail("session_capacity");
  const totalEntriesAfter = tx.registry.totalEntries + (staged.entries - tx.baseline.entries) + 1;
  if (totalEntriesAfter > limits.maxEntriesTotal) return fail("aggregate_capacity");
  const totalUnitsAfter =
    tx.registry.totalUnits + (staged.units - tx.baseline.units) + entryUnits;
  if (totalUnitsAfter > limits.maxUnitsTotal) return fail("aggregate_capacity");

  staged.forward.set(original, token);
  staged.reverse.set(token, original);
  staged.counter = counter;
  staged.entries += 1;
  staged.units += entryUnits;
  return { ok: true, token };
}

function commitTransaction(tx: Transaction): void {
  const staged = tx.staged;
  if (staged === undefined) return; // safe plaintext never consumes a session
  tx.registry.sessions.set(tx.sessionId, staged);
  tx.registry.epochs.add(staged.epoch);
  tx.registry.totalEntries += staged.entries - tx.baseline.entries;
  tx.registry.totalUnits += staged.units - tx.baseline.units;
}

// ─── Restore pipeline (no registry mutation, all-or-nothing) ─────────────────

/**
 * Replaces registered tokens with their exact original. Strict tool callers
 * reject unknown markers; display callers retain them as literals. `chargedUnits`
 * is the UTF-16-unit amount already charged against limits.maxUnitsPerOperation for
 * this operation INCLUDING the input string itself (text.length for the text
 * entry point, the walk's aggregate budget for JSON strings/keys), so the
 * combined input+output charge is enforced exactly once. Every literal and
 * replacement length is charged BEFORE the piece is appended, and the final
 * join happens only after the whole output is known to fit: an oversized
 * expansion is refused before it is materialized. Token-bearing inputs are
 * charged by their ACTUAL prospective replacement pieces — never by the
 * unchanged input length — so a shrinking restoration (a short original
 * recovered from a long token) is not refused for output it never produces.
 */
function restoreStringTx(
  live: SessionMaps | undefined,
  limits: PseudonymLimits,
  text: string,
  chargedUnits: number,
  preserveUnknownMarkers = false,
): PseudonymTextResult {
  // Token-free path: output === input, charged combined with the input
  // exactly like the replacement path (budget 10 must refuse "abcdef").
  if (text.indexOf(PSEUDONYM_TOKEN_PREFIX) === -1) {
    if (chargedUnits + text.length > limits.maxUnitsPerOperation) {
      return fail("operation_limit");
    }
    return { ok: true, text };
  }

  const pieces: string[] = [];
  let outputUnits = 0;
  const appendPiece = (piece: string): PseudonymFailure | null => {
    if (chargedUnits + outputUnits + piece.length > limits.maxUnitsPerOperation) {
      return fail("operation_limit");
    }
    outputUnits += piece.length;
    pieces.push(piece);
    return null;
  };

  let from = 0;
  let at = text.indexOf(PSEUDONYM_TOKEN_PREFIX);
  while (at !== -1) {
    TOKEN_SHAPE.lastIndex = at;
    const match = TOKEN_SHAPE.exec(text);
    const token = match?.[0];
    const original = token === undefined ? undefined : live?.reverse.get(token);
    if (token === undefined || original === undefined) {
      if (!preserveUnknownMarkers) return fail(token === undefined ? "malformed_token" : "unknown_token");
      const nextPrefix = text.indexOf(PSEUDONYM_TOKEN_PREFIX, at + PSEUDONYM_TOKEN_PREFIX.length);
      const close = text.indexOf("]", at + PSEUDONYM_TOKEN_PREFIX.length);
      const end = token !== undefined
        ? at + token.length
        : nextPrefix !== -1 && (close === -1 || nextPrefix < close)
          ? nextPrefix
          : close === -1
            ? text.length
            : close + 1;
      const literalFailed = appendPiece(text.slice(from, end));
      if (literalFailed !== null) return literalFailed;
      from = end;
      at = text.indexOf(PSEUDONYM_TOKEN_PREFIX, from);
      continue;
    }
    const literalFailed = appendPiece(text.slice(from, at));
    if (literalFailed !== null) return literalFailed;
    const replacementFailed = appendPiece(original);
    if (replacementFailed !== null) return replacementFailed;
    from = at + token.length;
    at = text.indexOf(PSEUDONYM_TOKEN_PREFIX, from);
  }
  const tailFailed = appendPiece(text.slice(from));
  if (tailFailed !== null) return tailFailed;
  return { ok: true, text: pieces.join("") };
}

// ─── Strict-JSON traversal ───────────────────────────────────────────────────

interface WalkBudget {
  nodes: number;
  units: number;
}

type StringTransform = (text: string) => PseudonymTextResult;

const INDEX_KEY = /^(0|[1-9][0-9]*)$/;

/**
 * Descriptor-based strict-JSON walk. Accepts only strings, finite numbers,
 * booleans, null, dense arrays and plain/null-prototype objects. Rejects
 * proxies (checked with types.isProxy BEFORE any reflective traversal so no
 * trap fires), accessors (without invoking them), symbol keys, cycles, sparse
 * arrays, unexpected array properties, and unsupported types. Builds fresh
 * outputs via Object.defineProperty (safe for `__proto__` keys); never mutates
 * the input. Shared non-cyclic references are cloned again.
 */
function walkStrictJson(
  value: unknown,
  depth: number,
  path: Set<object>,
  budget: WalkBudget,
  limits: PseudonymLimits,
  transform: StringTransform,
): PseudonymJsonResult {
  budget.nodes += 1;
  budget.units += NODE_OVERHEAD_UNITS;
  if (budget.nodes > limits.maxNodes || budget.units > limits.maxUnitsPerOperation) {
    return fail("operation_limit");
  }
  if (depth > limits.maxDepth) return fail("operation_limit");

  if (typeof value === "string") {
    budget.units += value.length;
    if (budget.units > limits.maxUnitsPerOperation) return fail("operation_limit");
    const transformed = transform(value);
    if (!transformed.ok) return transformed;
    budget.units += transformed.text.length;
    if (budget.units > limits.maxUnitsPerOperation) return fail("operation_limit");
    return { ok: true, value: transformed.text };
  }
  if (value === null || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return fail("unsafe_structure");
    return { ok: true, value };
  }
  if (typeof value !== "object") return fail("unsafe_structure"); // undefined/bigint/function/symbol
  if (types.isProxy(value)) return fail("unsafe_structure");
  if (path.has(value)) return fail("unsafe_structure"); // cycle

  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") return fail("unsafe_structure");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return fail("unsafe_structure");
    }
  }

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return fail("unsafe_structure");
    const length = value.length;
    if (length > limits.maxNodes) return fail("operation_limit");
    const indexKeys = keys.filter((key) => key !== "length");
    if (indexKeys.length !== length) {
      return fail("unsafe_structure"); // sparse array and/or unexpected properties
    }
    for (const key of indexKeys as string[]) {
      // Canonical own indices only: reject "01", out-of-range, or extra props.
      if (!INDEX_KEY.test(key) || Number(key) >= length) return fail("unsafe_structure");
    }
    path.add(value);
    const output: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = walkStrictJson(value[i], depth + 1, path, budget, limits, transform);
      if (!item.ok) return item;
      output.push(item.value);
    }
    path.delete(value);
    return { ok: true, value: output };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("unsafe_structure");

  path.add(value);
  const output: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  for (const key of keys as string[]) {
    budget.units += key.length;
    if (budget.units > limits.maxUnitsPerOperation) return fail("operation_limit");
    const transformedKey = transform(key);
    if (!transformedKey.ok) return transformedKey;
    budget.units += transformedKey.text.length;
    if (budget.units > limits.maxUnitsPerOperation) return fail("operation_limit");
    if (seenKeys.has(transformedKey.text)) return fail("key_collision");
    seenKeys.add(transformedKey.text);
    const item = walkStrictJson(
      (value as Record<string, unknown>)[key],
      depth + 1,
      path,
      budget,
      limits,
      transform,
    );
    if (!item.ok) return item;
    Object.defineProperty(output, transformedKey.text, {
      value: item.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  path.delete(value);
  return { ok: true, value: output };
}

// ─── Service assembly ────────────────────────────────────────────────────────

interface RegistryState {
  sessions: Map<string, SessionMaps>;
  epochs: Set<string>;
  totalEntries: number;
  totalUnits: number;
}

function buildService(config: GuardConfig, limits: PseudonymLimits): PseudonymizerService {
  const registry: RegistryState = {
    sessions: new Map(),
    epochs: new Set(),
    totalEntries: 0,
    totalUnits: 0,
  };

  const newTransaction = (sessionId: string): Transaction => ({
    registry,
    sessionId,
    live: registry.sessions.get(sessionId),
    staged: undefined,
    baseline: { entries: 0, units: 0 },
    detectedOriginals: new Set(),
    outputStrings: [],
  });

  const isTextSafe = (text: string): boolean => {
    if (typeof text !== "string" || text.length > limits.maxUnitsPerOperation) return false;
    try {
      const result = scanForModelBoundary(text, config, []);
      return result.ok && result.original.safe;
    } catch {
      return false;
    }
  };

  const protectTextWithPolicy = (
    sessionId: string,
    text: string,
    preserveUnknownMarkers: boolean,
  ): PseudonymTextResult => {
    if (!isValidSessionId(sessionId)) return fail("invalid_session");
    if (typeof text !== "string") return fail("invalid_input");
    if (text.length > limits.maxUnitsPerOperation) return fail("operation_limit");
    try {
      const tx = newTransaction(sessionId);
      const result = protectStringTx(tx, config, limits, text, text.length, preserveUnknownMarkers);
      if (!result.ok) return result;
      if (text.length + result.text.length > limits.maxUnitsPerOperation) {
        return fail("operation_limit");
      }
      commitTransaction(tx);
      return result;
    } catch {
      return fail("internal_failure");
    }
  };

  const protectText = (sessionId: string, text: string): PseudonymTextResult =>
    protectTextWithPolicy(sessionId, text, false);
  const protectTextForModel = (sessionId: string, text: string): PseudonymTextResult =>
    protectTextWithPolicy(sessionId, text, true);

  const restoreTextWithPolicy = (
    sessionId: string,
    text: string,
    preserveUnknownMarkers: boolean,
  ): PseudonymTextResult => {
    if (!isValidSessionId(sessionId)) return fail("invalid_session");
    if (typeof text !== "string") return fail("invalid_input");
    if (text.length > limits.maxUnitsPerOperation) return fail("operation_limit");
    try {
      return restoreStringTx(
        registry.sessions.get(sessionId),
        limits,
        text,
        text.length,
        preserveUnknownMarkers,
      );
    } catch {
      return fail("internal_failure");
    }
  };

  const restoreText = (sessionId: string, text: string): PseudonymTextResult =>
    restoreTextWithPolicy(sessionId, text, false);
  const restoreTextForDisplay = (sessionId: string, text: string): PseudonymTextResult =>
    restoreTextWithPolicy(sessionId, text, true);

  const protectJsonWithPolicy = (
    sessionId: string,
    value: unknown,
    preserveUnknownMarkers: boolean,
  ): PseudonymJsonResult => {
    if (!isValidSessionId(sessionId)) return fail("invalid_session");
    try {
      const tx = newTransaction(sessionId);
      const budget: WalkBudget = { nodes: 0, units: 0 };
      const result = walkStrictJson(value, 0, new Set(), budget, limits, (text) => {
        const protectedString = protectStringTx(tx, config, limits, text, budget.units, preserveUnknownMarkers);
        if (protectedString.ok) tx.outputStrings.push(protectedString.text);
        return protectedString;
      });
      if (!result.ok) return result;
      for (const outputString of tx.outputStrings) {
        const tokenSpans = scanOwnedTokenSpans(
          outputString,
          (token) => tx.live?.reverse.get(token) !== undefined || tx.staged?.reverse.get(token) !== undefined,
          preserveUnknownMarkers,
        );
        if (!tokenSpans.ok) return tokenSpans;
        for (const original of tx.detectedOriginals) {
          if (!absenceHolds(outputString, original, tokenSpans.spans)) {
            return fail("residual_sensitive_content");
          }
        }
      }
      commitTransaction(tx);
      return result;
    } catch {
      return fail("internal_failure");
    }
  };

  const protectJson = (sessionId: string, value: unknown): PseudonymJsonResult =>
    protectJsonWithPolicy(sessionId, value, false);
  const protectJsonForModel = (sessionId: string, value: unknown): PseudonymJsonResult =>
    protectJsonWithPolicy(sessionId, value, true);

  const restoreJson = (sessionId: string, value: unknown): PseudonymJsonResult => {
    if (!isValidSessionId(sessionId)) return fail("invalid_session");
    try {
      const budget: WalkBudget = { nodes: 0, units: 0 };
      return walkStrictJson(value, 0, new Set(), budget, limits, (text) =>
        restoreStringTx(registry.sessions.get(sessionId), limits, text, budget.units));
    } catch {
      return fail("internal_failure");
    }
  };

  const clearSession = (sessionId: string): void => {
    if (!isValidSessionId(sessionId)) return; // idempotent, never throws
    const session = registry.sessions.get(sessionId);
    if (session === undefined) return;
    registry.sessions.delete(sessionId);
    registry.epochs.delete(session.epoch);
    registry.totalEntries -= session.entries;
    registry.totalUnits -= session.units;
  };

  return {
    isTextSafe,
    protectText,
    protectTextForModel,
    restoreText,
    restoreTextForDisplay,
    protectJson,
    protectJsonForModel,
    restoreJson,
    clearSession,
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a synchronous, in-memory pseudonymizer service. The factory itself
 * only fails on statically invalid arguments (malformed config or limits) with
 * the single static reason "STATIC_CODE"; per-operation failures use their own
 * static reasons. The result spreads the service methods, so no `this` binding
 * is required.
 */
export function createPseudonymizer(
  config: GuardConfig,
  limits?: Partial<PseudonymLimits>,
): CreatePseudonymizerResult {
  if (!isValidConfigShape(config)) return { ok: false, reason: "STATIC_CODE" };
  // Snapshot the caller config so the trusted-caller boundary stays durable
  // after construction; re-validate so a snapshot that could not carry the
  // validated fields fails statically instead of dropping protection.
  const snapshot = snapshotConfig(config);
  if (snapshot === null || !isValidConfigShape(snapshot)) {
    return { ok: false, reason: "STATIC_CODE" };
  }
  const resolved = resolveLimits(limits);
  if (resolved === null) return { ok: false, reason: "STATIC_CODE" };
  try {
    return { ok: true as const, ...buildService(snapshot, resolved) };
  } catch {
    return { ok: false, reason: "STATIC_CODE" };
  }
}

/**
 * Structural-string collection for JSON Schema subtrees, shared by the
 * session-layer request guard (src/opencode-transparent.ts) and the wire-layer
 * remaskers (src/opencode-transparent-http.ts) so the pre-mask safety check
 * and the post-mask identity comparison can never drift apart.
 *
 * Structural identifiers (tool names, property keys, enum/const values, regex
 * patterns) must survive masking verbatim: a sensitive or token-bearing one
 * refuses the whole request rather than being silently renamed. Schema
 * ANNOTATION values (`description`, `title` — human prose a provider never
 * dispatches on) are deliberately NOT structural: they are protected as
 * ordinary content leaves, so a scanner hit inside a tool-schema description
 * masks to a pseudonym token instead of failing the request. Fail-closed is
 * unchanged for every identifier position.
 */

/** JSON Schema annotation keywords whose VALUES are prose, not identifiers. */
export const SCHEMA_ANNOTATION_KEYS: ReadonlySet<string> = new Set(["description", "title"]);

/**
 * Keys and identifier values of a schema/metadata subtree, in stable walk
 * order. Annotation-key VALUES are skipped (the key itself is still pushed so
 * both sides of the before/after comparison see the same collection).
 */
export function walkSchemaStrings(out: string[], value: unknown): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkSchemaStrings(out, item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    out.push(key);
    if (SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    walkSchemaStrings(out, record[key]);
  }
}

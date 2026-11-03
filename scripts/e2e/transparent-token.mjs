/** Either shape of a reserved token, as defined in src/decision/pseudonymization.ts. */
export const TRANSPARENT_TOKEN =
  /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/;

/**
 * Whether text carries a token the plugin could have minted. A case's literal
 * marker fixtures are valid-shaped on purpose and must not count as protection.
 */
export function hasTransparentToken(text, literals = []) {
  const remaining = literals.reduce((current, literal) => current.split(literal).join(""), text);
  return TRANSPARENT_TOKEN.test(remaining);
}

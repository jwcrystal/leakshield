import { z } from "zod";

// zod 4's z.object() accepts any non-array object (Date, Map, Uint8Array...) and
// returns its defaults, so a YAML timestamp or !!binary would load as a valid
// config. Only mappings (plain objects) may reach the inner schema; `abort`
// stops later refinements from running on the raw value.
function isPlain(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function plainObject<T extends z.ZodType>(schema: T) {
  return z.custom<unknown>(isPlain, { error: "expected a mapping", abort: true }).pipe(schema);
}

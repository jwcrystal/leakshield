/**
 * IPv4 CIDR helpers for the private-range rule.
 *
 * Password-strength regex cannot express "address inside 172.16.0.0/12": a
 * pattern that covers the range also covers version strings, and one that is
 * narrow enough to avoid them misses octets. Membership is therefore a
 * numeric comparison, and the network list is validated when the config
 * loads so a typo cannot silently weaken the rule.
 */

/** Ranges the rule covers when `settings.private_cidrs` is empty. */
export const DEFAULT_PRIVATE_CIDRS: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
];

export interface Cidr {
  /** Network address, already masked. */
  base: number;
  /** Bit mask for the prefix length. */
  mask: number;
}

/** Dotted-quad to a 32-bit unsigned integer, or null when it is not an address. */
export function ipv4ToInt(raw: string): number | null {
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Parse `a.b.c.d/prefix`; returns null for anything else. */
export function parseCidr(text: string): Cidr | null {
  const parts = text.trim().split("/");
  if (parts.length !== 2) return null;
  const [address, prefixText] = parts;
  if (!/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > 32) return null;
  const addressValue = ipv4ToInt(address);
  if (addressValue === null) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (addressValue & mask) >>> 0, mask };
}

/** Parse a configured list, falling back to the documented defaults. */
export function parseCidrList(entries: readonly string[] | undefined): Cidr[] {
  const source = entries !== undefined && entries.length > 0 ? entries : DEFAULT_PRIVATE_CIDRS;
  const parsed: Cidr[] = [];
  for (const entry of source) {
    const cidr = parseCidr(entry);
    if (cidr !== null) parsed.push(cidr);
  }
  return parsed;
}

/** True when the dotted-quad address falls inside one of the networks. */
export function containsAddress(cidrs: readonly Cidr[], raw: string): boolean {
  const value = ipv4ToInt(raw);
  if (value === null) return false;
  return cidrs.some((cidr) => ((value & cidr.mask) >>> 0) === cidr.base);
}

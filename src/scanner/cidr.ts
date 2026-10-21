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

/**
 * Every four-octet window in a dotted run, in order.
 *
 * `10.1.2.3.4` is not an address, but it contains `1.2.3.4`. A regex finds
 * only the first four groups, so the runner is what keeps detection
 * consistent for the addresses hiding behind that prefix.
 */
export function ipv4Windows(raw: string): string[] {
  const parts = raw.split(".");
  const windows: string[] = [];
  for (let start = 0; start + 4 <= parts.length; start += 1) {
    windows.push(parts.slice(start, start + 4).join("."));
  }
  return windows;
}

/**
 * True when `raw` is inside one of the networks, including when it is a
 * dotted run longer than four octets: the run is reported whole if any of
 * its four-octet windows matches.
 */
export function containsAddressInRun(cidrs: readonly Cidr[], raw: string): boolean {
  const groups = raw.split(".").length;
  if (groups === 4) return containsAddress(cidrs, raw);
  if (groups > 4) return ipv4Windows(raw).some((window) => containsAddress(cidrs, window));
  return false;
}

/**
 * Transport-aware classification for email-shaped spans.
 *
 * A Git remote written the way SSH expects it (`user@host:path`) and the
 * userinfo of an authenticated URL (`scheme://user:password@host`) both
 * contain a `user@host` run that the email rule would happily report as PII.
 * Reporting it is wrong twice over: a public host gets pseudonymized for no
 * privacy gain, and the password half of a credential is labelled as personal
 * data instead of a secret.
 *
 * The classifier reads the first scheme of the whitespace-delimited run and
 * parses that URL's authority once. The scheme does not have to start the run,
 * so a wrapped URL (`{"url": "https://…"}`, `url=https://…`) is recognised.
 *
 * Every expansion is bounded. When a boundary cannot be proven within the
 * window the span is reported: an unproven exemption must never hide an
 * address. The scp fallback is not attempted in that case, because it would
 * turn a truncated run into an exemption.
 *
 * What it does NOT do: whitelist hosts, paths, files or commands. It only
 * tells the email rule that this span belongs to a different construct. Every
 * other rule still scans the same bytes.
 */

const SSH_SCHEMES = new Set(["ssh", "ssh+git", "git+ssh"]);

/** A run ends at whitespace; an authority cannot contain it. */
const RUN_BREAK = /\s/;

/** Characters that close an SSH host, but may appear inside a password. */
const FRAMING_BREAK = /["'`<>()[\]{}]/;

/** An SSH host is letters, digits, dot, dash, underscore, with an optional port. */
const SSH_HOST = /^[A-Za-z0-9._-]+(?::\d{1,5})?/;

/** An SSH user name; anything else means the `@` belongs to following prose. */
const SSH_USER = /^[A-Za-z0-9._-]+$/;

/** First character of an scp path. Excludes whitespace, quotes and brackets. */
const PATH_START = /[A-Za-z0-9._~\-/]/;

/** `host:2222` is a port, not an scp path; the lookahead covers `)` or EOL. */
const PORT_AFTER_COLON = /^\d{1,5}(?![A-Za-z0-9])/;

/**
 * A scheme name must not be preceded by another scheme character, otherwise
 * `123ssh://…` would be read as `ssh`.
 */
const SCHEME_BEFORE = /(?:^|[^A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*)$/;

/**
 * Bound on every expansion. A scheme, authority or token longer than this is
 * not a real remote; when the bound is hit without proof, report the span.
 */
const WINDOW = 512;

export type TransportSpan = "ssh-authority" | "url-credential";

/**
 * Start of the surrounding run, or null when its edge is farther than the
 * window. A truncated run cannot prove which URL encloses the candidate.
 */
function runStart(text: string, index: number): number | null {
  const floor = Math.max(0, index - WINDOW);
  let start = index;
  while (start > floor && !RUN_BREAK.test(text[start - 1])) start -= 1;
  if (start === 0) return 0;
  return RUN_BREAK.test(text[start - 1]) ? start : null;
}

/** Token start, or -1 when the token edge is farther than the window. */
function tokenStart(text: string, index: number): number {
  const floor = Math.max(0, index - WINDOW);
  let start = index;
  while (start > floor && !FRAMING_BREAK.test(text[start - 1]) && !RUN_BREAK.test(text[start - 1])) {
    start -= 1;
  }
  if (start === floor && floor > 0) {
    const previous = text[start - 1];
    if (!FRAMING_BREAK.test(previous) && !RUN_BREAK.test(previous)) return -1;
  }
  return start;
}

/** End of the authority: `/`, `?`, `#`, whitespace, or the window bound. */
function authorityLimit(text: string, authorityStart: number): number {
  const cap = Math.min(text.length, authorityStart + WINDOW);
  for (let at = authorityStart; at < cap; at += 1) {
    const char = text[at];
    if (char === "/" || char === "?" || char === "#" || RUN_BREAK.test(char)) return at;
  }
  return cap;
}

/**
 * Classify the span `text.slice(index, index + length)`, or return null when it
 * is an ordinary address that the email rule should keep reporting.
 */
export function classifyTransportSpan(
  text: string,
  index: number,
  length: number,
): TransportSpan | null {
  const start = runStart(text, index);
  // Unproven run boundary: report. Falling through to scp here would exempt an
  // address inside a URL whose start we could not see.
  if (start === null) return null;

  // The first scheme in the run owns it. A later `://` inside the path
  // (`https://a.example/(ssh://b/…)`) does not start a new remote.
  const marker = text.indexOf("://", start);
  if (marker >= 0 && marker < index) {
    const name = SCHEME_BEFORE.exec(text.slice(Math.max(start, marker - 32), marker));
    if (name !== null) {
      const scheme = name[1].toLowerCase();
      const authorityStart = marker + 3;
      const limit = authorityLimit(text, authorityStart);
      if (index < authorityStart || index >= limit) return null;

      const firstAt = text.indexOf("@", authorityStart);
      if (firstAt < 0 || firstAt >= limit) return null;

      // `user:password@` — punctuation is legal inside the password, so the
      // userinfo closes at the last `@` before the authority ends.
      const userinfo = text.slice(authorityStart, firstAt);
      if (userinfo.includes(":")) return "url-credential";

      if (!SSH_SCHEMES.has(scheme)) return null;
      // A host-only URL has no userinfo; the first `@` then belongs to the
      // prose after it. Only a plain SSH user name is accepted, so a separator
      // (em dash, quote, comma) leaves the following address reported.
      if (!SSH_USER.test(userinfo)) return null;
      // The exemption covers the host only. A whitelist of host characters is
      // deliberate: any other character ends the host.
      const host = SSH_HOST.exec(text.slice(firstAt + 1, limit));
      if (host === null) return null;
      return index < firstAt + 1 + host[0].length ? "ssh-authority" : null;
    }
  }

  // scp-like form. The address must open its token: `foo=user@host:path` is
  // left alone rather than guessed.
  const tokenEdge = tokenStart(text, index);
  if (tokenEdge !== index) return null;
  if (text[index + length] !== ":") return null;
  const after = text.slice(index + length + 1, index + length + 8);
  if (PORT_AFTER_COLON.test(after)) return null;
  const first = after[0];
  return first !== undefined && PATH_START.test(first) ? "ssh-authority" : null;
}

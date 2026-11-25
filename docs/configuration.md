# Configuration reference

[← README](../README.md#configuration) · 🌐 English | [繁體中文](configuration.zh-TW.md)

Where LeakShield looks for its config file, how to start one and when changes take effect are in the [README](../README.md#configuration). This page lists every key and rule.

## Fields

Every key is optional. A key you leave out keeps its default; an unknown key is ignored.

| Key | Default | What it does | Details |
|-----|---------|--------------|---------|
| `nda_keywords` | `CONFIDENTIAL`, `INTERNAL ONLY`, `DO NOT SHARE`, `NDA` | Words reported as HIGH. Case-insensitive. A keyword that starts and ends with an ASCII letter or digit matches whole words (`NDA` does not match `agenda`); a CJK keyword matches as a substring. A list replaces the defaults; `[]` turns keywords off | — |
| `private_domains` | none | Hostnames reported as MEDIUM. Case-insensitive substring match; a full hostname gives fewer false matches | — |
| `custom_rules` | none | Your own regular expressions with a `description`, `pattern` and `severity` (`HIGH` by default) | [Custom Rules](#custom-rules) |
| `settings.max_chars` | `200000` | Scan bound per input. The CLI scans the first `max_chars` characters; transparent mode refuses longer content instead of truncating it | — |
| `settings.show_line_numbers` | `true` | Include line and column in findings | — |
| `settings.preview_length` | `60` | Length of the masked `safePreview` excerpt around the first finding | [Secret Preview Behavior](cli.md#secret-preview-behavior) |
| `settings.encoding_detection` | `false` | Also decode Base64, URL and Hex text before scanning (the OpenCode plugin always enables it) | [Encoding Detection](cli.md#encoding-detection) |
| `settings.env_files` | none | Files whose values are matched exactly | [Exact `.env` Value Detection](#exact-env-value-detection) |
| `settings.rule_overrides` | `{}` | Turn built-in rules on or off by id, e.g. `{ url: true, email: false }`. An unknown id fails the load | [Built-in rule ids](#built-in-rule-ids) |
| `settings.private_cidrs` | RFC 1918, CGNAT, link-local | IPv4 networks the opt-in `private-ipv4` rule reports. A list **replaces** the defaults, for example to match only your VPN. An invalid CIDR fails the load | — |
| `settings.allowlist` | none | Exact values no rule reports. **A real bypass**: the value reaches the model unmasked | [Custom Rules](#custom-rules) |

Length and count limits are listed under [Configuration Validation](#configuration-validation).

## Built-in rule ids

Use these ids in `settings.rule_overrides`. All rules are on by default except the four opt-in rules marked below.

| Group | Ids |
|-------|-----|
| API keys and tokens | `openai-key`, `anthropic-key`, `google-key`, `aws-access-key`, `aws-secret`, `github-pat`, `github-fine-grained-pat`, `github-oauth-app`, `stripe-live-secret`, `stripe-live-publishable`, `slack-bot`, `slack-user-app`, `huggingface-token`, `jwt`, `generic-bearer` |
| Secrets and credentials | `generic-secret`, `pem-private-key`, `url-userinfo`, `db-connection`, `db-connection-ado` |
| Personal and financial data | `email`, `id-tw`, `credit-card`, `iban`, `public-ipv4`, `phone-tw` (opt-in), `phone-intl` (opt-in) |
| Network | `private-ipv4` (opt-in), `url` (opt-in) |

An example that keeps the default keywords, adds a private domain and turns on `private-ipv4` for one network:

```yaml
nda_keywords:
  - "CONFIDENTIAL"
  - "INTERNAL ONLY"
  - "DO NOT SHARE"
  - "NDA"
  # - "Project Phoenix"     # your own terms

private_domains:
  - "internal.example.com"

settings:
  encoding_detection: false
  rule_overrides:
    private-ipv4: true
  private_cidrs:
    - 10.20.0.0/16          # replaces the default private networks
```

## Exact `.env` Value Detection

Enable this only for files whose values should never enter an LLM context:

```yaml
settings:
  env_files:
    - .env
    - .env.local
```

Every entry point applies it: the OpenCode plugin, the pi extension, the Claude Code proxy, the CLI and the Web UI. Each one loads the guard config through `loadConfig()`, which builds the exact-value detector from `settings.env_files`, and the shared scanner uses that detector.

- **Paths** are relative to a root and must stay inside it. The OpenCode plugin uses the project directory. The pi extension, the Claude Code proxy, the CLI and the Web UI use the directory they were started from (`process.cwd()`), so start pi or the proxy from the project root, or the relative paths point elsewhere.
- **Values**: LeakShield reads non-empty values of at least eight characters, then detects exact occurrences in text sent to the model. It does not automatically read `.env` or process environment variables, and it never sends, logs or serializes the loaded values.
- **After changing an enabled env file**, restart the host that loaded it (OpenCode, pi), the Claude Code proxy or the Web UI. The CLI applies it on its next run.
- **Verification**: for OpenCode, the end-to-end harness in `scripts/e2e/compare/` runs with `env_files`. For pi and the Claude Code proxy, coverage is inferred from the code path above; no end-to-end check has been run yet.

**`envQueries` is separate and OpenCode-only.** The opt-in `envQueries` plugin option adds three read-only tools over the same files (`guard_env_list`, `guard_env_inspect`, `guard_env_compare`) so an agent can answer configuration questions without seeing values; it works only with `mode: "block"` or `"redact"`; in transparent mode, including the default, the option is ignored with a warning and `--doctor` shows an `env-queries` warn check. It is a debugging aid, not a protection: masking comes from `env_files` above. pi and the Claude Code proxy do not offer these tools, and their `.env` protection does not depend on them. See [Readonly env queries](plugin/env-queries.md).

## Custom Rules

```yaml
custom_rules:
  - description: "Company token"
    pattern: "MYCO_[A-Z0-9]{32}"
    severity: HIGH
    flags: "i"            # subset of gimsuy; g is always implied
    word_boundary: true   # \b only at literal ASCII word edges
    allow:                # exact strings this rule never reports
      - "MYCO_EXAMPLE0000000000000000000000000"
    # path: ["src/**"]    # accepted, but NOT implemented (see below)

settings:
  allowlist:              # exact strings no rule reports (see the bypass warning)
    - "qa@example.com"
```

- **`flags`** — any subset of `gimsuy`; `g` is always added. The default is `i`, so
  existing rules keep matching case-insensitively. An unknown flag (such as `x`)
  fails the config load, and the pattern is compiled with the final flags, so a
  pattern that is only invalid under `u` also fails the load.
  Zero-length matches are skipped (they contain no value to report or redact);
  scanning continues to later nonempty matches, including under Unicode flags.
- **`word_boundary`** — adds `\b` where the pattern's edge is a literal ASCII word
  character. A CJK edge (「機密」) is left alone: `\b` never holds between two
  non-word characters, and wrapping it would stop the rule matching. An edge that
  is a group, character class, quantifier or escape cannot take a boundary safely,
  so none is added and `--doctor` warns that the rule is looser than it looks —
  write `\b` in the pattern yourself, e.g. `\bEMP-\d{6}\b`. A top-level alternation
  (`a|b`) is a config error; group it as `(?:a|b)`.
- **`allow` / `settings.allowlist`** — exact matches against the matched text, not
  substrings and not regexes. `allow` applies to that rule; `settings.allowlist`
  applies to every rule, including the built-in ones and exact `.env` values.
  Caps: 32 entries per rule, 64 globally, 200 characters each.
  **Allowlisting a live secret is a real bypass**: the value still leaves the
  machine unmasked, and LeakShield will not report that value as a rule or
  `.env` finding. Use it only for values you have decided are not sensitive.
  Unicode evasion diagnostics are separate: a zero-width or look-alike-letter
  warning means removing those characters exposes a finding the raw text hides,
  and an allowlist on the raw text does not silence it. Cyrillic or Greek text
  on its own is not flagged. `--doctor` reports how many entries exist, exercises up to eight
  of them, and reports how many it could not exercise (a context-dependent
  pattern can only be judged in place). Suppressions are counted rather than
  silent.
- **`path`** — accepted and validated, but path scoping is **not implemented**: the
  scanner has no source path for prompts or tool output. These rules currently
  apply to every scanned text, and `--doctor` warns when `path` is set.

Allowlist entries are part of the config file, so they change its fingerprint
(sha256 of the file), which is what authorizations compare against.

### Label-gated PII

The built-in rules recognise formats that stand on their own. Names, addresses,
dates of birth, medical record numbers, passport numbers, US SSNs and MAC
addresses do not: the same characters fill ordinary code and prose.
`config/guard.config.example.yaml` ships a commented set of patterns for them.
Every one fires only after a field label, except the Taiwan address shape, which
is anchored on a city name instead.

Four things were measured while writing them, and they are why the patterns
look the way they do:

- **Keep `flags: ""` on the name rule.** The default flag is `i`, so a `Name`
  label also matches every `name:` key in code, CI job names and sentences such
  as "Name this route". Over 18 lines of ordinary code and prose the
  case-insensitive form produced 4 false matches; the case-sensitive form
  produced none.
- **Mask a free-text value together with its label.** A lookbehind with a
  variable-width separator is matched right-to-left, so it can start at the
  colon itself and redact the colon; matching label, separator and value as one
  unit has no such edge, and restoration returns the same text.
- **JSON keys arrive quoted.** A key such as `"mrn"` puts a `"` between the name
  and the colon, so the separator class includes it; without that the rule never
  fires on tool arguments or config dumps.
- **The English address branch needs a colon and a digit.** An assignment named
  `address` is common in code (`address = server.address()`), and on this
  repository it produced 5 false matches before that gate. The Taiwan shape uses
  a city list for the same reason: a generic `…市…區…路…號` also swallows the
  verb in front of an address.

The repository's own text is not a corpus for these shapes: scanning `src/`,
`docs/`, `tests/` and `config/` (248 files) produced no match at all. A zero
means the shapes are absent, not that a pattern is safe. Measure against your
own traffic, and drop the labels you never use. The measurement record is
[2026-11-25 label-gated PII](../evidence/2026-11-25-label-gated-pii.md).

## Configuration Validation

Input lengths for dynamic rules are validated when the config is loaded:

| Field | Max length |
|-------|-----------|
| `nda_keywords` entries | 200 characters |
| `private_domains` entries | 255 characters |
| `custom_rules` `description` / `pattern` | 200 characters |

Values exceeding these limits will cause `loadConfig()` to throw a Zod validation error, preventing oversized patterns from entering the scanner.

List sizes are capped too, and a config over a cap fails the load:

| Field | Max entries |
|-------|-------------|
| `nda_keywords` | 4096 |
| `private_domains` | 4096 |
| `custom_rules` | 1024 |

A `custom_rules` pattern that does not compile as a regular expression also makes `loadConfig()` throw, naming the rule's index and `description` (not the pattern): a rule that cannot be enforced must not load. A pattern that compiles but runs slowly on a fixed probe input is skipped as a ReDoS suspect, with a warning on stderr and a `custom-rules` warning in `leakshield --doctor`. That check is a timing heuristic, not a guarantee: it runs the pattern once and cannot interrupt it, so it cannot prove a pattern safe.

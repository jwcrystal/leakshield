# Readonly env queries (opt-in)

> 🌐 English | [繁體中文](./env-queries.zh-TW.md)

[← OpenCode plugin](../opencode.md)

The `envQueries` option (default `false`) exposes three read-only tools over the files listed in `settings.env_files`, so an agent can answer configuration questions without ever seeing values. It is for `block` and `redact` modes. In transparent mode (the v2 default when `mode` is omitted) the option is ignored: the plugin starts normally, the tools are not registered, it logs a warning and `--doctor` shows a warn check. An agent in transparent mode can read the env file directly instead, but masking there is partial: values of 8 or more characters (and anything a scanner rule detects) become stable placeholders, while shorter values such as `PORT=3000` or `DEBUG=true` stay visible, and only masked values can be compared through their placeholders. Use envQueries with `block` or `redact` when env file contents must not enter the conversation:

| Tool | Contract |
|---|---|
| `guard_env_list` | Opaque session-local file ids plus key names — never paths, values, lengths, or previews. |
| `guard_env_inspect(file_id, key)` | `missing` \| `empty` \| `nonempty`; when nonempty, a coarse lexical shape `boolean_like` \| `number_like` \| `multiline_text` \| `text`. A shape is a lexical hint, never a claim the value is a valid boolean or number. |
| `guard_env_compare(left_file_id, left_key, right_file_id, right_key)` | `equal` \| `different` \| `unavailable` for key-to-key, same- or cross-file equality. Missing keys and unreadable files are `unavailable`. |

```jsonc
{ "package": "/absolute/path/to/leakshield/dist", "options": { "mode": "block", "envQueries": true } }
```

## Ground rules

Only `settings.env_files` entries are queryable (at most 16 files, 1 MiB each). File ids are only valid in the session that listed them. Files are re-read on every call, and a comparison reads both operands in one per-call snapshot.

Raw values, value lengths, previews, fingerprints, and reverse mappings never appear in any output. If the guard configuration file changes after setup, the tools return a fixed restart-required error until OpenCode restarts — they never silently fall back to the old or new authorization.

## File access

File access is best-effort pathname identity validation, not a sandbox. The workspace root is frozen at setup (resolved path plus device/inode identity); every query re-stats the root and each ancestor directory before opening and again after reading, rejects symlinks on any path component — including ancestor directories that resolve elsewhere, even inside the workspace — requires regular files, opens the fully resolved canonical path with `O_NOFOLLOW` and `O_NONBLOCK`, and binds the opened descriptor to the statted inode with pre- and post-read size and mtime checks. Limitations, stated honestly: malicious concurrent filesystem mutation by the same owner is outside this threat model — a substitution that is reverted between two checks (an ABA race on the root, an ancestor directory, or the file) is not detectable by pathname checks, hardlinks are not distinguished from the original file (provenance is not checked), in-place rewrites that preserve size and mtime are not distinguishable, and the agent can modify env files through other tools — so results describe the current file state, not a trusted baseline.

Key names themselves are returned as-is and pass through the normal output/history protection.

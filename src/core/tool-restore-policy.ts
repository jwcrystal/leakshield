import { containsTokenPrefix } from "../decision/pseudonymization.js";
import { FINDING_TYPES } from "../types.js";

/** Shell syntax excluded from unquoted literal words. Known tokens are
 * removed before this check; a token-shaped prefix alone grants no exemption. */
export const UNSUPPORTED_SHELL_SYNTAX = /[\x00-\x1f\x7f'"`\\$;|&<>(){}*?\[\]!~#]/;

export type ShellQuote = "none" | "single" | "double";
export interface LiteralShellWord {
  start: number;
  end: number;
  value: string;
  quote: ShellQuote;
  redirect: boolean;
}

/** A deliberately small literal-word lexer, not a general shell parser.
 * Quotes must enclose the entire word. No escape decoding, expansions, quote
 * concatenation or control characters are accepted. Decode command/flag
 * quotes too, so `'sh' '-c' TOKEN` cannot bypass the interpreter gate. */
export function parseLiteralShellWords(text: string): LiteralShellWord[] | null {
  if (/[\x00-\x1f\x7f]/.test(text)) return null;
  // The new quote/redirection subset is POSIX-specific. Keep the previous
  // conservative behavior on Windows, where the host may launch cmd.exe.
  if (process.platform === "win32" && /['">]/.test(text)) return null;
  const words: LiteralShellWord[] = [];
  let at = 0;
  while (at < text.length) {
    if (text[at] === " ") {
      at += 1;
      continue;
    }
    const start = at;
    if (text[at] === ">") {
      at += text[at + 1] === ">" ? 2 : 1;
      words.push({ start, end: at, value: text.slice(start, at), quote: "none", redirect: true });
    } else if (text[at] === "'" || text[at] === '"') {
      const delimiter = text[at++];
      const valueStart = at;
      while (at < text.length && text[at] !== delimiter) at += 1;
      if (at === text.length) return null;
      const value = text.slice(valueStart, at++);
      const quote = delimiter === "'" ? "single" : "double";
      if (quote === "double" && /[`\\$!]/.test(value)) return null;
      words.push({ start, end: at, value, quote, redirect: false });
    } else {
      while (at < text.length && text[at] !== " ") at += 1;
      const value = text.slice(start, at);
      if (UNSUPPORTED_SHELL_SYNTAX.test(value.replace(TOKEN_SCAN, "TOKEN")) || value.includes(">")) return null;
      words.push({ start, end: at, value, quote: "none", redirect: false });
    }
    if (at < text.length && text[at] !== " ") return null;
  }
  return words;
}

export const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const SHELL_COMMAND_WRAPPERS = new Set([
  "builtin",
  "command",
  "doas",
  "env",
  "eval",
  "exec",
  "nice",
  "nohup",
  "pkexec",
  "runuser",
  "setsid",
  "source",
  "sudo",
  "su",
  "time",
  "timeout",
  "xargs",
]);

export const INLINE_SCRIPT_FLAGS = new Map<string, Set<string>>([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
  ["ruby", new Set(["-e", "-pe", "-ne"])],
  ["perl", new Set(["-e", "-pe", "-ne", "-E"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
  ["powershell", new Set(["-c", "-command", "-encodedcommand", "-e"])],
  ["pwsh", new Set(["-c", "-command", "-encodedcommand", "-e"])],
  ["cmd", new Set(["/c", "/k"])],
]);
export const SCRIPT_ARGUMENT_INTERPRETERS = new Set(["awk", "sed", "jq"]);
export const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "ash", "csh", "tcsh", "fish"]);

/**
 * `rtk` is a command-output wrapper: `rtk <command> <args>` runs the command
 * and condenses its output, so the command actually executed is the word
 * after it. Without this, `rtk sh -c T` would be judged as plain arguments to
 * `rtk` and restore a token into a second shell parse. These subcommands run
 * another command themselves (`rtk err sh -c T`, `rtk proxy sh -c T`), so the
 * word after them cannot be judged as the executed command and the form is
 * refused. The list comes from `rtk --help` for rtk 1.1.0; a new rtk release
 * may add runners. `rtk` counts however it's spelled (a path, quotes, any case),
 * as the other command checks do.
 */
export const RTK_COMMAND_RUNNERS = new Set(["err", "test", "summary", "run", "bypass", "proxy", "pipe"]);

/**
 * Index of the word that names the command actually executed: the first
 * non-assignment word, or the word after a leading `rtk`. Returns -1 when
 * there is no such word or the form must be refused (`rtk` alone, an option
 * after `rtk`, `rtk` wrapping `rtk`, or an rtk subcommand that runs another
 * command).
 */
export function resolveExecutedCommandIndex(words: readonly LiteralShellWord[]): number {
  const commandIndex = words.findIndex((word) => word.quote !== "none" || !ASSIGNMENT_WORD.test(word.value));
  if (commandIndex === -1) return -1;
  const command = words[commandIndex] as LiteralShellWord;
  if (command.redirect || command.value.split("/").at(-1)?.toLowerCase() !== "rtk") return commandIndex;
  const next = words[commandIndex + 1];
  if (next === undefined || next.redirect || next.value.startsWith("-")) return -1;
  if (next.value.split("/").at(-1)?.toLowerCase() === "rtk") return -1;
  if (RTK_COMMAND_RUNNERS.has(next.value.toLowerCase())) return -1;
  return commandIndex + 1;
}

/** Returns only ordinary arguments, never command/assignment/redirect words. */
export function parseSupportedShellArguments(text: string): LiteralShellWord[] | null {
  const parsed = parseLiteralShellWords(text);
  if (parsed === null) return null;
  const redirectIndex = parsed.findIndex((word) => word.redirect);
  if (redirectIndex !== -1) {
    const target = parsed[redirectIndex + 1];
    if (
      redirectIndex === 0 || redirectIndex !== parsed.length - 2 ||
      target.redirect || target.value.length === 0 || containsTokenPrefix(target.value)
    ) return null;
  }
  const words = redirectIndex === -1 ? parsed : parsed.slice(0, redirectIndex);
  const commandIndex = resolveExecutedCommandIndex(words);
  if (commandIndex === -1) return null;
  const commandName = words[commandIndex].value.split("/").at(-1)?.toLowerCase() ?? "";
  if (SHELL_COMMAND_WRAPPERS.has(commandName) || SCRIPT_ARGUMENT_INTERPRETERS.has(commandName)) return null;
  const argumentsOnly = words.slice(commandIndex + 1);
  if (SHELL_INTERPRETERS.has(commandName)) {
    if (argumentsOnly.some((argument) => /^-[A-Za-z]*c[A-Za-z]*$/.test(argument.value))) return null;
  }
  const inlineFlags =
    INLINE_SCRIPT_FLAGS.get(commandName) ??
    (/^python(?:\d+(?:\.\d+)*)?$/.test(commandName) ? INLINE_SCRIPT_FLAGS.get("python") : undefined);
  if (inlineFlags && argumentsOnly.some((argument) => inlineFlags.has(argument.value.toLowerCase()))) return null;
  if (commandName === "deno" && argumentsOnly.some((argument) => argument.value === "eval")) return null;
  return argumentsOnly;
}

/** Characters forbidden inside restored shell argument words. */
export const SHELL_UNSAFE = /[\s'"`\\$;|&<>(){}*?\[\]!~#\x00-\x1F\x7F]/;
/**
 * Restore policy is decided per field, not per tool. A tool name that is in
 * SHELL_TOOLS or has a shell-interpreter segment (bash, shell, sh, zsh, pwsh,
 * powershell) makes every field "shell". Otherwise a field named like a
 * command (command, cmd, commands, argv, ...) is "shell", a field named like
 * code (code, script, ...) is "inert" (no parsing; originals with
 * shell-unsafe characters are refused), and any other field restores
 * verbatim. The list is built into the source, not configurable; an executing
 * tool using other field names is not detected.
 */
export const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "exec",
  "command",
  "run",
  "pwsh",
  "powershell",
]);
export type ToolLeafPolicy = "verbatim" | "shell" | "inert";

/** Splits on non-alphanumerics and camelCase boundaries; lowercase segments. */
export const nameSegments = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());

export const SHELL_TOOL_SEGMENTS = new Set(["bash", "shell", "sh", "zsh", "pwsh", "powershell"]);
export const METADATA_KEYS = new Set(["description", "title", "label"]);
export const SHELL_KEY_LAST_SEGMENTS = new Set(["command", "commands", "cmd", "cmds"]);
export const SHELL_KEYS_JOINED = new Set(["shell", "commandline", "cmdline", "argv"]);
export const CODE_KEYS_JOINED = new Set(["code", "script", "scripts", "sourcecode", "codesnippet", "inlinescript"]);

export const isShellTool = (rawTool: string): boolean =>
  SHELL_TOOLS.has(rawTool.toLowerCase()) || nameSegments(rawTool).some((segment) => SHELL_TOOL_SEGMENTS.has(segment));

export const isShellKey = (key: string): boolean => {
  const segments = nameSegments(key);
  return (
    (segments.length > 0 && SHELL_KEY_LAST_SEGMENTS.has(segments[segments.length - 1] as string)) ||
    SHELL_KEYS_JOINED.has(segments.join(""))
  );
};
export const isCodeKey = (key: string): boolean => CODE_KEYS_JOINED.has(nameSegments(key).join(""));

export const keyPolicy = (key: string, inherited: ToolLeafPolicy): ToolLeafPolicy => {
  const segments = nameSegments(key);
  if (segments.length === 1 && METADATA_KEYS.has(segments[0] as string)) return "verbatim";
  if (isShellKey(key)) return "shell";
  if (isCodeKey(key)) return inherited === "shell" ? "shell" : "inert";
  return inherited;
};

/**
 * Tools whose calls are observably read-only: an unresolved placeholder in
 * their arguments reads/greps/lists against a literal string and matches
 * nothing — no state change, no outbound transmission. Only these qualify
 * for P1 (2026-10-06b) best-effort literal passthrough when restoration is
 * incomplete. Everything else — writes, deletes, edits, network calls,
 * shell, unknown tools — refuses the affected invocation.
 */
export const READ_ONLY_TOOLS = new Set([
  "read",
  "read_file",
  "view",
  "grep",
  "glob",
  "list",
  "ls",
  "find",
  "todoread",
]);
/**
 * Content-free degradation notice for the host log: one WARN line, a fixed
 * context word plus a count, never request content. No side files, no
 * provider-body notices (P1, 2026-10-06b).
 */
export const warnDegradation = (context: string): void => {
  console.warn(`[leakshield] degraded: ${context}`);
};
/** Preserve the existing quote context; never add quoting or reinterpret the
 * original as code. Leading '-' stays forbidden even when quoted (options are
 * interpreted after quote removal). Controls are forbidden in every context. */
export function isShellSafeOriginal(text: string, quote: ShellQuote): boolean {
  if (text.length === 0 || text.startsWith("-") || /[\x00-\x1f\x7f]/.test(text)) return false;
  if (quote === "single") return !text.includes("'");
  if (quote === "double") return !/["`\\$!]/.test(text);
  return !SHELL_UNSAFE.test(text);
}
/**
 * HTTP clients that take credentials inside an argument (`-H 'x-api-key: T'`,
 * `-u user:T`, `--header=x:T`). `wget` is deliberately not listed: its `-e`
 * option family keeps producing bypasses, so it follows the whole-word rule.
 * `isShellSafeOriginal` only covers the first
 * shell parse; commands such as `sh -c`, `python -c`, `ssh` and `eval` parse
 * their arguments again, so embedding is decided by the command that actually
 * executes: the first word, unquoted, exactly one of these names. Paths,
 * quoted names, assignments and wrappers (`env`, `sudo`) do not qualify.
 * `rtk curl ...` does not qualify either: rtk records command lines in its
 * local history database in plaintext, so a restored secret would persist
 * there. Under `rtk` only whole-word placeholders restore.
 */
export const EMBEDDED_PLACEHOLDER_COMMANDS = new Set(["curl", "http"]);
export function commandAllowsEmbeddedTokens(text: string): boolean {
  const first = parseLiteralShellWords(text)?.[0];
  return (
    first !== undefined &&
    first.quote === "none" &&
    !first.redirect &&
    EMBEDDED_PLACEHOLDER_COMMANDS.has(first.value)
  );
}
/**
 * `wget -e CMD` / `--execute CMD` hands its value to wgetrc parsing, a second
 * parse that `isShellSafeOriginal` does not cover (the value can set
 * `output_document`, `post_file` and the like). This check stays although
 * `wget` no longer holds embedded tokens: `wget -e T u` would otherwise
 * restore a whole-word token into wgetrc parsing. The command must be
 * `wget` however it's spelled (a path, quotes, leading assignments), resolved
 * as in `parseSupportedShellArguments`. `curl -e` is a referer and
 * `curl -K`/`--config` only name a file.
 * GNU long options accept unique abbreviations (`--exec`), so any prefix of
 * `--execute` counts; the shorter ambiguous ones make wget exit with an error.
 */
export function isWgetExecuteCommand(text: string): boolean {
  const words = parseLiteralShellWords(text);
  if (words === null) return false;
  const commandIndex = resolveExecutedCommandIndex(words);
  if (commandIndex === -1) return false;
  if (words[commandIndex].value.split("/").at(-1)?.toLowerCase() !== "wget") return false;
  return words.slice(commandIndex + 1).some((word) => {
    if (word.redirect) return false;
    const optionName = word.value.split("=", 1)[0] as string;
    return /^-[A-Za-z0-9]*e/.test(word.value) || (optionName.length >= 3 && "--execute".startsWith(optionName));
  });
}
/** Matches a fully formed reserved token (either version), for per-token shell safety checks. */
export const TOKEN_SCAN =
  /\[SGP1:[0-9a-f]{32}-\d{8,12}\]|\[SGP2:[A-Z][A-Z_]{0,31}-[a-z]{4}-[a-z]{4}-[a-z]{4}\]/g;

/**
 * Relaxed (brackets optional, separators up to 4 non-alphanumerics, any case)
 * forms of the SGP2 placeholder, used only to spot a placeholder the
 * model reformatted. Every quantifier is bounded and there is no nested
 * unbounded group. A candidate counts only if its canonical form restores in
 * the session, so no token enumeration is needed.
 *
 * SGP2 reads the letters after the `SGP2` head, tolerating separator runs of
 * up to 4 non-alphanumerics between letters (changed separators) or none at
 * all (removed separators), and stopping at a digit, a longer run or about 80
 * letters. Each known category, compared without underscores, is tried as a
 * prefix of those letters; the next 12 letters become the three segments. The
 * text after a stripped token is often more short words, which this ignores
 * because only exactly 12 letters follow the category.
 */
export const NEAR_MISS_V2_HEAD = /(?<![A-Za-z0-9])SGP2/gi;
export const NEAR_MISS_V2_MAX_SEPARATOR = 4;
export const NEAR_MISS_V2_MAX_LETTERS = 80;
export const NEAR_MISS_V2_SEGMENT_LETTERS = 12;
export const NEAR_MISS_V2_CATEGORIES: ReadonlyMap<string, string> = new Map(
  FINDING_TYPES.map((label) => [label.replaceAll("_", "").toUpperCase(), label] as const),
);
/** Letters following `from`, skipping short separator runs; stops at a digit or a long run. */
export function collectNearMissLetters(text: string, from: number): string {
  let letters = "";
  let at = from;
  while (at < text.length && letters.length < NEAR_MISS_V2_MAX_LETTERS) {
    const char = text[at] as string;
    if (/[A-Za-z]/.test(char)) {
      letters += char;
      at += 1;
    } else if (/[0-9]/.test(char)) {
      break;
    } else {
      let run = 0;
      while (at + run < text.length && /[^A-Za-z0-9]/.test(text[at + run] as string)) run += 1;
      if (run > NEAR_MISS_V2_MAX_SEPARATOR) break;
      at += run;
    }
  }
  return letters;
}

/**
 * Builds the position check for the placeholders of one code/script field.
 * Call the result with each token's [start, end) in increasing order; it keeps
 * its state between calls, so the whole field costs one forward pass however
 * many tokens it holds, and a false result ends the field's check. A token's
 * position passes unless `crossesLineBoundary` or `isInPlainStringLiteral`
 * rejects it.
 *
 * Conservative, language-agnostic, line-based heuristic; it is not a parser
 * and does not confirm the match is in a string. It can both over-refuse and
 * miss. It guards the restoration context only and is not egress protection:
 * code can still print, send or re-interpret the restored value.
 */
export function createInertPositionCheck(text: string): (start: number, end: number) => boolean {
  const lineBreak = /[\n\r\u2028\u2029]/g;
  // Current line is [lineStart, lineEnd); lineEnd sits on its separator.
  let lineStart = 0;
  let lineEnd = -1;
  // Triple quotes in text[0, countedTo). A separator ends any run of quotes, so
  // per-line counts add up to the non-overlapping count over the whole prefix.
  let countedTo = 0;
  let doubleTriples = 0;
  let singleTriples = 0;
  let crossesLineBoundary = false;
  // Quote scan of the current line, resumed from `cursor` for each token.
  let cursor = 0;
  let quote: string | null = null;
  let introducerInString = false;
  let closingQuote = -1;

  const enterLineOf = (index: number): void => {
    while (lineEnd < index) {
      lineStart = lineEnd + 1;
      lineBreak.lastIndex = lineStart;
      lineEnd = lineBreak.exec(text)?.index ?? text.length;
    }
    const uncounted = text.slice(countedTo, lineStart);
    doubleTriples += uncounted.match(/"""/g)?.length ?? 0;
    singleTriples += uncounted.match(/'''/g)?.length ?? 0;
    countedTo = lineStart;
    const line = text.slice(lineStart, lineEnd);
    // True when the line may belong to a multi-line construct, so the
    // line-based string check cannot be trusted: the line holds a triple quote,
    // an odd number of non-overlapping triple quotes precedes the line (inside
    // an open multi-line string), or the previous line ends in a backslash
    // (continuation; doubled backslashes are not distinguished, so refuse).
    // Deliberately not a whole-field ban, so a script with a balanced docstring
    // above the assignment still works.
    crossesLineBoundary =
      line.includes('"""') ||
      line.includes("'''") ||
      doubleTriples % 2 === 1 ||
      singleTriples % 2 === 1 ||
      /\\(?:\r\n|[\n\r\u2028\u2029])$/.test(text.slice(Math.max(0, lineStart - 3), lineStart));
    cursor = lineStart;
    quote = null;
    introducerInString = false;
  };

  /**
   * True when [start, end) looks like it sits inside an ordinary quoted string
   * that opens and closes on the current line, with no interpolation or escape
   * introducer between the opening quote and the token.
   */
  const isInPlainStringLiteral = (start: number, end: number): boolean => {
    while (cursor < start) {
      const c = text[cursor];
      if (quote === null) {
        if (c === "'" || c === '"') {
          quote = c;
          introducerInString = false;
        } else if (
          c === "`" || c === "#" || text.startsWith("//", cursor) || text.startsWith("/*", cursor) || text.startsWith("--", cursor)
        ) {
          return false;
        }
      } else if (c === "\\") {
        introducerInString = true;
        cursor++;
      } else if (c === quote) {
        quote = null;
      } else if (c === "{" || c === "$" || c === "`") {
        introducerInString = true;
      }
      cursor++;
    }
    if (quote === null || introducerInString) return false;
    // A token holds no quote or backslash, so a search from an earlier token
    // in this string walked through this one: its answer still holds, and each
    // string on the line is searched once.
    if (closingQuote >= end) return true;
    for (let i = end; i < lineEnd; i++) {
      if (text[i] === "\\") {
        i++;
        continue;
      }
      if (text[i] === quote) {
        closingQuote = i;
        return true;
      }
    }
    return false;
  };

  return (start, end) => {
    if (start > lineEnd) enterLineOf(start);
    return !crossesLineBoundary && isInPlainStringLiteral(start, end);
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_ENV_QUERY_FILES,
  classifyEnvValueShape,
  parseEnvFileContent,
  EnvQueryService,
} from "../src/env-queries.js";

// The ESM namespace of node:fs cannot be spied on directly; a transparent
// spread of the actual module keeps every other test in this file running
// against the real fs while letting the race tests intercept individual
// calls (lstat/open/read) as seen by the module under test.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual };
});

const secret = "sk-12345678901234567890";
const temporaryDirectories: string[] = [];

function makeWorkspace(envFiles: Record<string, string>): {
  root: string;
  configPath: string;
  writeConfig: (yaml: string) => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-env-"));
  temporaryDirectories.push(root);
  for (const [name, content] of Object.entries(envFiles)) {
    fs.writeFileSync(path.join(root, name), content, "utf8");
  }
  const configPath = path.join(root, "guard.config.yaml");
  return { root, configPath, writeConfig: (yaml) => fs.writeFileSync(configPath, yaml, "utf8") };
}

/** Mirrors the production pairing of `findConfigPath` + `loadConfigWithFingerprint`. */
function configFingerprint(configPath: string | undefined): string {
  if (!configPath) return "absent";
  try {
    return createHash("sha256").update(fs.readFileSync(configPath, "utf8")).digest("hex");
  } catch {
    return "unreadable";
  }
}

function makeService(root: string, envFiles: string[], configPath?: string): EnvQueryService {
  const resolveConfigPath = () => (configPath && fs.existsSync(configPath) ? configPath : undefined);
  return new EnvQueryService({
    envFiles,
    workspaceRoot: root,
    resolveConfigPath,
    configFingerprint: configFingerprint(resolveConfigPath()),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("env file parser (query service)", () => {
  it("parses assignments with export, comments, quotes, and preserves short and empty values", () => {
    const parsed = parseEnvFileContent(
      [
        "# full-line comment",
        "TINY=abc", // shorter than the exact-value scanner's 8-char floor
        "EMPTY=",
        "EMPTY_DOUBLE=\"\"",
        "EMPTY_SINGLE=''",
        "DOUBLE=\"hello world\"",
        'SINGLE=\'literal $VAR\'',
        "TRAILING=value # trailing comment",
        'QUOTED_TRAILING="value" # trailing comment',
        "  export EXPORTED=yes",
        "  INDENTED=ok",
        "HASH=value#not-comment",
      ].join("\n"),
    );
    expect(parsed).toBeDefined();
    expect(parsed!.get("TINY")).toBe("abc");
    expect(parsed!.get("EMPTY")).toBe("");
    expect(parsed!.get("EMPTY_DOUBLE")).toBe("");
    expect(parsed!.get("EMPTY_SINGLE")).toBe("");
    expect(parsed!.get("DOUBLE")).toBe("hello world");
    expect(parsed!.get("SINGLE")).toBe("literal $VAR");
    expect(parsed!.get("TRAILING")).toBe("value");
    expect(parsed!.get("QUOTED_TRAILING")).toBe("value");
    expect(parsed!.get("EXPORTED")).toBe("yes");
    expect(parsed!.get("INDENTED")).toBe("ok");
    expect(parsed!.get("HASH")).toBe("value#not-comment");
  });

  it("keeps the last duplicate assignment and never performs expansion", () => {
    const parsed = parseEnvFileContent("DUP=one\nDUP=two\nREF=${DUP}\nREF2=$OTHER\n");
    expect(parsed!.get("DUP")).toBe("two");
    expect(parsed!.get("REF")).toBe("${DUP}");
    expect(parsed!.get("REF2")).toBe("$OTHER");
  });

  it("supports escaped newlines and physical multiline quoted values", () => {
    const parsed = parseEnvFileContent('ESCAPED="a\\nb"\nPHYSICAL="line1\nline2"\nSINGLE=\'x\ny\'\n');
    expect(parsed!.get("ESCAPED")).toBe("a\nb");
    expect(parsed!.get("PHYSICAL")).toBe("line1\nline2");
    expect(parsed!.get("SINGLE")).toBe("x\ny");
  });

  it("processes double-quote escapes in one pass", () => {
    const parsed = parseEnvFileContent('A="tab\\there"\nB="quote\\"inside"\nC="back\\\\slash"\nD="keep\\q"\n');
    expect(parsed!.get("A")).toBe("tab\there");
    expect(parsed!.get("B")).toBe('quote"inside');
    expect(parsed!.get("C")).toBe("back\\slash");
    expect(parsed!.get("D")).toBe("keep\\q");
  });

  it("rejects the entire file on malformed content instead of returning partial results", () => {
    expect(parseEnvFileContent("GOOD=ok\n\"unterminated\n")).toBeUndefined();
    expect(parseEnvFileContent("GOOD=ok\nKEY='unterminated\n")).toBeUndefined();
    expect(parseEnvFileContent("GOOD=ok\nstray line\n")).toBeUndefined();
    expect(parseEnvFileContent("GOOD=ok\n123BAD=x\n")).toBeUndefined();
    expect(parseEnvFileContent("GOOD=ok\n=novalue\n")).toBeUndefined();
    expect(parseEnvFileContent('GOOD=ok\nKEY="closed" trailing-garbage\n')).toBeUndefined();
    // An empty file or a comment-only file is valid.
    expect(parseEnvFileContent("")).toEqual(new Map());
    expect(parseEnvFileContent("# only a comment\n\n")).toEqual(new Map());
  });

  it("strips a leading BOM", () => {
    const parsed = parseEnvFileContent("\uFEFFKEY=value\n");
    expect(parsed!.get("KEY")).toBe("value");
  });

  it("treats `KEY= # comment` as an empty value, not a comment text value", () => {
    expect(parseEnvFileContent("KEY= # comment\n")!.get("KEY")).toBe("");
    expect(parseEnvFileContent("KEY=# comment\n")!.get("KEY")).toBe("");
    expect(parseEnvFileContent("KEY=  # c\n")!.get("KEY")).toBe("");
    // A real value before the comment survives, and quoted `#` stays content.
    expect(parseEnvFileContent("KEY=val # c\n")!.get("KEY")).toBe("val");
    expect(parseEnvFileContent('KEY="# not a comment"\n')!.get("KEY")).toBe("# not a comment");
    expect(parseEnvFileContent("KEY='# not a comment'\n")!.get("KEY")).toBe("# not a comment");
  });

  it("parses a 1 MiB unterminated quoted value in bounded time (no quadratic reparsing)", () => {
    // The quoted value spans 1024 physical lines and never closes: every
    // appended line must not rescan the whole accumulated value.
    const content = 'KEY="' + ("x".repeat(1024) + "\n").repeat(1024);
    const started = performance.now();
    expect(parseEnvFileContent(content)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  // Adversarial performance probes: escape-dense and whitespace-dense values
  // near the service's 1 MiB file cap. Generous deadlines (5 s) — the point
  // is the asymptotic bound, not tight timing. Before the monotonic rewrite,
  // the first two forms spent ~7 s re-running `indexOf` per backslash.
  it("parses a near-1 MiB run of `\\x` escapes with a distant closing quote in bounded time", () => {
    const repetitions = Math.floor((1024 * 1024 - 32) / 2);
    const body = "\\x".repeat(repetitions);
    const content = `KEY="${body}" # c\n`;
    const started = performance.now();
    const parsed = parseEnvFileContent(content);
    expect(parsed).toBeDefined();
    expect(parsed!.get("KEY")).toBe(body); // unknown escapes stay literal
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("rejects a near-1 MiB run of `\\x` escapes with no closing quote in bounded time", () => {
    const content = `KEY="${"\\x".repeat(Math.floor((1024 * 1024 - 16) / 2))}\n`;
    const started = performance.now();
    expect(parseEnvFileContent(content)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("parses a near-1 MiB single-quoted value with a distant closing quote in bounded time", () => {
    const content = `KEY='${"x".repeat(1024 * 1024 - 32)}' # c\n`;
    const started = performance.now();
    const parsed = parseEnvFileContent(content);
    expect(parsed).toBeDefined();
    expect(parsed!.get("KEY")).toBe("x".repeat(1024 * 1024 - 32));
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("parses a near-1 MiB whitespace-only unquoted value with no `#` in bounded time", () => {
    const content = `KEY=${" ".repeat(1024 * 1024 - 8)}\n`;
    const started = performance.now();
    const parsed = parseEnvFileContent(content);
    expect(parsed!.get("KEY")).toBe("");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("matches the golden multiline/comment corpus captured from the reference parser", () => {
    // Expected outputs captured from the shipped parser semantics before the
    // linear rewrite; the rewrite must preserve them exactly. The three
    // `KEY= # comment` bug-fix forms are asserted separately above.
    const corpus: Array<[string, string, Array<[string, string]> | undefined]> = [
      ["simple", "A=1\n", [["A", "1"]]],
      ["value-then-comment", "KEY=val # c\n", [["KEY", "val"]]],
      ["value-hash-nospace", "KEY=val# c\n", [["KEY", "val# c"]]],
      ["quoted-hash-dq", 'KEY="# not a comment"\n', [["KEY", "# not a comment"]]],
      ["quoted-hash-sq", "KEY='# not a comment'\n", [["KEY", "# not a comment"]]],
      ["dq-multiline-next-assignment", 'Q="line1\nline2"\nNEXT=ok\n', [["Q", "line1\nline2"], ["NEXT", "ok"]]],
      ["sq-multiline-next-assignment", "S='a\nb'\nNEXT=ok\n", [["S", "a\nb"], ["NEXT", "ok"]]],
      ["dq-escaped-backslash-nl", 'T="a\\\\\nb"\n', [["T", "a\\\nb"]]],
      ["dq-escaped-backslash-nl-nl", 'U="a\\\\\n\nb"\n', [["U", "a\\\n\nb"]]],
      ["dq-unterminated", 'V="unterminated\n', undefined],
      ["sq-unterminated", "W='unterminated\n", undefined],
      ["dq-closed-garbage", 'X="closed" trailing-garbage\n', undefined],
      ["dq-closed-ws-next-assign", 'Y="closed"  \nG=2\n', [["Y", "closed"], ["G", "2"]]],
      ["dq-closed-ws-comment-next", 'Z="closed"  \n#comment\nG=2\n', [["Z", "closed"], ["G", "2"]]],
      ["empty-value", "E1=\n", [["E1", ""]]],
      ["dq-space", 'E2=" "\n', [["E2", " "]]],
      ["esc-tab", 'ESC="tab\\there"\n', [["ESC", "tab\there"]]],
      ["esc-quote", 'B="quote\\"inside"\n', [["B", 'quote"inside']]],
      ["esc-backslash", 'C="back\\\\slash"\n', [["C", "back\\slash"]]],
      ["esc-unknown", 'D="keep\\q"\n', [["D", "keep\\q"]]],
      ["dq-then-assignment", 'M="a"\nN=b\n', [["M", "a"], ["N", "b"]]],
      ["sq-two-quotes", "P='it''s'\n", undefined],
      ["dq-multiline-esc", 'R="multi\nline \\"esc\\" x"\n', [["R", 'multi\nline "esc" x']]],
      ["dq-trailing-spaces", 'S2="tail spaces"   \n', [["S2", "tail spaces"]]],
      ["hash-value", "HASH=value#not-comment\n", [["HASH", "value#not-comment"]]],
      ["export", "  export EXPORTED=yes\n", [["EXPORTED", "yes"]]],
      ["three-line-dq", 'L1="a\nb\nc"\nL2=2\n', [["L1", "a\nb\nc"], ["L2", "2"]]],
      ["dq-esc-nl-eof", 'NL="x\\\\\ny"\nQ2=1\n', [["NL", "x\\\ny"], ["Q2", "1"]]],
      ["dq-close-then-comment-only-file", 'C1="v" # same line\n# standalone\n', [["C1", "v"]]],
      ["dq-esc-quote-multiline", 'W1="a\\"b\nc"\n', [["W1", 'a"b\nc']]],
      ["dq-backslash-eof-open", 'W2="a\\\\\n', undefined],
      ["stray-open-quote-line", "'\n\n'\n", undefined],
      ["stray-open-dquote-line", '"\n\n"\n', undefined],
      ["dq-many-escaped", 'W5="x\\"y\\"z\\"w\\"v\\"u\\"t"\n', [["W5", 'x"y"z"w"v"u"t']]],
      ["sq-plain-multiline", "K1='p\nq'\n", [["K1", "p\nq"]]],
      ["dq-escaped-backslash-cr", 'K2="a\\\\\rb"\n', undefined],
      ["dq-one-backslash-nl", 'T1="a\\\nb"\n', undefined],
      ["sq-backslash-nl", "T2='a\\\nb'\n", [["T2", "a\\\nb"]]],
      ["dq-one-backslash-close", 'T3="a\\\n"\n', undefined],
      ["dq-close-then-garbage-next-line", 'K3="v"\ngarbage\n', undefined],
      ["dq-ws-only-tail-multiline", 'K4="v" \n \nQ=1\n', [["K4", "v"], ["Q", "1"]]],
    ];
    for (const [name, content, expected] of corpus) {
      const parsed = parseEnvFileContent(content);
      if (expected === undefined) {
        expect(parsed, name).toBeUndefined();
      } else {
        expect(parsed === undefined ? undefined : [...parsed.entries()], name).toEqual(expected);
      }
    }
  });
});

describe("env value shapes", () => {
  it("classifies coarse lexical shapes and never claims validity", () => {
    expect(classifyEnvValueShape("true")).toBe("boolean_like");
    expect(classifyEnvValueShape("FALSE")).toBe("boolean_like");
    expect(classifyEnvValueShape("42")).toBe("number_like");
    expect(classifyEnvValueShape("-3.14")).toBe("number_like");
    expect(classifyEnvValueShape("+1e5")).toBe("number_like");
    expect(classifyEnvValueShape("0x1F")).toBe("number_like");
    expect(classifyEnvValueShape("a\nb")).toBe("multiline_text");
    expect(classifyEnvValueShape("hello")).toBe("text");
    expect(classifyEnvValueShape("  true  ")).toBe("text"); // quoted whitespace is preserved
    expect(classifyEnvValueShape("42abc")).toBe("text");
  });
});

describe("EnvQueryService — listing", () => {
  it("returns opaque session-local file ids and key names only", () => {
    const { root, configPath } = makeWorkspace({ ".env": "ALPHA=one\nBETA=two\n" });
    const service = makeService(root, [".env"], configPath);
    const result = service.listFiles("session-a");
    expect(result.ok).toBe(true);
    const entry = result.ok ? result.files[0] : undefined;
    expect(entry).toBeDefined();
    expect(entry!.file_id).toMatch(/^[0-9a-f]{16}$/);
    expect(entry!.available).toBe(true);
    expect(entry!.keys).toEqual(["ALPHA", "BETA"]);
    // No paths, no values anywhere in the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("one");
    expect(serialized).not.toContain("two");
    expect(serialized).not.toContain(root);
  });

  it("issues different ids per session and rejects ids from another session", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    const service = makeService(root, [".env"], configPath);
    const listA = service.listFiles("session-a");
    const listB = service.listFiles("session-b");
    const idA = (listA.ok ? listA.files[0].file_id : "") || "";
    const idB = (listB.ok ? listB.files[0].file_id : "") || "";
    expect(idA).not.toBe(idB);

    const inspect = service.inspectKey("session-b", idA, "KEY");
    expect(inspect).toEqual({ ok: false, code: "unknown_file_id" });
  });

  it("reports unavailable files with fixed sanitized reason codes", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    fs.mkdirSync(path.join(root, "sub"));
    const service = makeService(root, [".env", ".missing", "sub"], configPath);
    const result = service.listFiles("session-a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files).toHaveLength(3);
    expect(result.files[0].available).toBe(true);
    expect(result.files[1].reason).toBe("unreadable");
    expect(result.files[2].reason).toBe("not_regular_file");
  });
});

describe("EnvQueryService — inspect", () => {
  it("reports missing, empty, and nonempty statuses with shapes", () => {
    const { root, configPath } = makeWorkspace({
      ".env": "GONE_AFTER=x\nPRESENT=short\nFLAG=true\nBLANK=\n",
    });
    const service = makeService(root, [".env"], configPath);
    const list = service.listFiles("session-a");
    const fileId = list.ok ? list.files[0].file_id : "";

    expect(service.inspectKey("session-a", fileId, "ABSENT")).toEqual({ ok: true, status: "missing" });
    expect(service.inspectKey("session-a", fileId, "BLANK")).toEqual({ ok: true, status: "empty" });
    expect(service.inspectKey("session-a", fileId, "PRESENT")).toEqual({
      ok: true,
      status: "nonempty",
      shape: "text",
    });
    expect(service.inspectKey("session-a", fileId, "FLAG")).toEqual({
      ok: true,
      status: "nonempty",
      shape: "boolean_like",
    });
  });

  it("returns unavailable for unreadable and malformed files", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=\"unterminated\n" });
    const service = makeService(root, [".env"], configPath);
    const list = service.listFiles("session-a");
    const fileId = list.ok ? list.files[0].file_id : "";
    expect(service.inspectKey("session-a", fileId, "KEY")).toEqual({
      ok: true,
      status: "unavailable",
      reason: "malformed",
    });
  });

  it("rejects unknown file ids and invalid arguments", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    const service = makeService(root, [".env"], configPath);
    expect(service.inspectKey("session-a", "deadbeefdeadbeef", "KEY")).toEqual({
      ok: false,
      code: "unknown_file_id",
    });
    expect(service.inspectKey("session-a", "", "KEY")).toEqual({ ok: false, code: "unknown_file_id" });
    expect(service.inspectKey("session-a", "x".repeat(65), "KEY")).toEqual({
      ok: false,
      code: "unknown_file_id",
    });
    expect(service.inspectKey("session-a", "anything", "")).toEqual({
      ok: false,
      code: "invalid_arguments",
    });
    expect(service.inspectKey("session-a", "anything", "k".repeat(513))).toEqual({
      ok: false,
      code: "invalid_arguments",
    });
    expect(service.inspectKey(undefined as never, "anything", "KEY")).toEqual({
      ok: false,
      code: "invalid_arguments",
    });
  });
});

describe("EnvQueryService — compare", () => {
  it("compares keys within and across files without revealing values", () => {
    const { root, configPath } = makeWorkspace({
      ".env": "A=same-secret-value\nB=same-secret-value\nC=different\n",
      ".env.local": "X=same-secret-value\nY=other\n",
    });
    const service = makeService(root, [".env", ".env.local"], configPath);
    const list = service.listFiles("session-a");
    if (!list.ok) throw new Error("list failed");
    const [envId, localId] = [list.files[0].file_id, list.files[1].file_id];

    expect(service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: envId, key: "B" })).toEqual({
      ok: true,
      result: "equal",
    });
    expect(service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: localId, key: "X" })).toEqual({
      ok: true,
      result: "equal",
    });
    expect(service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: localId, key: "Y" })).toEqual({
      ok: true,
      result: "different",
    });
    expect(service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: envId, key: "A" })).toEqual({
      ok: true,
      result: "equal",
    });
    const serialized = JSON.stringify([
      service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: envId, key: "B" }),
    ]);
    expect(serialized).not.toContain("same-secret-value");
  });

  it("treats missing keys and unavailable files as unavailable", () => {
    const { root, configPath } = makeWorkspace({
      ".env": "A=value\n",
      ".broken": "B=\"unterminated\n",
    });
    const service = makeService(root, [".env", ".broken"], configPath);
    const list = service.listFiles("session-a");
    if (!list.ok) throw new Error("list failed");
    const envId = list.files[0].file_id;
    const brokenId = list.files[1].file_id;

    expect(service.compareKeys("session-a", { fileId: envId, key: "A" }, { fileId: envId, key: "NOPE" })).toEqual({
      ok: true,
      result: "unavailable",
    });
    expect(service.compareKeys("session-a", { fileId: envId, key: "NOPE" }, { fileId: envId, key: "A" })).toEqual({
      ok: true,
      result: "unavailable",
    });
    expect(
      service.compareKeys("session-a", { fileId: brokenId, key: "B" }, { fileId: envId, key: "A" }),
    ).toEqual({ ok: true, result: "unavailable", reason: "malformed" });
  });

  it("rejects unknown file ids and invalid arguments", () => {
    const { root, configPath } = makeWorkspace({ ".env": "A=1\n" });
    const service = makeService(root, [".env"], configPath);
    expect(
      service.compareKeys("session-a", { fileId: "nope", key: "A" }, { fileId: "nope", key: "A" }),
    ).toEqual({ ok: false, code: "unknown_file_id" });
    expect(
      service.compareKeys("session-a", { fileId: "x", key: "" }, { fileId: "x", key: "A" }),
    ).toEqual({ ok: false, code: "invalid_arguments" });
  });
});

describe("EnvQueryService — file access limits", () => {
  it("refuses symlinks even when they resolve inside the workspace", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "link.env"));
    const service = makeService(root, ["link.env"], configPath);
    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("symlink");
  });

  it("refuses traversal, absolute, and outside-workspace entries", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-out-"));
    temporaryDirectories.push(outsideRoot);
    fs.writeFileSync(path.join(outsideRoot, "outside.env"), "KEY=value\n", "utf8");

    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    for (const entry of ["../outside.env", "/etc/passwd", "sub/../../escape.env"]) {
      const service = makeService(root, [entry], configPath);
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("outside_workspace");
    }
  });

  it("refuses oversized and non-regular files", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    fs.writeFileSync(path.join(root, "big.env"), `KEY=${"x".repeat(1024 * 1024)}\n`, "utf8");
    fs.mkdirSync(path.join(root, "dir.env"));

    const service = makeService(root, ["big.env", "dir.env"], configPath);
    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("oversize");
    expect(list.ok && list.files[1].reason).toBe("not_regular_file");
  });

  it("opens the canonical resolved path with O_NOFOLLOW and O_NONBLOCK (no blocking open, no followed symlink)", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    const service = makeService(root, [".env"], configPath);
    const openSpy = vi.spyOn(fs, "openSync");
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].available).toBe(true);
      expect(openSpy).toHaveBeenCalled();
      // The open must target the canonical (realpath-resolved) path, not the
      // raw allowlist entry, and must carry both race-hardening flags.
      const openedPath = openSpy.mock.calls[0][0] as string;
      expect(openedPath).toBe(fs.realpathSync(path.join(root, ".env")));
      const flags = openSpy.mock.calls[0][1] as number;
      expect(flags & (fs.constants.O_NOFOLLOW ?? 0)).toBe(fs.constants.O_NOFOLLOW ?? 0);
      expect(flags & (fs.constants.O_NONBLOCK ?? 0)).toBe(fs.constants.O_NONBLOCK ?? 0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a FIFO without hanging (nonblocking open, regular-file requirement)", () => {
    const { root, configPath } = makeWorkspace({});
    const fifoPath = path.join(root, "pipe.env");
    execSync(`mkfifo "${fifoPath}"`);
    const service = makeService(root, ["pipe.env"], configPath);
    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("not_regular_file");
  });

  it("rejects when the final component becomes a symlink after lstat (canonical-path agreement catches it before the open)", () => {
    const { root, configPath } = makeWorkspace({ "target.env": "SECRET=1\n", "decoy.env": "X=1\n" });
    fs.symlinkSync(path.join(root, "target.env"), path.join(root, "link.env"));
    const service = makeService(root, ["link.env"], configPath);
    // The service resolves the workspace root through realpath (on macOS the
    // tmpdir symlink /var → /private/var), so compare on the resolved root.
    const realRoot = fs.realpathSync(root);
    const realLstat = fs.lstatSync.bind(fs);
    // Simulate the race window: lstat reports the decoy regular file (as if
    // link.env were still a regular file), but the path is now a symlink.
    // The realpath of the path no longer agrees with the lexically validated
    // path, so the read is rejected before anything is opened; O_NOFOLLOW
    // remains as defense in depth for the residual window.
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options?: unknown) =>
      String(p) === path.join(realRoot, "link.env")
        ? realLstat(path.join(realRoot, "decoy.env"), options as never)
        : realLstat(p, options as never)) as never);
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("symlink");
      // Secret protection: neither the target's nor the decoy's keys leak.
      expect(JSON.stringify(list)).not.toContain("SECRET");
      expect(JSON.stringify(list)).not.toContain("X");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects when the opened descriptor is not the inode lstat saw (dev/ino binding)", () => {
    const { root, configPath } = makeWorkspace({ "a.env": "SECRET=1\n", "b.env": "SECRET=2\n" });
    const service = makeService(root, ["b.env"], configPath);
    const realRoot = fs.realpathSync(root);
    const realLstat = fs.lstatSync.bind(fs);
    // Simulate a pathname race: lstat saw a.env's inode, open() resolves the
    // (swapped/replaced) path to b.env. The descriptors must not be trusted.
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, options?: unknown) =>
      String(p) === path.join(realRoot, "b.env")
        ? realLstat(path.join(realRoot, "a.env"), options as never)
        : realLstat(p, options as never)) as never);
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("unreadable");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a file that grows or changes during the read (post-read metadata check)", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    const service = makeService(root, [".env"], configPath);
    const realRead = fs.readSync.bind(fs);
    let appended = false;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = realRead(fd, buffer, offset, length, position);
      if (!appended) {
        appended = true;
        fs.appendFileSync(path.join(root, ".env"), "APPENDED=more\n", "utf8");
      }
      return bytes;
    }) as typeof fs.readSync);
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("unreadable");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("caps the allowlist at 16 files (fail-closed construction)", () => {
    const { root } = makeWorkspace({});
    const envFiles = Array.from({ length: MAX_ENV_QUERY_FILES + 1 }, (_, i) => `.${i}.env`);
    expect(() => makeService(root, envFiles)).toThrow("env_files supports at most 16 files");
  });
});

describe("EnvQueryService — workspace identity validation", () => {
  /** Config file kept outside the workspace so a substituted root cannot
   *  masquerade as authorization drift in the before-open tests. */
  function makeExternalConfig(): { configPath: string } {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-cfg-"));
    temporaryDirectories.push(configDir);
    const configPath = path.join(configDir, "guard.config.yaml");
    fs.writeFileSync(configPath, "settings:\n  env_files:\n    - .env\n", "utf8");
    return { configPath };
  }

  it("rejects an ancestor directory symlink that resolves outside the workspace", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-guard-out-"));
    temporaryDirectories.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, ".env"), "OUTSIDE_SECRET=1\n", "utf8");

    const { root, configPath } = makeWorkspace({});
    fs.mkdirSync(path.join(root, "sub"));
    fs.symlinkSync(outsideDir, path.join(root, "sub", "nested"));
    const service = makeService(root, ["sub/nested/.env"], configPath);
    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("outside_workspace");
    expect(JSON.stringify(list)).not.toContain("OUTSIDE_SECRET");
  });

  it("rejects an ancestor directory symlink even when it resolves inside the workspace", () => {
    const { root, configPath } = makeWorkspace({});
    fs.mkdirSync(path.join(root, "real"));
    fs.writeFileSync(path.join(root, "real", ".env"), "INSIDE_SECRET=1\n", "utf8");
    fs.mkdirSync(path.join(root, "sub"));
    // Stable internal symlink: containment alone would accept this path;
    // the canonical/lexical agreement check must not.
    fs.symlinkSync(path.join(root, "real"), path.join(root, "sub", "nested"));
    const service = makeService(root, ["sub/nested/.env"], configPath);
    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("symlink");
    expect(JSON.stringify(list)).not.toContain("INSIDE_SECRET");
  });

  it("rejects a substituted workspace root before the read (pinned root identity)", () => {
    const { root } = makeWorkspace({ ".env": "KEY=value\n" });
    const { configPath } = makeExternalConfig();
    const service = makeService(root, [".env"], configPath);
    expect(service.listFiles("session-a").ok).toBe(true); // sanity: authorized state

    // Persistently substitute the root: same path, different directory, with
    // a decoy env file. The path still lexically matches the frozen root, so
    // only the pinned dev/ino identity can catch it.
    const movedRoot = `${root}-moved`;
    fs.renameSync(root, movedRoot);
    temporaryDirectories.push(movedRoot);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, ".env"), "DECOY_KEY=decoy-secret\n", "utf8");

    const list = service.listFiles("session-a");
    expect(list.ok && list.files[0].reason).toBe("unreadable");
    expect(JSON.stringify(list)).not.toContain("DECOY_KEY");
    expect(JSON.stringify(list)).not.toContain("decoy-secret");
    const fileId = list.ok ? list.files[0].file_id : "";
    expect(service.inspectKey("session-a", fileId, "DECOY_KEY")).toEqual({
      ok: true,
      status: "unavailable",
      reason: "unreadable",
    });
  });

  it("rejects a substituted workspace root during the read (post-read identity re-validation)", () => {
    const { root, configPath } = makeWorkspace({ ".env": "KEY=value\n" });
    const service = makeService(root, [".env"], configPath);
    const realRead = fs.readSync.bind(fs);
    let substituted = false;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = realRead(fd, buffer, offset, length, position);
      if (!substituted) {
        substituted = true;
        const movedRoot = `${root}-moved`;
        fs.renameSync(root, movedRoot);
        temporaryDirectories.push(movedRoot);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, ".env"), "DECOY_KEY=decoy-secret\n", "utf8");
      }
      return bytes;
    }) as typeof fs.readSync);
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("unreadable");
      expect(JSON.stringify(list)).not.toContain("DECOY_KEY");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects a substituted ancestor directory during the read (post-read ancestor identity check)", () => {
    const { root, configPath } = makeWorkspace({});
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", ".env"), "KEY=value\n", "utf8");
    const service = makeService(root, ["sub/.env"], configPath);
    const realRead = fs.readSync.bind(fs);
    let substituted = false;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const bytes = realRead(fd, buffer, offset, length, position);
      if (!substituted) {
        substituted = true;
        // Persistently replace the ancestor directory (not reverted): the
        // pre-open snapshot and the post-read re-walk must disagree.
        fs.renameSync(path.join(root, "sub"), path.join(root, "sub-moved"));
        fs.mkdirSync(path.join(root, "sub"));
        fs.writeFileSync(path.join(root, "sub", ".env"), "DECOY_KEY=decoy-secret\n", "utf8");
      }
      return bytes;
    }) as typeof fs.readSync);
    try {
      const list = service.listFiles("session-a");
      expect(list.ok && list.files[0].reason).toBe("unreadable");
      expect(JSON.stringify(list)).not.toContain("DECOY_KEY");
      expect(JSON.stringify(list)).not.toContain("decoy-secret");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("EnvQueryService — freshness and revocation", () => {
  it("re-reads files on every invocation", () => {
    const { root, configPath } = makeWorkspace({ ".env": "FIRST=one\n" });
    const service = makeService(root, [".env"], configPath);
    const firstList = service.listFiles("session-a");
    const fileId = firstList.ok ? firstList.files[0].file_id : "";
    expect(firstList.ok && firstList.files[0].keys).toEqual(["FIRST"]);

    fs.writeFileSync(path.join(root, ".env"), "SECOND=two\n", "utf8");
    const secondList = service.listFiles("session-a");
    expect(secondList.ok && secondList.files[0].keys).toEqual(["SECOND"]);
    expect(service.inspectKey("session-a", fileId, "FIRST")).toEqual({ ok: true, status: "missing" });
    expect(service.inspectKey("session-a", fileId, "SECOND")).toEqual({
      ok: true,
      status: "nonempty",
      shape: "text",
    });
  });

  it("disables all queries when the guard configuration changes after setup", () => {
    const { root, configPath, writeConfig } = makeWorkspace({ ".env": "KEY=value\n" });
    writeConfig("settings:\n  env_files:\n    - .env\n");
    const service = makeService(root, [".env"], configPath);
    const list = service.listFiles("session-a");
    const fileId = list.ok ? list.files[0].file_id : "";
    expect(service.inspectKey("session-a", fileId, "KEY")).toEqual({
      ok: true,
      status: "nonempty",
      shape: "text",
    });

    writeConfig("settings:\n  env_files: []\n"); // authorization revoked on disk
    expect(service.listFiles("session-a")).toEqual({ ok: false, code: "disabled" });
    expect(service.inspectKey("session-a", fileId, "KEY")).toEqual({ ok: false, code: "disabled" });
    expect(
      service.compareKeys("session-a", { fileId, key: "KEY" }, { fileId, key: "KEY" }),
    ).toEqual({ ok: false, code: "disabled" });
  });

  it("keeps queries disabled after the configuration reverts (sticky revocation)", () => {
    const { root, configPath, writeConfig } = makeWorkspace({ ".env": "KEY=value\n" });
    const original = "settings:\n  env_files:\n    - .env\n";
    writeConfig(original);
    const service = makeService(root, [".env"], configPath);
    expect(service.listFiles("session-a").ok).toBe(true);

    writeConfig("settings:\n  env_files: []\n");
    expect(service.listFiles("session-a")).toEqual({ ok: false, code: "disabled" });

    // Reverting the file must not re-enable: revocation is sticky until
    // OpenCode restarts, never a silent fallback to the old authorization.
    writeConfig(original);
    expect(service.listFiles("session-a")).toEqual({ ok: false, code: "disabled" });
    expect(service.inspectKey("session-a", "placeholder", "KEY")).toEqual({ ok: false, code: "disabled" });
  });

  it("disables queries when the configuration file disappears or appears after setup", () => {
    const { root, configPath, writeConfig } = makeWorkspace({ ".env": "KEY=value\n" });
    writeConfig("settings:\n  env_files:\n    - .env\n");

    const service = makeService(root, [".env"], configPath);
    expect(service.listFiles("session-a").ok).toBe(true);
    fs.rmSync(configPath);
    expect(service.listFiles("session-a")).toEqual({ ok: false, code: "disabled" });

    // Setup without a config file: a config appearing later is also drift.
    let resolvedConfigPath: string | undefined = undefined;
    const dynamicService = new EnvQueryService({
      envFiles: [".env"],
      workspaceRoot: root,
      resolveConfigPath: () => resolvedConfigPath,
      configFingerprint: configFingerprint(undefined),
    });
    expect(dynamicService.listFiles("session-b").ok).toBe(true);
    writeConfig("settings:\n  env_files:\n    - .env\n");
    resolvedConfigPath = configPath;
    expect(dynamicService.listFiles("session-b")).toEqual({ ok: false, code: "disabled" });
  });
});

describe("EnvQueryService — no-leak guarantees", () => {
  it("never emits values, paths, or exception text in any result", () => {
    const value = secret;
    const { root, configPath } = makeWorkspace({ ".env": `API_TOKEN=${value}\nOTHER=tiny\n` });
    const service = makeService(root, [".env"], configPath);
    const list = service.listFiles("session-a");
    if (!list.ok) throw new Error("list failed");
    const fileId = list.files[0].file_id;

    const outputs = [
      list,
      service.inspectKey("session-a", fileId, "API_TOKEN"),
      service.inspectKey("session-a", fileId, "OTHER"),
      service.inspectKey("session-a", fileId, "MISSING"),
      service.inspectKey("session-a", "not-a-file-id", "API_TOKEN"),
      service.inspectKey("session-a", fileId, ""),
      service.compareKeys("session-a", { fileId, key: "API_TOKEN" }, { fileId, key: "OTHER" }),
      service.compareKeys("session-a", { fileId, key: "API_TOKEN" }, { fileId, key: "API_TOKEN" }),
      service.compareKeys("session-a", { fileId, key: "MISSING" }, { fileId, key: "OTHER" }),
      service.listFiles("other-session"),
    ];
    const serialized = JSON.stringify(outputs);
    expect(serialized).not.toContain(value);
    expect(serialized).not.toContain("tiny");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain(root);
  });
});

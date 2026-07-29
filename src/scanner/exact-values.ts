import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_ENV_FILES = 16;
const MAX_ENV_FILE_SIZE = 1024 * 1024;
const MIN_EXACT_VALUE_LENGTH = 8;

export interface ExactValueMatch {
  index: number;
  length: number;
}

export class ExactValueDetector {
  readonly fingerprint: string;
  readonly #values: readonly string[];

  constructor(values: readonly string[]) {
    this.#values = [...new Set(values)].sort((left, right) => right.length - left.length);
    this.fingerprint = createHash("sha256").update(this.#values.join("\0")).digest("hex");
  }

  findAll(text: string): ExactValueMatch[] {
    const matches: ExactValueMatch[] = [];
    for (const value of this.#values) {
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(value, from);
        if (index === -1) break;
        matches.push({ index, length: value.length });
        from = index + value.length;
      }
    }
    return matches;
  }
}

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const relative = path.relative(workspaceRoot, filePath);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function parseEnvValue(rawValue: string): string {
  const value = rawValue.trimStart();
  const doubleQuoted = value.match(/^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/);
  if (doubleQuoted) {
    return doubleQuoted[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }

  const singleQuoted = value.match(/^'([^']*)'\s*(?:#.*)?$/);
  if (singleQuoted) return singleQuoted[1];

  return value.replace(/\s+#.*$/, "").trim();
}

function parseEnvValues(content: string): string[] {
  const values: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/);
    if (!assignment) continue;
    const value = parseEnvValue(assignment[1]);
    if (value.length >= MIN_EXACT_VALUE_LENGTH) values.push(value);
  }
  return values;
}

export function loadExactValueDetector(
  envFiles: readonly string[],
  workspaceRoot: string,
): ExactValueDetector | undefined {
  if (envFiles.length === 0) return undefined;
  if (envFiles.length > MAX_ENV_FILES) {
    throw new Error(`env_files supports at most ${MAX_ENV_FILES} files`);
  }

  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  const values = envFiles.flatMap((envFile) => {
    if (path.isAbsolute(envFile)) {
      throw new Error("Configured env file must be inside the workspace");
    }

    const candidate = path.resolve(realWorkspaceRoot, envFile);
    if (!isWithinWorkspace(candidate, realWorkspaceRoot)) {
      throw new Error("Configured env file is outside the workspace");
    }

    let realFilePath: string;
    let stat: fs.Stats;
    try {
      realFilePath = fs.realpathSync(candidate);
      stat = fs.statSync(realFilePath);
    } catch {
      throw new Error(`Configured env file cannot be read: ${envFile}`);
    }

    if (!isWithinWorkspace(realFilePath, realWorkspaceRoot) || !stat.isFile()) {
      throw new Error("Configured env file is outside the workspace");
    }
    if (stat.size > MAX_ENV_FILE_SIZE) {
      throw new Error(`Configured env file exceeds ${MAX_ENV_FILE_SIZE} bytes: ${envFile}`);
    }

    try {
      return parseEnvValues(fs.readFileSync(realFilePath, "utf8"));
    } catch {
      throw new Error(`Configured env file cannot be read: ${envFile}`);
    }
  });

  return new ExactValueDetector(values);
}

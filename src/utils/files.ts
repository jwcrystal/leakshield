import * as fs from "fs";
import * as path from "path";

// Run tasks with at most `limit` concurrent executions.
export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);

export function collectFiles(dir: string, extensions?: string[], maxFiles = 100): string[] {
  const files: string[] = [];
  function walk(d: string) {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path.join(d, entry.name));
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!extensions || extensions.includes(ext)) files.push(path.join(d, entry.name));
      }
    }
  }
  walk(dir);
  return files;
}

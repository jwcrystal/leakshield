import * as path from "path";

/**
 * Resolve an inputPath relative to baseDir (does NOT call realpathSync —
 * safe to call for paths that may not exist yet).
 */
export function resolveWorkspacePath(baseDir: string, inputPath: string): string {
  return path.resolve(baseDir, inputPath);
}

/**
 * Returns true when candidatePath is inside (or equal to) baseDir.
 * Both paths must already be absolute; call resolveWorkspacePath / realpathSync
 * before passing them here.
 */
export function isPathInsideBase(baseDir: string, candidatePath: string): boolean {
  const relative = path.relative(baseDir, candidatePath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Validate a CLI scan path against the workspace root.
 * Throws a user-facing Error when the path would escape the workspace and
 * allowOutside is false.
 * Returns the resolved absolute path on success.
 */
export function validateCliScanPath(
  baseDir: string,
  inputPath: string,
  allowOutside: boolean
): string {
  const resolved = resolveWorkspacePath(baseDir, inputPath);
  if (!allowOutside && !isPathInsideBase(baseDir, resolved)) {
    throw new Error(
      `Path "${resolved}" is outside allowed workspace "${baseDir}". Use --allow-outside to override.`
    );
  }
  return resolved;
}

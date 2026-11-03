/**
 * Package entrypoint for the OpenCode plugin loaders.
 *
 * - OpenCode v2 resolves the package `main` (or `<dir>/index.js` when the dist
 *   directory is configured directly) to this file.
 * - The default export is the OpenCode v2 plugin definition (`id` +
 *   `setup(ctx)`). Its `server` export is a fail-closed stub for v1 hosts,
 *   which are no longer supported.
 *
 * The CLI/web entrypoint lives in `./cli.js` (published as the `leakshield`
 * bin) so importing this module never starts an interactive process.
 */
export { default } from "./opencode.js";

/**
 * Package entrypoint for the OpenCode plugin loaders.
 *
 * - OpenCode v2 resolves the package `main` (or `<dir>/index.js` when the dist
 *   directory is configured directly) to this file.
 * - The default export is the dual-version plugin definition: v2 hosts read
 *   `id` + `setup(ctx)`, v1 hosts (1.18.29+) call `server(input, options)`.
 *
 * The CLI/web entrypoint lives in `./cli.js` (published as the `leakshield`
 * bin) so importing this module never starts an interactive process.
 */
export { default } from "./opencode.js";

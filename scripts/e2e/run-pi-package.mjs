#!/usr/bin/env node
/** Pack/install the built npm artifact, then exercise real pi package discovery.
 * Usage: npm run build && node scripts/e2e/run-pi-package.mjs /absolute/path/to/pi
 * Requires pi 1.6.0; synthetic loopback requests only. No publishing occurs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pi = process.argv[2];
if (!pi || !path.isAbsolute(pi)) throw new Error("Pass an absolute path to pi 1.6.0");
assert.equal(spawnSync(pi, ["--version"], { encoding: "utf8", timeout: 10000 }).stdout.trim(), "1.6.0");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakshield-pi-package-"));
// Node >=20.12 refuses to spawn npm.cmd without a shell, and a shell would split
// temp paths that contain spaces, so on Windows run npm's JS entry with node.
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npm = (args) => process.platform === "win32" ? [process.execPath, [npmCli, ...args]] : ["npm", args];
let complete = false;
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  assert.ok(fs.existsSync(path.join(root, "dist/adapters/pi/extension.js")), "Run npm run build first");
  const packed = JSON.parse(run(...npm(["pack", "--ignore-scripts", "--json", "--pack-destination", tmp, "--cache", path.join(tmp, "cache")])));
  assert.ok(packed[0].files.some((file) => file.path === "dist/adapters/pi/extension.js"));
  const prefix = path.join(tmp, "installed");
  run(...npm(["install", "--prefix", prefix, "--cache", path.join(tmp, "cache"), "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", path.join(tmp, packed[0].filename)]));
  const installed = path.join(prefix, "node_modules", "leakshield");
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./dist/adapters/pi/extension.js"]);
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.exports["."], "./dist/index.js", "OpenCode root entry stays available");
  await import(pathToFileURL(path.join(installed, manifest.exports["."])).href);
  for (const api of ["openai-completions", "anthropic-messages", "openai-responses"]) {
    process.stdout.write(run(process.execPath, [path.join(root, "scripts/e2e/run-pi-wire.mjs"), pi, api, "--package", installed]));
  }
  complete = true;
  console.log(`Packed artifact ${packed[0].filename}: package install/load/doctor/masking/restoration/remove passed on all three APIs (${process.version}).`);
} finally {
  if (complete) fs.rmSync(tmp, { recursive: true, force: true });
  else console.error(`Package check artifacts kept at ${tmp}`);
}

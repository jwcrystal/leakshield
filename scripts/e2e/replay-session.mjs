/**
 * Replays stored OpenCode session messages through protectJsonForModel.
 *
 * Usage: node scripts/e2e/replay-session.mjs [sessionID-prefix]
 *
 * Acceptance harness for the 2026-10-06b refusal-policy revision (T1): the
 * 02:23 deadlock was reproduced by replaying ses_ef35b33d…, where exactly one
 * assistant message (seq 1332, overlapping findings) failed the whole
 * request. This script re-runs that corpus against the current build.
 *
 * Canary discipline: prints ONLY ok/reason/counts — never message content.
 * Doubles as the P2 false-positive-audit harness (per-rule hit-rate report
 * can be added on top of the same replay loop).
 */
import { execSync } from "node:child_process";
import { createPseudonymizer } from "../../dist/decision/pseudonymization.js";
import { findConfigPath, loadConfigWithFingerprint } from "../../dist/config/loader.js";

const db = `${process.env.HOME}/.local/share/opencode/opencode.db`;
const prefix = process.argv[2] ?? "ses_ef35b33d";

const sh = (cmd) => execSync(cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const sidRow = JSON.parse(
  sh(`sqlite3 -readonly -json ${JSON.stringify(db)} "SELECT id FROM session_v2 WHERE id LIKE '${prefix}%' LIMIT 1"`),
)[0];
if (sidRow === undefined) {
  console.error(`no session matches ${prefix}`);
  process.exit(1);
}
const sid = sidRow.id;
const rows = JSON.parse(
  sh(
    `sqlite3 -readonly -json ${JSON.stringify(db)} "SELECT seq, data FROM session_message WHERE session_id='${sid}' ORDER BY seq"`,
  ),
);

const loaded = loadConfigWithFingerprint(findConfigPath());
// Same production posture as the plugin's setup (src/adapters/opencode/plugin.ts): encoding
// detection is always enabled at the model boundary.
const config = {
  ...loaded.config,
  settings: { ...loaded.config.settings, encoding_detection: true },
};
const created = createPseudonymizer(config);
if (!created.ok) {
  console.error(`factory failed: ${created.reason}`);
  process.exit(1);
}
const pseudonymizer = created;

let okCount = 0;
let failedCount = 0;
let parsed = 0;
const reasons = {};
const failedSeqs = [];
for (const row of rows) {
  let value;
  try {
    value = JSON.parse(row.data);
  } catch {
    continue;
  }
  parsed += 1;
  const result = pseudonymizer.protectJsonForModel(sid, value);
  if (result.ok) {
    okCount += 1;
  } else {
    failedCount += 1;
    reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
    if (failedSeqs.length < 5) failedSeqs.push(`seq ${row.seq}: ${result.reason}`);
  }
}
console.log(`session ${sid}: replayed ${parsed} messages: ok=${okCount} failed=${failedCount}`);
console.log(`reasons: ${JSON.stringify(reasons)}`);
if (failedSeqs.length > 0) console.log(failedSeqs.join("\n"));
process.exit(failedCount === 0 ? 0 : 2);

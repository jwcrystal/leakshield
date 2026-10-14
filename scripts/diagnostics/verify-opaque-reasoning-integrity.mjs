/** Offline red-capable regression probe. No real ciphertext, model or tools. */
import { createTransparentSessionGuard } from "../../dist/opencode-transparent.js";

const bytes = Buffer.alloc(89);
bytes[0] = 0x80;
bytes.writeBigUInt64BE(1700000000n, 1);
const base = bytes.toString("base64url");
// Synthetic encrypted-state shape containing a detector false-positive span.
// It is not authenticated ciphertext and is never submitted to a provider.
const opaque = base.slice(0, 40) + "AIza" + "A".repeat(35) + base.slice(79);
const canary = "opaque-canary@example.org";
const config = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, encoding_detection: true, show_line_numbers: false },
};
const hooks = new Map();
const hook = (domain) => async (name, callback) => {
  hooks.set(`${domain}:${name}`, callback);
  return { dispose: async () => {} };
};
const guard = createTransparentSessionGuard(config, "block", false);
const summary = { passed: false, opaquePreserved: false, providerMetadataPreserved: false, plaintextMasked: false, modelDispatches: 0, toolExecutions: 0 };
try {
  await guard.setup({ session: { hook: hook("session") }, tool: { hook: hook("tool") } });
  const event = {
    sessionID: "synthetic-opaque-integrity", kind: "primary", model: { providerID: "synthetic", id: "never-dispatched" },
    system: [], options: {}, messages: [{ role: "assistant", content: [{
      type: "reasoning", text: canary, encrypted: opaque, providerMetadata: { openai: { encryptedContent: opaque } },
    }] }],
  };
  await hooks.get("session:context")(event);
  const part = event.messages[0].content[0];
  summary.opaquePreserved = part.encrypted === opaque;
  summary.providerMetadataPreserved = part.providerMetadata.openai.encryptedContent === opaque;
  summary.plaintextMasked = !part.text.includes(canary);
  summary.passed = summary.opaquePreserved && summary.providerMetadataPreserved && summary.plaintextMasked;
} catch {
  summary.protectionRefused = true;
} finally { await guard.dispose(); }
console.log(JSON.stringify(summary, null, 2));
if (!summary.passed) process.exitCode = 1;

import { afterEach, describe, expect, it } from "vitest";
import { createTransparentSessionGuard } from "../src/adapters/opencode/opencode-transparent.js";
import type { GuardConfig } from "../src/types.js";

const EMAIL = "opaque-canary@example.org";
const config: GuardConfig = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, severity_threshold: "medium", scan_commands: true, ignore_patterns: [], encoding_detection: true },
};
const guards: ReturnType<typeof createTransparentSessionGuard>[] = [];
afterEach(async () => {
  for (const guard of guards.splice(0)) await guard.dispose();
});

/** Deterministic ciphertext-shaped bytes; never real provider state. */
function pseudoRandomBytes(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/** base64url opaque state with a detector false-positive span spliced in. */
function syntheticOpaque(seed: number, encoding: "base64url" | "base64" = "base64url"): string {
  const base = pseudoRandomBytes(120, seed).toString(encoding);
  return base.slice(0, 40) + "AIza" + "A".repeat(35) + base.slice(79);
}

async function arm(wireProtection = false) {
  const hooks = new Map<string, (event: any) => unknown>();
  const hook = (domain: string) => async (name: string, fn: (event: any) => unknown) => {
    hooks.set(`${domain}:${name}`, fn);
    return { dispose: async () => {} };
  };
  const guard = createTransparentSessionGuard(config, "block", wireProtection);
  guards.push(guard);
  await guard.setup({ session: { hook: hook("session") }, tool: { hook: hook("tool") }, aisdk: { hook: hook("aisdk") } } as never);
  const context = async (messages: unknown[], name = "context") => {
    const event = { kind: "primary", model: { providerID: "synthetic", id: "model" }, sessionID: "opaque-state", system: [], options: {}, messages };
    await hooks.get(`session:${name}`)!(event);
    return event.messages as any[];
  };
  return { context };
}

describe("provider-opaque reasoning state integrity", () => {
  it("confirms the synthetic opaque fixture trips the detector on its own", async () => {
    const { context } = await arm();
    const opaque = syntheticOpaque(1);
    const [message] = await context([{ role: "user", content: [{ type: "text", text: opaque }] }]);
    expect(message.content[0].text).not.toBe(opaque);
  });

  it.each([false, true])("preserves native reasoning `encrypted` byte-for-byte while masking its text (wire=%s)", async (wire) => {
    const { context } = await arm(wire);
    const opaque = syntheticOpaque(2);
    const [message] = await context([{ role: "assistant", content: [{ type: "reasoning", text: `notes for ${EMAIL}`, encrypted: opaque }] }]);
    expect(message.content[0].encrypted).toBe(opaque);
    expect(message.content[0].text).not.toContain(EMAIL);
  });

  it("preserves provider-metadata opaque state for every known provider key", async () => {
    const { context } = await arm();
    const values = {
      reasoningEncryptedContent: syntheticOpaque(3),
      encryptedContent: syntheticOpaque(4),
      signature: syntheticOpaque(5, "base64"),
      redactedData: syntheticOpaque(6, "base64"),
      thoughtSignature: syntheticOpaque(7, "base64"),
    };
    const [message] = await context([{ role: "assistant", content: [
      { type: "reasoning", text: "", providerMetadata: {
        openai: { itemId: "rs_1", reasoningEncryptedContent: values.reasoningEncryptedContent, encryptedContent: values.encryptedContent },
        anthropic: { signature: values.signature, redactedData: values.redactedData },
      } },
      { type: "text", text: `reply to ${EMAIL}`, providerMetadata: { google: { thoughtSignature: values.thoughtSignature } } },
    ] }]);
    const [reasoning, text] = message.content;
    expect(reasoning.providerMetadata.openai.reasoningEncryptedContent).toBe(values.reasoningEncryptedContent);
    expect(reasoning.providerMetadata.openai.encryptedContent).toBe(values.encryptedContent);
    expect(reasoning.providerMetadata.anthropic.signature).toBe(values.signature);
    expect(reasoning.providerMetadata.anthropic.redactedData).toBe(values.redactedData);
    expect(text.providerMetadata.google.thoughtSignature).toBe(values.thoughtSignature);
    expect(text.text).not.toContain(EMAIL);
  });

  it("preserves an assistant compaction checkpoint's `encrypted` state", async () => {
    const { context } = await arm();
    const opaque = syntheticOpaque(8);
    const [message] = await context([{ role: "assistant", content: [{ type: "compaction", provider: "openai", id: "cmp_1", encrypted: opaque }] }], "compaction");
    expect(message.content[0].encrypted).toBe(opaque);
  });

  it("does not trust opaque-state positions outside assistant messages", async () => {
    const { context } = await arm();
    const opaque = syntheticOpaque(9);
    const [message] = await context([{ role: "user", content: [
      { type: "reasoning", text: "", encrypted: opaque, providerMetadata: { openai: { reasoningEncryptedContent: opaque } } },
    ] }]);
    expect(message.content[0].encrypted).not.toBe(opaque);
    expect(message.content[0].providerMetadata.openai.reasoningEncryptedContent).not.toBe(opaque);
  });

  it("still masks plaintext smuggled into an opaque-state key", async () => {
    const { context } = await arm();
    const [message] = await context([{ role: "assistant", content: [
      { type: "reasoning", text: "", encrypted: `contact ${EMAIL}`, providerMetadata: { anthropic: { signature: EMAIL } } },
    ] }]);
    expect(message.content[0].encrypted).not.toContain(EMAIL);
    expect(message.content[0].providerMetadata.anthropic.signature).not.toContain(EMAIL);
  });

  it("still scans base64 whose decoded bytes are mostly readable text", async () => {
    const { context } = await arm();
    // Readable plaintext, base64-encoded, with the same detector span spliced
    // in: it is encoding, not ciphertext, so it must not earn the exemption.
    const base = Buffer.from("This is readable plaintext, not provider ciphertext. ".repeat(8)).toString("base64");
    const encoded = base.slice(0, 40) + "AIza" + "A".repeat(36) + base.slice(80);
    const [message] = await context([{ role: "assistant", content: [{ type: "reasoning", text: "", encrypted: encoded }] }]);
    expect(message.content[0].encrypted).not.toBe(encoded);
  });

  it("masks non-opaque provider-metadata siblings normally", async () => {
    const { context } = await arm();
    const opaque = syntheticOpaque(10);
    const [message] = await context([{ role: "assistant", content: [
      { type: "reasoning", text: "", providerMetadata: { openai: { reasoningEncryptedContent: opaque, note: EMAIL } } },
    ] }]);
    expect(message.content[0].providerMetadata.openai.reasoningEncryptedContent).toBe(opaque);
    expect(message.content[0].providerMetadata.openai.note).not.toContain(EMAIL);
  });
});

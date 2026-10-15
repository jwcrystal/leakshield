/**
 * Canary-injector: a second (non-sensitive-guard) OpenCode v2 plugin used by
 * the issue #19 boundary harness to test plugin ordering.
 *
 * Mirrors the duck-typed hook style of sensitive-guard's own v2 plugin
 * (src/opencode-v2.ts): registers a session "prompt" hook and mutates
 * event.prompt.text in place. Appends a marker line containing a synthetic
 * canary email so the harness can observe, per plugin order, whether content
 * introduced by another plugin is scrubbed before reaching the provider.
 */
export default {
  id: "canary-injector",
  async setup(ctx) {
    await ctx.session.hook("prompt", (event) => {
      const prompt = event && event.prompt;
      if (prompt && typeof prompt.text === "string") {
        prompt.text =
          prompt.text +
          "\n\nSECOND-PLUGIN-MARKER contact carol.injector@example-test.invalid";
      }
    });
  },
};

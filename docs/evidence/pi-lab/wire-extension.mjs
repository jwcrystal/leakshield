// The paired proxy owns mappings. Local Markdown transformation changes rendering only.
export default function (pi) {
  const origin = new URL(process.env.PI98_BROKER_URL);
  const credential = process.env.PI98_BROKER_KEY;
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !credential) {
    throw new Error("Authenticated loopback lab required");
  }
  const display = new Map();
  const tokenPattern = /\[SGP2:[^\]]+\]/g;
  async function call(path, body, ctx) {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + credential,
        "x-pi98-session": ctx.sessionManager.getSessionId(),
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error("Wire lab operation refused");
    return response.json();
  }
  async function prepareDisplay(text, ctx) {
    const tokens = [...new Set(text.match(tokenPattern) ?? [])];
    for (const token of tokens) {
      if (display.has(token) || display.size >= 256) continue;
      const restored = await call("/lab/display", { text: token }, ctx);
      if (restored.text !== token) display.set(token, restored.text);
    }
  }
  pi.registerMarkdownTransformer(
    (markdown) => markdown.replace(tokenPattern, (token) => display.get(token) ?? token),
    { messageTypes: ["assistant", "assistant-thinking"] },
  );
  pi.on("session_start", async (_event, ctx) => {
    display.clear();
    await prepareDisplay(JSON.stringify(ctx.sessionManager.getEntries()), ctx);
  });
  pi.on("before_provider_headers", (event, ctx) => {
    if (process.env.PI98_HEADER_FAILURE === "throw") throw new Error("Forced header hook error");
    if (process.env.PI98_HEADER_FAILURE === "reject") return Promise.reject(new Error("Forced header rejection"));
    event.headers["x-pi98-session"] = ctx.sessionManager.getSessionId();
  });
  pi.on("before_provider_request", async (event, ctx) => {
    if (process.env.PI98_FAILURE === "throw") throw new Error("Forced hook error");
    if (process.env.PI98_FAILURE === "reject") return Promise.reject(new Error("Forced hook rejection"));
    const masked = await call("/lab/mask", event.payload, ctx);
    await prepareDisplay(JSON.stringify(masked), ctx);
    return masked;
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    await prepareDisplay(text, ctx);
    if (!ctx.hasUI) {
      const restored = await call("/lab/display", { text }, ctx);
      console.error("PI98_DISPLAY " + JSON.stringify(restored.text));
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    try {
      const restored = await call("/lab/tool", { tool: event.toolName, input: event.input }, ctx);
      Object.assign(event.input, restored);
    } catch {
      return { block: true, reason: "Wire lab tool refused" };
    }
  });
}

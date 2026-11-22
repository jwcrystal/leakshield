// Paired with wire-proxy.mjs. The proxy owns all mappings for this ephemeral session.
export default function (pi) {
  const origin = new URL(process.env.PI98_BROKER_URL);
  const credential = process.env.PI98_BROKER_KEY;
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !credential) {
    throw new Error("Authenticated loopback lab required");
  }
  async function call(path, body) {
    const response = await fetch(new URL(path, origin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + credential },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error",
    });
    if (!response.ok) throw new Error("Wire lab operation refused");
    return response.json();
  }
  pi.on("before_provider_request", (event) => {
    if (process.env.PI98_FAILURE === "throw") throw new Error("Forced hook error");
    if (process.env.PI98_FAILURE === "reject") return Promise.reject(new Error("Forced hook rejection"));
    return call("/lab/mask", event.payload);
  });
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const text = event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    const restored = await call("/lab/display", { text });
    console.error("PI98_DISPLAY " + JSON.stringify(restored.text));
  });
  pi.on("tool_call", async (event) => {
    try {
      const restored = await call("/lab/tool", { tool: event.toolName, input: event.input });
      Object.assign(event.input, restored);
    } catch {
      return { block: true, reason: "Wire lab tool refused" };
    }
  });
}

import { createHmac, randomUUID } from "node:crypto";
import { createGuardCore } from "leakshield/core";

// Research fixture for the paired loopback harness. This has no egress gate.
export default function (pi) {
  if (process.env.PI98_LAB !== "synthetic-loopback-only") throw new Error("Lab launcher required");
  const core = createGuardCore({
    nda_keywords: ["PI98_PRIVATE_VALUE"],
    private_domains: [],
    custom_rules: [],
    settings: { max_chars: 200000, show_line_numbers: true, preview_length: 60, encoding_detection: false },
  }, "block", true, undefined, {}, {
    isCodeModeCall: () => false,
    isShellTool: () => false,
    classifyField: () => "verbatim",
    allowsDegradedRestore: () => false,
  });
  if (!core) throw new Error("Core initialization failed");
  const sessionID = "pi98-lab-session";
  let request;

  pi.on("before_provider_request", async (event) => {
    if (process.env.PI98_FAILURE === "throw") throw new Error("Forced lab error");
    if (process.env.PI98_FAILURE === "reject") return Promise.reject(new Error("Forced lab rejection"));
    const boundary = {
      sessionID,
      request: new Request("http://127.0.0.1/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event.payload),
      }),
    };
    await core.onHttpRequest(boundary);
    request = boundary.request;
    const payload = await request.clone().json();
    if (process.env.PI98_PROOF_KEY) {
      const proof = { nonce: randomUUID(), time: Date.now() };
      proof.mac = createHmac("sha256", process.env.PI98_PROOF_KEY)
        .update(JSON.stringify({ payload, nonce: proof.nonce, time: proof.time })).digest("hex");
      return { ...payload, _pi98proof: proof };
    }
    return payload;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || !request) return;
    const text = event.message.content
      .filter((part) => part.type === "text").map((part) => part.text).join("");
    const reply = {
      sessionID, request,
      response: Response.json({ choices: [{ message: { role: "assistant", content: text } }] }),
    };
    await core.onHttpResponse(reply);
    const restored = await reply.response.json();
    // Local diagnostic display only. Never replace the model-facing message.
    console.error("PI98_DISPLAY " + JSON.stringify(restored.choices[0].message.content));
  });

  pi.on("tool_call", (event) => {
    // Lab supports only the built-in read tool with its documented flat input.
    if (event.toolName !== "read" || typeof event.input.path !== "string" ||
        Object.keys(event.input).some((key) => !["path", "offset", "limit"].includes(key))) {
      return { block: true, reason: "Lab tool policy refused" };
    }
    try {
      const restored = { sessionID, tool: "read", input: structuredClone(event.input) };
      core.onToolBefore(restored);
      Object.assign(event.input, restored.input);
    } catch {
      return { block: true, reason: "Lab restoration refused" };
    }
  });
  pi.on("session_shutdown", () => core.dispose());
}

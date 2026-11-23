// Probe: can an extension guard provider traffic by wrapping globalThis.fetch?
import { appendFileSync } from "node:fs";

const LOG = process.env.PROBE_LOG;
const CANARY = "PI98_PRIVATE_VALUE";
const original = globalThis.fetch;
const log = (o) => appendFileSync(LOG, JSON.stringify(o) + "\n");

globalThis.fetch = async function guarded(input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    let body = init?.body;
    if (input instanceof Request && body === undefined) body = await input.clone().text();
    if (body != null && typeof body !== "string") throw new Error("non-string body: " + Object.prototype.toString.call(body));
    if (process.env.PROBE_FORCE_ERROR === "1") throw new Error("forced mask failure");
    const masked = body?.replaceAll(CANARY, "[MASKED]");
    log({ seen: url, hadCanary: body?.includes(CANARY) ?? false });
    if (input instanceof Request) return original(new Request(input, { ...init, body: masked }));
    return original(input, { ...init, body: masked });
  } catch (error) {
    log({ refused: url, error: String(error.message) });
    return new Response(JSON.stringify({ error: { message: "LeakShield refused: " + error.message } }),
      { status: 400, headers: { "content-type": "application/json" } });
  }
};
log({ loaded: true });

export default function () {}

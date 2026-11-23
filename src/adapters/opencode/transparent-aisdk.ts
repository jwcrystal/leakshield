/** Admit SDKs that honor OpenCode's injected HTTP fetch. SDK initialization
 * has no session identity or wire body: content masking/restoration remains
 * in the request-scoped HTTP hooks, not in a provider-brand allowlist.
 * This is NOT a network sandbox: SDKs that ignore options.fetch are outside
 * the supported contract (including any private sockets/global-fetch path). */
import { types } from "node:util";
import { classifyModelRoute } from "../../core/wire.js";

const ADMISSION_ERROR = "LeakShield blocked an unsupported route. The provider must use the fetch OpenCode injects.";
const DISPOSED_ERROR = "LeakShield blocked a request on an inactive AI SDK transport.";
const PROTECTION_ERROR = "LeakShield blocked an AI SDK request. Check its protocol, metadata and content, then try again.";
type RecordLike = Record<string, unknown>;
type InjectedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function optionsOf(event: RecordLike): RecordLike {
  if (types.isProxy(event)) throw new Error(ADMISSION_ERROR);
  const descriptor = Object.getOwnPropertyDescriptor(event, "options");
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    throw new Error(ADMISSION_ERROR);
  }
  return value as RecordLike;
}

/** Check protocol and, in strict mode, route before the host fetch. In false,
 * unknown HTTP routes still require the host's scoped preparation proof;
 * initialization is not admission. The host owns credentials and lifetime. */
function assertSupportedFetchInput(input: RequestInfo | URL, wireProtection: boolean): void {
  let url: URL;
  try {
    if (typeof input === "object" && input !== null && types.isProxy(input)) throw new Error();
    if (typeof input === "string") url = new URL(input);
    else if (input instanceof Request) url = new URL(input.url);
    else if (input instanceof URL) url = new URL(input.href);
    else throw new Error();
  } catch { throw new Error(ADMISSION_ERROR); }
  if (!["http:", "https:"].includes(url.protocol) || (wireProtection && classifyModelRoute(url.href) === null)) {
    throw new Error(ADMISSION_ERROR);
  }
}

export function createAISDKTransportAdmission(wireProtection = true) {
  const wrappers = new WeakSet<Function>();
  const notices = new Set<string>();
  let active = true;
  const refuse = (message: string): Response => {
    if (!notices.has(message)) {
      notices.add(message);
      console.warn(`[leakshield] local AI SDK HTTP 400 refusal: ${message}`);
    }
    // SDKs classify thrown fetch errors as retryable network failures. A local
    // non-2xx response makes the refusal actionable/non-retryable; it is NOT
    // returned through the network or represented as a provider success.
    return new Response(JSON.stringify({ type: "error", error: {
      type: "invalid_request_error", code: "leakshield_transport_refusal", message,
    } }), { status: 400, headers: { "content-type": "application/json", "x-leakshield-refusal": "1" } });
  };
  return {
    admit(event: RecordLike): void {
      if (!active) throw new Error(DISPOSED_ERROR);
      const options = optionsOf(event);
      const descriptor = Object.getOwnPropertyDescriptor(options, "fetch");
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" || types.isProxy(descriptor.value)) {
        throw new Error(ADMISSION_ERROR);
      }
      if (wrappers.has(descriptor.value)) return;
      if (descriptor.writable !== true) throw new Error(ADMISSION_ERROR);
      const original = descriptor.value as InjectedFetch;
      const admitted: InjectedFetch = async function (this: unknown, input, init) {
        if (!active) return refuse(DISPOSED_ERROR);
        try { assertSupportedFetchInput(input, wireProtection); }
        catch { return refuse(ADMISSION_ERROR); }
        try { return await Reflect.apply(original, this, [input, init]); }
        catch (error) {
          // Only SG's static refusal family is converted. Genuine networking,
          // cancellation and provider failures keep their original behavior.
          if (error instanceof Error && error.message.startsWith("LeakShield ")) return refuse(PROTECTION_ERROR);
          throw error;
        }
      };
      Object.defineProperty(options, "fetch", { ...descriptor, value: admitted });
      wrappers.add(admitted);
    },
    dispose(): void { active = false; },
  };
}

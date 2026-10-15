/**
 * restoration-probe — issue #22 runtime hook capability fixture.
 *
 * Recovery revision (2026-09-30, handoff-22 oracle plan):
 *   - NEW scenario "R" for the one bounded recovery control sequence:
 *       R1  read restore:  execute.before rewrites a placeholder path segment
 *                           ([SGPROBE-PATH-1] -> nonce-r1-original.txt)
 *       R2  shell restore: execute.before rewrites [SGPROBE-KEY-1] -> original
 *                           synthetic key inside the command
 *       R3  shell refusal: same restore hook REFUSES (throws) for sessions whose
 *                           ID has a marker file in $SGPROBE_REFUSE_DIR — models
 *                           "unresolved/unsafe restoration refuses the affected
 *                           tool" with zero side effects
 *       R4  permission:    observes permission.evaluate resources/effects on the
 *                           RESTORED value (rules are supplied per-session by the
 *                           harness through the documented session permissions
 *                           payload; this fixture only records, never overrides)
 *     One scenario serves all R controls because the plugin options in the
 *     global config document are per-serve-process; R3's refusal is keyed by
 *     sessionID so each control runs in a FRESH session.
 *   - Every R-scenario event line carries sessionID for exact attribution.
 *
 * Legacy scenarios A–E and P are kept SOURCE-REPAIRED but are NOT part of the
 * bounded recovery sequence (they were not re-validated by any run):
 *   - D directions are now SEPARATE (handoff-22 final-oracle repair):
 *       outbound http.request MASKS original -> placeholder (the old code
 *       reused the placeholder -> original replacement there — restoration in
 *       an outbound request, never re-validated at runtime);
 *       inbound http.response RESTORES placeholder -> original.
 *     Zero-replacement exchanges RETAIN the original request/response object
 *     untouched (the body is read from a clone, so the original stays usable);
 *     bodyless statuses (204/205/304) and bodyless request methods (GET/HEAD)
 *     are retained untouched (a rebuilt null-body Response would be invalid);
 *     rebuilt messages drop stale content-length/content-encoding/
 *     transfer-encoding; rewrite errors PROPAGATE. Buffered full-body rewrite
 *     remains a capability probe ONLY — not a production streaming algorithm
 *     and it proves nothing about WebSocket or UI.
 *   - Rebuilt outbound requests PRESERVE the original transport controls
 *     (redirect/credentials/abort signal/referrer/referrerPolicy and the
 *     other standard materialized RequestInit controls): only body/headers
 *     are replaced (handoff-22 offline-oracle fix #3 + final correction).
 *   - R-scenario tool/permission logs carry the installed-declaration
 *     attribution ids (Tool.CallID, SessionMessage.ID, and Permission.Source
 *     { type, messageID, id }) so R4a can correlate the EXACT armed call —
 *     an unrelated read denial or unrelated shell error cannot pass
 *     (handoff-22 offline-oracle fix #2).
 *
 * OFFLINE VALIDATION EXPORT: `__probeInternals` exposes the pure masking,
 * restoration and request/response rewrite helpers so the runner's --offline
 * suite can verify direction/idempotence/retention semantics with synthetic
 * in-memory Request/Response objects. Importing this module is side-effect
 * free (no fs/net/process spawn at top level); setup() only runs when a host
 * explicitly loads the plugin.
 *
 * Exact installed hook APIs (@opencode/plugin 2.0.19 d.ts, verified against
 * node_modules/@opencode/plugin/dist/promise/{tool,session,permission}.d.ts):
 *   ctx.tool.hook("execute.before", (e) => ...)   e.input is mutable
 *   ctx.tool.hook("execute.after",  (e) => ...)   e.result / e.error mutable
 *   ctx.permission.hook("evaluate", (e) => ...)   e.effect mutable (never done here)
 *   ctx.session.hook("context"|"compaction"|"generate"|"title", (e) => ...)
 *   ctx.session.hook("http.request"|"http.response"|"model.request", (e) => ...)
 *
 * Every hook firing is appended as one JSON line to $SGPROBE_EVENT_LOG. The
 * harness fails the probe when an expected hook did not fire.
 */

// Fixed synthetic mappings — deliberately NOT the production mapping module.
const PAIRS = [
  { placeholder: "[SGPROBE-EMAIL-1]", original: "alice.probe@example-test.invalid" },
  { placeholder: "[SGPROBE-KEY-1]", original: "sk-PROBETEST1234567890abcdef" },
  { placeholder: "[SGPROBE-PATH-1]", original: "nonce-r1-original.txt" },
];
const C_MARKER = "RESTORE-C-AFTER"; // appended to tool results in scenario C
const E_TRIGGER = "SGPROBE-E-TRIGGER";
const R3_REFUSED = "SGPROBE-R3-REFUSED";
const R3_THROW = "SGPROBE-R3-THROW";

let appendFn = null;
let existsFn = null;
let logPath = null;
let refuseDir = null;
let scenario = "?";

function log(hook, fields = {}) {
  const rec = { ts: Date.now(), scenario, hook, ...fields };
  try {
    appendFn(logPath, JSON.stringify(rec) + "\n");
  } catch {
    // Never let evidence logging break the host run.
  }
}

// Two SEPARATE directions (handoff-22 final-oracle repair — the old single
// replaceAll was placeholder->original in BOTH directions, i.e. restoration
// semantics leaked into the outbound re-mask path):
//   restorePlaceholders: placeholder -> original  (INBOUND restore: provider
//     replies and restored tool inputs flow back into local/model context)
//   maskOriginals:       original -> placeholder  (OUTBOUND re-mask: anything
//     leaving toward the provider must carry placeholders only)
// Both are idempotent by construction: placeholders contain no original
// substring and originals contain no placeholder substring (fixed PAIRS), so a
// second pass finds nothing to replace.
function replaceWith(str, pairs, fromKey, toKey) {
  let out = str;
  let touched = 0;
  for (const p of pairs) {
    if (out.includes(p[fromKey])) {
      out = out.split(p[fromKey]).join(p[toKey]);
      touched++;
    }
  }
  return { out, touched };
}

function restorePlaceholders(str) {
  return replaceWith(str, PAIRS, "placeholder", "original");
}

function maskOriginals(str) {
  return replaceWith(str, PAIRS, "original", "placeholder");
}

// Statuses that cannot carry a body: rebuilding `new Response(body, {status})`
// with these THROWS, so such responses are always retained untouched.
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/**
 * OUTBOUND request re-mask (original -> placeholder). Mutates `e.request` ONLY
 * when a replacement happened; otherwise the ORIGINAL request object is
 * retained (body read from a clone, so the original stays fully usable).
 * Bodyless request methods (GET/HEAD) are retained. Throws on rewrite errors
 * (caller must propagate, never swallow).
 */
async function applyOutboundRequestMask(e) {
  const req = e?.request;
  if (!req || typeof req.clone !== "function" || typeof req.text !== "function") {
    return { action: "skipped", reason: "no usable request object", touched: 0 };
  }
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { action: "retained", reason: "bodyless method", touched: 0, method };
  }
  const url = typeof req.url === "string" ? req.url : null;
  if (!url || !/^https?:\/\//i.test(url)) {
    return { action: "retained", reason: "non-http(s) url", touched: 0 };
  }
  const body = await req.clone().text(); // original body remains readable
  const { out, touched } = maskOriginals(body);
  if (touched === 0) {
    return { action: "retained", reason: "zero replacements", touched: 0, bytes: body.length };
  }
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  // Transport-control preservation (fix #3 + final correction finding 2):
  // the rebuild replaces ONLY body/headers and explicitly carries over every
  // standard RequestInit control the original materialized — redirect,
  // credentials, signal, referrer, referrerPolicy, mode, cache, integrity,
  // keepalive. The old rebuild lost them (e.g. on reviewer Node v26.0.0 an
  // explicit referrer URL and referrerPolicy "no-referrer" reset to
  // defaults). Only known-standard fields are copied; probe objects are
  // never dispatched; verified on the OFFLINE host's process.version only.
  e.request = new Request(req, {
    method,
    headers,
    body: out,
    redirect: req.redirect,
    credentials: req.credentials,
    signal: req.signal,
    referrer: req.referrer,
    referrerPolicy: req.referrerPolicy,
    mode: req.mode,
    cache: req.cache,
    integrity: req.integrity,
    keepalive: req.keepalive,
  });
  return { action: "rebuilt", touched, bytes: body.length };
}

/**
 * INBOUND response restore (placeholder -> original). Retains the ORIGINAL
 * response object on zero replacements and on bodyless statuses (204/205/304 —
 * rebuilt null-body responses are invalid); rebuilds otherwise, dropping stale
 * content-length/content-encoding/transfer-encoding. Throws on rewrite errors.
 */
async function applyInboundResponseRestore(e) {
  const res = e?.response;
  if (!res || typeof res.clone !== "function" || typeof res.text !== "function") {
    return { action: "skipped", reason: "no usable response object", touched: 0 };
  }
  if (BODYLESS_STATUSES.has(res.status)) {
    return { action: "retained", reason: "bodyless status", touched: 0, status: res.status };
  }
  const text = await res.clone().text(); // original body remains readable
  const { out, touched } = restorePlaceholders(text);
  if (touched === 0) {
    return { action: "retained", reason: "zero replacements", touched: 0, bytes: text.length };
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  e.response = new Response(out, { status: res.status, statusText: res.statusText, headers });
  return { action: "rebuilt", touched, bytes: text.length };
}

// Pure-helper export for the runner's --offline validation suite. Importing
// this module never triggers any of this — hooks only run via host setup().
const __probeInternals = {
  PAIRS,
  restorePlaceholders,
  maskOriginals,
  applyOutboundRequestMask,
  applyInboundResponseRestore,
  BODYLESS_STATUSES,
};
export { __probeInternals };


function maskStrings(value, seen = new Set(), stats = { replacements: 0, assignmentFailures: 0 }) {
  // Deep in-place walk: original -> placeholder (outbound re-mask).
  if (value === null || typeof value !== "object") return stats;
  if (seen.has(value)) return stats;
  seen.add(value);
  const mutateString = (s) => {
    let out = s;
    for (const p of PAIRS) if (out.includes(p.original)) out = out.split(p.original).join(p.placeholder);
    return out;
  };
  const keys = Array.isArray(value)
    ? value.keys()
    : Object.getOwnPropertyNames(value);
  for (const k of keys) {
    try {
      const v = value[k];
      if (typeof v === "string") {
        const next = mutateString(v);
        if (next !== v) {
          value[k] = next;
          stats.replacements++;
        }
      } else if (v !== null && typeof v === "object") {
        maskStrings(v, seen, stats);
      }
    } catch {
      stats.assignmentFailures++;
    }
  }
  return stats;
}

let contextShapeLogged = false;
function logFirstMessageShape(hookName, messages) {
  if (contextShapeLogged) return;
  contextShapeLogged = true;
  try {
    const m = Array.isArray(messages) ? messages[0] : messages;
    log(`${hookName}-message-shape`, {
      ctor: m?.constructor?.name ?? null,
      ownKeys: m && typeof m === "object" ? Object.keys(m) : null,
      protoKeys:
        m && typeof m === "object" && m.constructor?.prototype
          ? Object.getOwnPropertyNames(m.constructor.prototype).slice(0, 30)
          : null,
      jsonSample: (() => {
        try {
          return JSON.stringify(m)?.slice(0, 600);
        } catch {
          return "unserializable";
        }
      })(),
    });
  } catch (err) {
    log(`${hookName}-message-shape-error`, { error: String(err?.message ?? err) });
  }
}

function reMaskRequest(e, hookName) {
  const stats = { replacements: 0, assignmentFailures: 0 };
  for (const key of ["system", "messages"]) {
    if (e[key]) maskStrings(e[key], new Set(), stats);
  }
  if (hookName === "context") logFirstMessageShape(hookName, e.messages);
  log(hookName, {
    replacements: stats.replacements,
    assignmentFailures: stats.assignmentFailures,
    marker: stats.replacements > 0 ? `${hookName}-REMASKED` : null,
  });
}

function resultSample(result) {
  try {
    if (!result) return null;
    if (typeof result.content === "string") return result.content.slice(0, 300);
    if (Array.isArray(result.content)) {
      return result.content
        .map((c) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
        .join(" ")
        .slice(0, 300);
    }
    if (typeof result.output === "string") return result.output.slice(0, 300);
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return null;
  }
}

export default {
  id: "restoration-probe",
  async setup(ctx) {
    scenario = String((ctx.options && ctx.options.scenario) || "?");
    logPath = process.env.SGPROBE_EVENT_LOG || "";
    refuseDir = process.env.SGPROBE_REFUSE_DIR || "";
    if (!logPath) {
      // No sink configured: hooks would be unverifiable. Fail plugin load loudly.
      throw new Error("restoration-probe: SGPROBE_EVENT_LOG env var not set");
    }
    const fs = await import("node:fs");
    appendFn = fs.appendFileSync;
    existsFn = fs.existsSync;
    // Offline-only in-memory sink (final bounded correction): lets the
    // self-contained suite exercise hooks with ZERO filesystem writes
    // (replaces the old /dev/null byte sink). Fake-ctx option only — runtime
    // plugin configs never supply it.
    if (typeof ctx?.options?.offlineEventSink === "function") {
      appendFn = ctx.options.offlineEventSink;
    }
    log("plugin-loaded", {
      app: ctx.app ? { name: ctx.app.name, version: ctx.app.version } : null,
      options: ctx.options ?? null,
    });

    const register = async (domain, name, fn) => {
      try {
        await ctx[domain].hook(name, fn);
        log("registered", { domain, hook: name });
      } catch (err) {
        // A hook name the runtime rejects must be recorded, not swallowed.
        log("register-failed", { domain, hook: name, error: String(err?.message ?? err) });
      }
    };

    // ---- scenario R: bounded recovery controls (R1–R4) -----------------------
    if (scenario === "R") {
      await register("permission", "evaluate", (e) => {
        // Observational only: record what the permission layer evaluates.
        // `effect` is mutable but this probe NEVER overrides it.
        const res = Array.isArray(e.resources) ? e.resources : [];
        log("permission.evaluate", {
          sessionID: e.sessionID,
          action: e.action,
          effect: e.effect,
          resources: res.map((r) => String(r).slice(0, 400)),
          metadataKeys: e.metadata ? Object.keys(e.metadata) : null,
          source: e.source ?? null,
          // Exact attribution ids from the installed declarations
          // (@opencode/plugin 2.0.19 permission.d.ts: Permission.Source =
          // { type: "tool", messageID, id }). These safe synthetic call/
          // message identifiers are what the harness correlates the R4a
          // denial against — an unrelated action/call/message must not pass.
          sourceType: e.source?.type ?? null,
          sourceCallID: e.source?.id ?? null,
          sourceMessageID: e.source?.messageID ?? null,
          resourcesContainOriginal: res.some((r) => String(r).includes("sk-PROBETEST")),
          resourcesContainPlaceholder: res.some((r) => String(r).includes("[SGPROBE-KEY-1]")),
          marker: "SGPROBE-R-EVALUATE-FIRED",
        });
      });
      await register("tool", "execute.before", (e) => {
        const sessionID = e.sessionID;
        // R3 refusal: harness drops a marker file named <sessionID> in
        // $SGPROBE_REFUSE_DIR before arming the refused control.
        if (
          e.tool === "shell" &&
          refuseDir &&
          existsFn(`${refuseDir}/${sessionID}`)
        ) {
          log("tool.execute.before-throw", {
            sessionID,
            tool: e.tool,
            // Installed-declaration attribution ids (tool.d.ts execute.before:
            // id: Tool.CallID, messageID: SessionMessage.ID).
            callID: e.id ?? null,
            messageID: e.messageID ?? null,
            marker: R3_THROW,
          });
          throw new Error(
            `${R3_REFUSED}: unresolved placeholder restoration — refusing shell execution (probe R3)`,
          );
        }
        const cmd = e.input && e.input.command;
        const p = e.input && e.input.path;
        if (e.tool === "shell" && typeof cmd === "string" && cmd.includes("[SGPROBE-KEY-1]")) {
          const { out } = restorePlaceholders(cmd);
          e.input.command = out;
          log("tool.execute.before", {
            sessionID,
            tool: e.tool,
            // Installed-declaration attribution ids (see above).
            callID: e.id ?? null,
            messageID: e.messageID ?? null,
            before: cmd,
            after: e.input.command,
            marker: "RESTORE-R2-COMMAND-MUTATED",
          });
        } else if (e.tool === "read" && typeof p === "string" && p.includes("[SGPROBE-PATH-1]")) {
          const { out } = restorePlaceholders(p);
          e.input.path = out;
          log("tool.execute.before", {
            sessionID,
            tool: e.tool,
            // Installed-declaration attribution ids (see above).
            callID: e.id ?? null,
            messageID: e.messageID ?? null,
            before: p,
            after: e.input.path,
            marker: "RESTORE-R1-PATH-MUTATED",
          });
        } else {
          log("tool.execute.before", {
            sessionID,
            tool: e.tool,
            // Installed-declaration attribution ids (see above).
            callID: e.id ?? null,
            messageID: e.messageID ?? null,
            path: typeof p === "string" ? p.slice(0, 300) : null,
            command: typeof cmd === "string" ? cmd.slice(0, 300) : null,
          });
        }
      });
      await register("tool", "execute.after", (e) => {
        log("tool.execute.after", {
          sessionID: e.sessionID,
          tool: e.tool,
          // Installed-declaration attribution ids (tool.d.ts execute.after:
          // id: Tool.CallID, messageID: SessionMessage.ID) — correlate the
          // R4a refusal error with the armed call.
          callID: e.id ?? null,
          messageID: e.messageID ?? null,
          status: e.status,
          errorText:
            e.status === "error" ? String(e.error?.message ?? e.error).slice(0, 300) : null,
          resultSample: e.status === "completed" ? resultSample(e.result) : null,
        });
      });
    }

    // ---- legacy scenario A ---------------------------------------------------
    if (scenario === "A") {
      await register("tool", "execute.before", (e) => {
        const before = e.input && e.input.path;
        if (e.tool === "read" && before === "mask-notes.txt") {
          e.input.path = "restored-notes.txt"; // mutate in place; d.ts marks input mutable
          log("tool.execute.before", {
            tool: e.tool,
            before,
            after: e.input.path,
            marker: "RESTORE-A-INPUT-MUTATED",
          });
        } else {
          log("tool.execute.before", { tool: e.tool, before: before ?? null });
        }
      });
    }

    // ---- legacy scenario B ---------------------------------------------------
    if (scenario === "B") {
      await register("tool", "execute.before", (e) => {
        const p = e.input && e.input.path;
        log("tool.execute.before", { tool: e.tool, path: p ?? null });
        if (e.tool === "read" && p === "victim-b.txt") {
          log("tool.execute.before-throw", { tool: e.tool, marker: "SGPROBE-B-THROW" });
          throw new Error("SGPROBE-B-THROW: restoration failed (probe B) — refusing tool execution");
        }
      });
      await register("tool", "execute.after", (e) => {
        log("tool.execute.after", {
          tool: e.tool,
          status: e.status,
          errorText: e.status === "error" ? String(e.error?.message ?? e.error).slice(0, 200) : null,
        });
      });
    }

    // ---- legacy scenario C ---------------------------------------------------
    if (scenario === "C") {
      await register("tool", "execute.after", (e) => {
        if (e.status !== "completed") {
          log("tool.execute.after", { tool: e.tool, status: e.status });
          return;
        }
        const r = e.result;
        const mutations = [];
        if (r && typeof r.content === "string") {
          r.content = r.content + ` ${C_MARKER}`;
          mutations.push("content:string");
        } else if (r && Array.isArray(r.content)) {
          r.content = [...r.content, { type: "text", text: C_MARKER }];
          mutations.push("content:array");
        }
        if (r && typeof r.output === "string") {
          r.output = r.output + ` ${C_MARKER}`;
          mutations.push("output:string");
        }
        log("tool.execute.after", {
          tool: e.tool,
          status: e.status,
          mutations,
          marker: mutations.length > 0 ? "RESTORE-C-RESULT-MUTATED" : "RESTORE-C-MUTATION-NOP",
        });
      });
    }

    // ---- legacy session assembly hooks (D: outbound re-mask; E: throw) --------
    if (scenario === "D") {
      await register("session", "context", (e) => reMaskRequest(e, "context"));
      await register("session", "title", (e) => reMaskRequest(e, "title"));
      await register("session", "compaction", (e) => reMaskRequest(e, "compaction"));
      await register("session", "generate", (e) => reMaskRequest(e, "generate"));
    }

    if (scenario === "E") {
      await register("session", "context", (e) => {
        const serialized = JSON.stringify(e.messages ?? []);
        log("context", {
          hasTrigger: serialized.includes(E_TRIGGER),
          marker: "SGPROBE-E-CONTEXT-FIRED",
        });
        if (serialized.includes(E_TRIGGER)) {
          log("context-throw", { marker: "SGPROBE-E-THROW" });
          throw new Error("SGPROBE-E-THROW: context assembly refused (probe E)");
        }
      });
      await register("session", "title", (e) => {
        log("title", { marker: "SGPROBE-E-TITLE-FIRED" });
      });
    }

    // ---- legacy provider transport hooks (D, SOURCE-REPAIRED) -----------------
    if (scenario === "D") {
      await register("session", "model.request", (e) => {
        log("model.request", { kind: e.kind });
      });
      await register("session", "http.request", async (e) => {
        // OUTBOUND re-mask: original -> placeholder (handoff-22 final-oracle
        // repair — the old code reused the placeholder->original replacement
        // here, i.e. RESTORATION in an outbound request). Buffered body
        // rewrite is a capability probe ONLY, NOT a production algorithm.
        // Zero replacements / bodyless methods retain the ORIGINAL request
        // object (body read from a clone); rebuilds drop stale length/
        // encoding headers; errors PROPAGATE.
        try {
          const url = e.request?.url ?? null;
          const res = await applyOutboundRequestMask(e);
          log("http.request", {
            kind: e.kind,
            url,
            action: res.action,
            reason: res.reason ?? null,
            replaced: res.touched,
            bufferedRewriteProbe: true,
            marker: res.action === "rebuilt" ? "MASK-D-HTTPREQ-REMASKED" : null,
          });
        } catch (err) {
          log("http.request-error", { kind: e.kind, error: String(err?.message ?? err) });
          throw err; // propagate: swallowed rewrite errors are probe bugs
        }
      });
      await register("session", "http.response", async (e) => {
        // INBOUND restore: placeholder -> original. Capability probe ONLY.
        // REPAIRED (handoff-22 final oracle): zero-replacement and bodyless
        // (204/205/304) responses RETAIN the original Response object — the
        // body is read from a clone so the original stays usable, and a
        // rebuilt null-body Response would be invalid; rebuilds preserve
        // status/statusText and drop stale content-length/content-encoding/
        // transfer-encoding; rewrite errors PROPAGATE. Still NOT a production
        // streaming algorithm and proves nothing about WebSocket transport,
        // TUI rendering, or UI display.
        try {
          const ct = e.response?.headers?.get?.("content-type") || "";
          const res = await applyInboundResponseRestore(e);
          log("http.response", {
            kind: e.kind,
            contentType: ct,
            action: res.action,
            reason: res.reason ?? null,
            bytes: res.bytes ?? 0,
            replaced: res.touched,
            bufferedRewriteProbe: true,
            marker: res.action === "rebuilt" ? "RESTORE-D-HTTP-REPLACED" : null,
          });
        } catch (err) {
          log("http.response-error", { kind: e.kind, error: String(err?.message ?? err) });
          throw err; // propagate: rewrite failures must surface, not vanish
        }
      });
    }

    // ---- legacy permission ordering (P) ---------------------------------------
    if (scenario === "P") {
      await register("permission", "evaluate", (e) => {
        const res = Array.isArray(e.resources) ? e.resources : [];
        log("permission.evaluate", {
          action: e.action,
          resources: res.map((r) => String(r).slice(0, 300)),
          metadataKeys: e.metadata ? Object.keys(e.metadata) : null,
          source: e.source ?? null,
          effect: e.effect,
          resourcesContainOriginal: res.some((r) => String(r).includes("sk-PROBETEST")),
          resourcesContainPlaceholder: res.some((r) => String(r).includes("[SGPROBE-KEY-1]")),
          marker: "SGPROBE-P-EVALUATE-FIRED",
        });
      });
      await register("tool", "execute.before", (e) => {
        const cmd = e.input && e.input.command;
        if ((e.tool === "shell" || e.tool === "bash") && typeof cmd === "string" && cmd.includes("[SGPROBE-KEY-1]")) {
          e.input.command = cmd.split("[SGPROBE-KEY-1]").join("sk-PROBETEST1234567890abcdef");
          log("tool.execute.before", {
            tool: e.tool,
            before: cmd,
            after: e.input.command,
            marker: "RESTORE-P-INPUT-MUTATED",
          });
        } else {
          log("tool.execute.before", { tool: e.tool, command: typeof cmd === "string" ? cmd.slice(0, 200) : null });
        }
      });
      await register("tool", "execute.after", (e) => {
        log("tool.execute.after", {
          tool: e.tool,
          status: e.status,
          errorText: e.status === "error" ? String(e.error?.message ?? e.error).slice(0, 300) : null,
          resultSample: e.status === "completed" ? resultSample(e.result) : null,
        });
      });
    }

    log("setup-complete", { scenario });
    return () => {
      log("plugin-cleanup", { scenario });
    };
  },
};

/** Synthetic host-only verification. Never calls a model or executes a tool. */
import { renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createTransparentSessionGuard } from "../../../dist/opencode-transparent.js";

const EMAIL = "lifecycle-canary@example.org";
const config = {
  nda_keywords: [], private_domains: [], custom_rules: [],
  settings: { max_chars: 200000, show_line_numbers: false, encoding_detection: true },
};
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export default {
  id: "sg-native-lifecycle-verification",
  async setup(ctx) {
    const resultPath = resolve(ctx.options.resultPath);
    if (dirname(resultPath) !== resolve(ctx.location.directory) ||
      !basename(ctx.location.directory).startsWith("sg-native-lifecycle-") || basename(resultPath) !== "result.json") {
      throw new Error("Invalid lifecycle evidence location.");
    }
    const hooks = new Map();
    const session = new Proxy(ctx.session, { get(target, key) {
      if (key !== "hook") return Reflect.get(target, key, target);
      return async (name, callback) => {
        hooks.set(`session:${name}`, callback);
        return target.hook(name, callback);
      };
    } });
    const tool = new Proxy(ctx.tool, { get(target, key) {
      if (key !== "hook") return Reflect.get(target, key, target);
      return async (name, callback) => {
        hooks.set(`tool:${name}`, callback);
        return target.hook(name, callback);
      };
    } });
    const guard = createTransparentSessionGuard(config, "block", false);
    await guard.setup(new Proxy(ctx, { get(target, key) {
      return key === "session" ? session : key === "tool" ? tool : Reflect.get(target, key, target);
    } }));
    const controller = new AbortController();
    const observed = new Set();
    let eventStreamFailed = false;
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          if (event.type === "session.deleted") observed.add(event.data.sessionID);
        }
      } catch { if (!controller.signal.aborted) eventStreamFailed = true; }
    })();

    const created = [];
    const remaining = new Set();
    const route = { kind: "primary", model: { providerID: "synthetic", id: "not-dispatched" } };
    const prepare = async (sessionID) => {
      const event = { ...route, sessionID, system: [], messages: [{ role: "user", content: [{ type: "text", text: EMAIL }] }], options: {} };
      await hooks.get("session:context")(event);
      return event.messages[0].content[0].text;
    };
    // Invoke the guard's planning hook only; never the host's tool executor.
    const restore = async (sessionID, token) => {
      const event = { sessionID, tool: "write", input: { content: token } };
      await hooks.get("tool:execute.before")(event);
      return event.input.content;
    };
    const receive = async (sessionID, body) => {
      const event = { ...route, sessionID, frame: JSON.stringify(body) };
      await hooks.get("session:experimental.ws.receive")(event);
      return JSON.parse(event.frame);
    };
    const makeSession = async () => {
      const session = await ctx.session.create({ title: "Synthetic LeakShield lifecycle verification" });
      created.push(session.id);
      remaining.add(session.id);
      return session.id;
    };
    const check = (value, code) => { if (!value) throw new Error(code); };

    // Do not block plugin setup on host actions that require an active location.
    const verification = (async () => {
      await pause(50);
      const result = { passed: false, nativeSessionCount: 0, modelDispatches: 0, toolExecutions: 0, cases: {} };
      try {
        const removed = await makeSession();
        const kept = await makeSession();
        const removedToken = await prepare(removed);
        const keptToken = await prepare(kept);
        for (const [sessionID, token] of [[removed, removedToken], [kept, keptToken]]) {
          await receive(sessionID, { type: "response.created", response: { id: sessionID } });
          const prefix = await receive(sessionID, { type: "response.output_text.delta", response_id: sessionID, delta: token.slice(0, 15) });
          check(prefix.delta === "", "ws_prefix_not_buffered");
        }
        // Synthetic hook scopes fill the guard, not 4,096 host DB sessions.
        for (let i = 2; i < 4096; i++) await prepare(`lifecycle-synthetic-${i}`);
        let refusedAtCeiling = false;
        try { await prepare("lifecycle-over-capacity"); }
        catch (error) { refusedAtCeiling = String(error).includes("stage=session.track reason=session_limit"); }
        check(refusedAtCeiling, "session_ceiling_not_enforced");
        result.cases.ceilingRefusedAtomically = true;
        check(await restore(kept, keptToken) === EMAIL, "live_mapping_lost_before_deletion");
        await ctx.session.remove({ sessionID: removed });
        remaining.delete(removed);
        for (let i = 0; i < 100 && !observed.has(removed); i++) await pause(20);
        check(observed.has(removed) && !eventStreamFailed, "native_deletion_event_missing");
        result.cases.nativeDeletionDelivered = true;
        let orphanRefused = false;
        for (let i = 0; i < 100 && !orphanRefused; i++) {
          try { await restore(removed, removedToken); }
          catch (error) { orphanRefused = String(error).includes("placeholder has no mapping"); }
          if (!orphanRefused) await pause(20);
        }
        check(orphanRefused, "deleted_mapping_not_reclaimed");
        result.cases.deletedMappingRefused = true;
        const late = await receive(removed, { type: "response.output_text.delta", response_id: removed, delta: removedToken.slice(15) });
        check(late.delta === removedToken.slice(15), "deleted_ws_lane_survived");
        const continued = await receive(kept, { type: "response.output_text.delta", response_id: kept, delta: keptToken.slice(15) });
        check(continued.delta === EMAIL, "unrelated_ws_prefix_lost");
        result.cases.wsDeletedLaneClearedOtherLaneRetained = true;
        const replacement = await makeSession();
        check((await prepare(replacement)) !== EMAIL, "replacement_not_masked");
        check(await restore(kept, keptToken) === EMAIL, "unrelated_mapping_lost");
        result.cases.capacityReusedWithoutLiveEviction = true;
        result.passed = true;
      } catch (error) {
        const code = error instanceof Error ? error.message : "unknown_verification_error";
        // Our assertion codes are static; raw host errors never enter evidence.
        result.failureCode = /^[a-z_]+$/.test(code) ? code : "host_or_guard_error";
      } finally {
        result.nativeSessionCount = created.length;
        for (const sessionID of remaining) {
          try { await ctx.session.remove({ sessionID }); remaining.delete(sessionID); } catch { /* Mark incomplete cleanup below. */ }
        }
        result.testSessionsCleaned = remaining.size === 0;
        result.passed = result.passed && result.testSessionsCleaned;
        writeFileSync(`${resultPath}.pending`, JSON.stringify(result, null, 2), { mode: 0o600 });
        renameSync(`${resultPath}.pending`, resultPath);
      }
    })();
    return async () => {
      controller.abort();
      await verification;
      await guard.dispose();
    };
  },
};

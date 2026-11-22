import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { launchManagedLab, checkManagedProxy } from "./managed-launch.mjs";

const execute = promisify(execFile);
assert.ok(process.argv[2], "Usage: node run-managed.mjs /path/to/pi");
const pi = resolve(process.argv[2]);
const launcher = resolve(import.meta.dirname, "managed-launch.mjs");
const workspace = await mkdtemp(join(tmpdir(), "pi98-managed-test-"));
const canary = "PI98_PRIVATE_VALUE";
const requests = [];
const servers = [];
const providers = {};
for (const name of ["alpha", "beta"]) {
  const apiKey = "synthetic-upstream-only-" + name;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ name, body, authorized: request.headers.authorization === "Bearer " + apiKey });
    if (request.headers.authorization !== "Bearer " + apiKey) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({error:{message:"Stub credential refused"}}));
      return;
    }
    const token = body.match(/\[SGP2:[^\]]+\]/)?.[0];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: " + JSON.stringify({
      id:"stub",object:"chat.completion.chunk",created:1,model:"stub-model",
      choices:[{index:0,delta:{role:"assistant",content:token ?? "ok"},finish_reason:"stop"}],
    }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  providers[name] = {
    api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    model: "stub-model", apiKey,
  };
}
const configuration = { providers };
// Synthetic ambient keys must be removed from the pi child environment.
process.env.OPENAI_API_KEY = "synthetic-parent-openai";
process.env.ANTHROPIC_API_KEY = "synthetic-parent-anthropic";

function rpc(run) {
  const events = new EventEmitter();
  const lines = createInterface({ input: run.child.stdout });
  lines.on("line", (line) => events.emit("message", JSON.parse(line)));
  let stderr = "";
  run.child.stderr.on("data", (chunk) => { stderr += chunk; });
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("RPC timed out: " + stderr)); }, 10000);
      function cleanup() { clearTimeout(timer); events.off("message", accept); }
      function accept(event) { if (predicate(event)) { cleanup(); resolve(event); } }
      events.on("message", accept);
    });
  }
  return {
    async command(command) {
      const id = randomUUID();
      const pending = waitFor((event) => event.type === "response" && event.id === id);
      run.child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
      return pending;
    },
    async prompt() {
      const pending = waitFor((event) => event.type === "agent_end");
      run.child.stdin.write(JSON.stringify({ type: "prompt", message: canary }) + "\n");
      await pending;
    },
    close: () => lines.close(),
  };
}

async function runCli(file, args) {
  const pending = execute(process.execPath, [launcher, "--pi", pi, "--config", file, ...args], {
    cwd: workspace, timeout: 20000,
  });
  pending.child.stdin.end();
  try { return { code: 0, ...await pending }; }
  catch (error) {
    assert.equal(error.killed, false, "CLI test must finish without a timeout");
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

try {
  const extensionDir = join(workspace,".pi","extensions");
  await mkdir(extensionDir,{recursive:true});
  const ambientSentinel = join(workspace,"ambient-extension-loaded");
  const ambientExtension = join(extensionDir,"ambient.mjs");
  await writeFile(ambientExtension,
    'import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(ambientSentinel) +
    ',"loaded"); export default function() {}');
  await writeFile(join(workspace,".pi","settings.json"),JSON.stringify({
    packages:[ambientExtension],
  }));
  for (const name of ["alpha", "beta"]) {
    requests.length = 0;
    const run = await launchManagedLab({ pi, configuration, provider: name, mode: "rpc", cwd: workspace });
    const client = rpc(run);
    try {
      const modelConfig = await readFile(join(run.directory, "models.json"), "utf8");
      assert.ok(!modelConfig.includes(providers[name].apiKey));
      assert.ok(!modelConfig.includes(providers[name].baseUrl));
      assert.deepEqual(Object.keys(JSON.parse(modelConfig).providers), [name]);
      assert.equal(run.env.OPENAI_API_KEY, undefined);
      assert.equal(run.env.ANTHROPIC_API_KEY, undefined);
      assert.ok(!JSON.stringify(run.env).includes(providers[name].apiKey));
      await checkManagedProxy(run.origin, run.credential, run.sessionID);
      assert.equal(requests.length, 0, "Startup check must not send a provider request");
      await assert.rejects(checkManagedProxy(run.origin, "wrong", run.sessionID));
      await assert.rejects(checkManagedProxy(run.origin, run.credential, randomUUID()));
      const available = await client.command({type:"get_available_models"});
      assert.deepEqual(available.data.models.map((model) => model.provider + "/" + model.id),
        [name + "/stub-model"]);
      const native = await client.command({type:"set_model",provider:"openai",modelId:"gpt-4.1"});
      assert.equal(native.success,false);
      await assert.rejects(access(ambientSentinel));
      const state = await client.command({type:"get_state"});
      assert.equal(state.data.model.provider, name);
      const switched = await client.command({
        type:"set_model", provider:name === "alpha" ? "beta" : "alpha", modelId:"stub-model",
      });
      assert.equal(switched.success, false);
      await client.prompt();
      assert.equal(requests.length, 1);
      assert.equal(requests[0].name, name);
      assert.equal(requests[0].authorized, true);
      assert.ok(!requests[0].body.includes(canary));
      assert.ok(!requests[0].body.includes(run.credential));
      console.log(JSON.stringify({name:"managed-provider-" + name,selectedProviderOnly:true,
        proxyCredentialSeparated:true,ambientKeysExcluded:true,ambientExtensionsExcluded:true,nativeModelSwitchRefused:true,upstreamCredentialApplied:true,payloadMasked:true}));
      await run.stopProxy();
      await assert.rejects(checkManagedProxy(run.origin, run.credential, run.sessionID));
      const before = requests.length;
      await client.prompt();
      assert.equal(requests.length, before);
      console.log(JSON.stringify({name:"proxy-stopped-" + name,upstreamRequests:0,noDirectFallback:true}));
    } finally {
      client.close();
      await run.stop();
      await assert.rejects(access(run.directory));
    }
  }

  requests.length = 0;
  const wrongVersion = join(workspace, "wrong-pi");
  await writeFile(wrongVersion, "#!/usr/bin/env node\nconsole.log('1.5.0');\n", {mode:0o700});
  await chmod(wrongVersion, 0o700);
  await assert.rejects(launchManagedLab({pi:wrongVersion,configuration,provider:"alpha"}), /1.6.0/);
  await assert.rejects(launchManagedLab({pi,configuration,provider:"unknown"}), /Unknown provider/);
  for (const update of [
    {api:"anthropic-messages"}, {model:"other"}, {baseUrl:"http://example.com/v1"},
    {baseUrl:providers.alpha.baseUrl + "?route=direct"}, {extra:"unsupported"},
  ]) {
    const invalid = {providers:{alpha:{...providers.alpha,...update}}};
    await assert.rejects(launchManagedLab({pi,configuration:invalid,provider:"alpha"}));
  }
  await assert.rejects(launchManagedLab({pi,configuration,provider:"alpha",extraArgs:["--api-key","override"]}));
  assert.equal(requests.length, 0);
  console.log(JSON.stringify({name:"startup-denials",wrongVersion:true,unknownProvider:true,
    unsupportedApi:true,unsupportedModel:true,remoteEndpoint:true,urlOverride:true,
    unknownSetting:true,launchOverride:true,upstreamRequests:0}));

  const file = join(workspace,"providers.json");
  await writeFile(file,JSON.stringify(configuration),{mode:0o600});
  const valid = await runCli(file,["--provider","alpha","--message",canary]);
  assert.equal(valid.code,0,valid.stderr);
  assert.equal(requests.length,1);
  assert.ok(!requests[0].body.includes(canary));
  console.log(JSON.stringify({name:"managed-cli",exit:0,payloadMasked:true}));
  const before = requests.length;
  const bypass = await runCli(file,["--provider","alpha","--base-url",providers.alpha.baseUrl]);
  assert.equal(bypass.code,1);
  await writeFile(file,"{");
  const malformed = await runCli(file,["--provider","alpha"]);
  assert.equal(malformed.code,1);
  assert.equal(requests.length,before);
  console.log(JSON.stringify({name:"cli-config-override-denied",unknownFlagBlocked:true,malformedJsonBlocked:true}));

  const wrongCredential = {providers:{beta:{...providers.beta,apiKey:"synthetic-invalid"}}};
  await writeFile(file,JSON.stringify(wrongCredential),{mode:0o600});
  const refused = await runCli(file,["--provider","beta","--message",canary]);
  assert.equal(refused.code,1);
  assert.equal(requests.length,before + 1);
  assert.equal(requests.at(-1).name,"beta");
  assert.equal(requests.at(-1).authorized,false);
  assert.ok(!requests.at(-1).body.includes(canary));
  console.log(JSON.stringify({name:"upstream-credential-refused",exit:1,payloadMasked:true,noProviderFallback:true}));

  await new Promise((resolve) => servers[1].close(resolve));
  const failing = await launchManagedLab({pi,configuration,provider:"beta",message:canary,cwd:workspace});
  failing.child.stdout.resume();
  failing.child.stderr.resume();
  const failed = await failing.completion;
  assert.equal(failed.code,1);
  assert.equal(requests.length,before + 1);
  console.log(JSON.stringify({name:"upstream-unavailable",exit:1,noProviderFallback:true}));
} finally {
  for (const server of servers) server.close();
  await rm(workspace,{recursive:true,force:true});
}

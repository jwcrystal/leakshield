import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createWireLab } from "./wire-proxy.mjs";

const execPromise = promisify(execFile);
function execute(...args) {
  const pending = execPromise(...args);
  pending.child.stdin.end();
  return pending;
}
assert.ok(process.argv[2], "Usage: node run-lifecycle.mjs /path/to/pi");
const cli = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, "../../..");
const extension = resolve(import.meta.dirname, "wire-extension.mjs");
const workspace = await mkdtemp(join(tmpdir(), "pi98-lifecycle-"));
const canary = "PI98_PRIVATE_VALUE";
const piSessionID = randomUUID();
const coreSessionID = randomUUID();
const key = randomBytes(32);
const captures = [];
let token;
let readNext = false;
let nextTool;
let replyLabel = "ASSISTANT_REPLY";
let lab;
let brokerUrl;
let agentDir;
let sessionFile;
const upstream = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  captures.push(payload);
  token ??= body.match(/\[SGP2:[^\]]+\]/)?.[0];
  assert.ok(token, "First protected prompt must mint a token");
  const choice = readNext || nextTool
    ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: randomUUID(), type: "function",
        function: { name: nextTool?.name ?? "read", arguments: JSON.stringify(nextTool?.input ?? {path:token + ".txt"}) } }] }, finish_reason:"tool_calls" }
    : { delta: { role:"assistant", content:replyLabel + " " + token }, finish_reason:"stop" };
  readNext = false;
  nextTool = undefined;
  response.writeHead(200, {"content-type":"text/event-stream"});
  response.end("data: " + JSON.stringify({
    id:"stub",object:"chat.completion.chunk",created:1,model:"stub-model",choices:[{index:0,...choice}],
  }) + "\n\ndata: [DONE]\n\n");
});
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function environment() {
  return {PATH:process.env.PATH, HOME:workspace, PI_CODING_AGENT_DIR:agentDir,
    NO_PROXY:"127.0.0.1", no_proxy:"127.0.0.1",
    PI_OFFLINE:"1", PI98_BROKER_URL:brokerUrl, PI98_BROKER_KEY:lab.credential,
    TERM:"xterm-256color"};
}
function argumentsForPi(rpc = true, disableExtensions = false) {
  return ["--offline", ...(rpc ? ["--mode","rpc"] : ["--tui-mode","regular"]),
    ...(disableExtensions ? ["--no-extensions"] : []),
    "--no-mcp","--tools","read,write,edit,bash","--no-skills","--no-prompt-templates","--no-context-files","--no-approve",
    "--model","loopback/stub-model","--system-prompt",canary,
    ...(sessionFile ? ["--session",sessionFile] : ["--session-id",piSessionID,"--session-dir",workspace]),
  ];
}
function startRpc(disableExtensions = false, headerFailure) {
  const child = spawn(cli, argumentsForPi(true, disableExtensions), {
    cwd:workspace, env:{...environment(),PI98_HEADER_FAILURE:headerFailure ?? ""},
    stdio:["pipe","pipe","pipe"],
  });
  let stderr = "";
  child.stderr.on("data",(chunk) => { stderr += chunk; });
  const events = new EventEmitter();
  const lines = createInterface({input:child.stdout});
  lines.on("line",(line) => events.emit("message",JSON.parse(line)));
  const closed = new Promise((resolve,reject) => {
    child.once("error",reject);
    child.once("close",resolve);
  });
  function waitFor(predicate) {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error("RPC timed out: " + stderr)); },10000);
      function cleanup() { clearTimeout(timer); events.off("message",accept); }
      function accept(event) { if (predicate(event)) { cleanup(); resolve(event); } }
      events.on("message",accept);
    });
  }
  return {
    async command(command) {
      const id = randomUUID();
      const pending = waitFor((event) => event.type === "response" && event.id === id);
      child.stdin.write(JSON.stringify({...command,id}) + "\n");
      return pending;
    },
    async prompt(message) {
      const pending = waitFor((event) => event.type === "agent_end");
      child.stdin.write(JSON.stringify({type:"prompt",id:randomUUID(),message}) + "\n");
      await pending;
    },
    async close() { child.stdin.end(); child.kill(); await closed; lines.close(); },
  };
}
async function restartProxy(upstreamUrl, persist) {
  if (lab) await new Promise((resolve) => lab.server.close(resolve));
  lab = createWireLab(upstreamUrl + "/v1/chat/completions", {
    sessionID:coreSessionID, piSessionID,
    persistence:persist ? {
      ttlDays:7, path:join(workspace,"mapping.db"), keyFile:false,
      keyProvider:{getOrCreateKey:() => key},
    } : undefined,
  });
  brokerUrl = await listen(lab.server);
  await writeFile(join(agentDir,"models.json"),JSON.stringify({
    providers:{loopback:{baseUrl:brokerUrl + "/v1",api:"openai-completions",apiKey:lab.credential,
      models:[{id:"stub-model"}]}},
  }));
}
function assertMasked() {
  assert.ok(captures.every((payload) => !JSON.stringify(payload).includes(canary)));
}
async function resumedRead(name) {
  const before = captures.length;
  const rpc = startRpc();
  try {
    readNext = true;
    await rpc.prompt("Read the protected filename from the previous turn.");
    assert.equal(captures.length,before + 2);
    const result = captures.at(-1).messages.findLast((message) => message.role === "tool");
    assert.ok(JSON.stringify(result).includes("tool output"), "Restored filename must reach real read");
    assertMasked();
    console.log(JSON.stringify({name,oldTokenRestored:true,providerRaw:false}));
  } finally { await rpc.close(); }
}

try {
  agentDir = await mkdtemp(join(workspace,"agent-"));
  const upstreamUrl = await listen(upstream);
  await restartProxy(upstreamUrl,true);
  await writeFile(join(agentDir,"settings.json"),JSON.stringify({
    compaction:{enabled:false,keepRecentTokens:1,reserveTokens:100},retry:{enabled:false},quietStartup:true,
  }));
  await writeFile(join(workspace,canary + ".txt"),canary + " tool output");
  const install = await execute(cli,["install",extension],{
    cwd:workspace,env:environment(),timeout:20000,
  });
  const settings = JSON.parse(await readFile(join(agentDir,"settings.json"),"utf8"));
  assert.ok(JSON.stringify(settings).includes("wire-extension.mjs"),install.stderr);
  console.log(JSON.stringify({name:"pi-local-install",settingsRegistered:true}));

  const rpc = startRpc();
  try {
    await rpc.prompt(canary);
    assert.equal(captures.length,1);
    const state = await rpc.command({type:"get_state"});
    assert.equal(state.data.sessionId,piSessionID);
    sessionFile = state.data.sessionFile;
    assert.ok(sessionFile);
    const entries = await rpc.command({type:"get_entries"});
    assert.ok(entries.success);
    assertMasked();
  } finally { await rpc.close(); }
  const saved = (await readFile(sessionFile,"utf8")).trim().split("\n").map(JSON.parse);
  const assistant = saved.filter((entry) => entry.message?.role === "assistant");
  assert.ok(assistant.some((entry) => JSON.stringify(entry).includes(token)));
  assert.ok(assistant.every((entry) => !JSON.stringify(entry).includes(canary)));
  console.log(JSON.stringify({name:"session-save",assistantPersistedMasked:true}));

  await resumedRead("pi-process-restart");
  await restartProxy(upstreamUrl,true);
  await resumedRead("proxy-and-pi-restart");
  assert.ok(!(await readFile(join(workspace,"mapping.db"))).includes(Buffer.from(canary)));
  console.log(JSON.stringify({name:"encrypted-core-store",plaintextCanaryAbsent:true}));

  const switching = startRpc();
  try {
    const fresh = await switching.command({type:"new_session"});
    assert.ok(fresh.success);
    const state = await switching.command({type:"get_state"});
    assert.notEqual(state.data.sessionId,piSessionID);
    const before = captures.length;
    await switching.prompt(canary);
    assert.equal(captures.length,before,"Foreign session must be refused before the upstream");
    const restore = await switching.command({type:"switch_session",sessionPath:sessionFile});
    assert.ok(restore.success);
    await switching.prompt("Continue the original session.");
    assert.equal(captures.length,before + 1);
    assertMasked();
    console.log(JSON.stringify({name:"session-switch",foreignSessionBlocked:true,originalSessionResumed:true}));
    const compactBefore = captures.length;
    const compact = await switching.command({type:"compact",customInstructions:canary});
    assert.ok(compact.success,JSON.stringify(compact));
    assert.equal(captures.length,compactBefore + 2);
    assertMasked();
    console.log(JSON.stringify({name:"bound-session-compaction",success:true,providerRaw:false}));
  } finally { await switching.close(); }

  const disabled = startRpc(true);
  try {
    const before = captures.length;
    await disabled.prompt(canary);
    assert.equal(captures.length,before);
    console.log(JSON.stringify({name:"bound-session-extension-disabled",upstreamRequests:0}));
  } finally { await disabled.close(); }

  for (const failure of ["throw", "reject"]) {
    const headerError = startRpc(false, failure);
    try {
      const before = captures.length;
      await headerError.prompt(canary);
      assert.equal(captures.length,before);
      console.log(JSON.stringify({name:"session-header-" + failure,upstreamRequests:0}));
    } finally { await headerError.close(); }
  }

  replyLabel = "TUI_RESTORED_REPLY";
  const driver = `
import fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
data = b""
deadline = time.monotonic() + 15
matched = False
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:
            break
        data += chunk
        if b"\\x1b[6n" in chunk:
            os.write(master, b"\\x1b[1;1R")
        if b"TUI_RESTORED_REPLY PI98_PRIVATE_VALUE" in data:
            matched = True
            break
finally:
    child.terminate()
    try:
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
print(json.dumps({"matched":matched,"transcript":data.decode("utf8",errors="replace")}))
`;
  const terminal = await execute("python3",["-c",driver,cli,...argumentsForPi(false),"Show the protected value."],{
    cwd:workspace,env:environment(),timeout:20000,maxBuffer:4 * 1024 * 1024,
  });
  const ui = JSON.parse(terminal.stdout);
  const rendered = stripVTControlCharacters(ui.transcript);
  assert.ok(ui.matched,rendered);
  assert.ok(!rendered.includes("PI98_DISPLAY"),"TUI proof must come from rendered Markdown");
  assertMasked();
  console.log(JSON.stringify({name:"real-interactive-pty",assistantMarkdownRestored:true,providerRaw:false}));

  await restartProxy(upstreamUrl,false);
  const lost = startRpc();
  try {
    const before = captures.length;
    readNext = true;
    await lost.prompt("Read the old protected filename.");
    assert.equal(captures.length,before + 2);
    const failedTool = captures.at(-1).messages.findLast((message) => message.role === "tool");
    assert.ok(JSON.stringify(failedTool).includes("Wire lab tool refused"));
    assert.ok(!JSON.stringify(failedTool).includes("tool output"));
    assertMasked();
    console.log(JSON.stringify({name:"mapping-loss",oldTokenToolBlocked:true,providerRaw:false}));
  } finally { await lost.close(); }

  for (const tool of [
    {name:"bash",input:{command:"printf " + token + " > blocked-output.txt"}},
    {name:"write",input:{path:"blocked-output.txt",content:token}},
    {name:"edit",input:{path:canary + ".txt",oldText:token,newText:"changed"}},
  ]) {
    const guarded = startRpc();
    try {
      nextTool = tool;
      await guarded.prompt("Run the requested tool.");
      const result = captures.at(-1).messages.findLast((message) => message.role === "tool");
      assert.ok(JSON.stringify(result).includes("Wire lab tool refused"),JSON.stringify(result));
      assert.equal(await readFile(join(workspace,canary + ".txt"),"utf8"),canary + " tool output");
      await assert.rejects(readFile(join(workspace,"blocked-output.txt")));
      assertMasked();
      console.log(JSON.stringify({name:"unsupported-tool-" + tool.name,executionBlocked:true}));
    } finally { await guarded.close(); }
  }

  const packageDir = await mkdtemp(join(workspace,"package-"));
  const packed = await execute("npm",["--cache","/tmp/leakshield-npm","pack","--ignore-scripts",
    "--pack-destination",packageDir,"--json"],{cwd:root,timeout:20000});
  const tarball = JSON.parse(packed.stdout)[0].filename;
  const cleanInstall = await mkdtemp(join(workspace,"clean-install-"));
  await execute("npm",["--cache","/tmp/leakshield-npm","install","--prefix",cleanInstall,
    "--ignore-scripts","--no-audit","--no-fund",join(packageDir,tarball)],{timeout:30000});
  const imported = await execute(process.execPath,["--input-type=module","-e",
    'import {createGuardCore} from "leakshield/core"; console.log(typeof createGuardCore);'],
    {cwd:cleanInstall,timeout:10000});
  assert.equal(imported.stdout.trim(),"function");
  const pkg = JSON.parse(await readFile(join(cleanInstall,"node_modules/leakshield/package.json"),"utf8"));
  assert.equal(pkg.exports["./pi"],undefined);
  console.log(JSON.stringify({name:"clean-npm-install",coreImportWorks:true,piAdapterPublished:false}));
} finally {
  if (lab) await new Promise((resolve) => lab.server.close(resolve));
  upstream.close();
  await rm(workspace,{recursive:true,force:true});
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, renameSync, copyFileSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexSwapHistoryPath } from "../../v2/daemon/src/codexSwapHistory.ts";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";
const proof = resolve(".proof/D");
const rpcLog = join(proof, "rpc.jsonl");
const effects = join(proof, "effects.jsonl");
const lateEffects = join(proof, "late-effects.jsonl");
const journal = join(proof, "lab.jsonl");
const rows = path => existsSync(path) ? readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const prior = [rpcLog, effects, lateEffects, journal].filter(existsSync);
if (prior.length) {
  const archive = join(proof, `run-${Date.now()}`);
  mkdirSync(archive);
  for (const file of prior) renameSync(file, join(archive, file.split("/").at(-1)));
}
const record = value => appendFileSync(journal, JSON.stringify(value) + "\n");
const {dir} = makeDaemonDir({ agents: { codex: { command: process.execPath, args: [resolve("v2/driver-hsr/test-agent/fake-codex.mjs"), "app-server"], adapter: "codex", env: {FAKE_CODEX_STRICT_HOME:"1", FAKE_CODEX_RPC_LOG:rpcLog, FAKE_CODEX_EFFECT_LOG:effects,FAKE_CODEX_LATE_EFFECT_LOG:lateEffects} } } });
record({ labDir: dir, strictHome: true });
for (const id of ["codex-a", "codex-b"]) {
  const vault = join(dir, "vault", "codex", id);
  mkdirSync(vault, {recursive:true});
  writeFileSync(join(vault, "auth.json"), JSON.stringify({tokens:{access_token:"synthetic-fixture-not-a-credential"}}));
}
let daemon;
let client;
try {
 daemon = await startDaemon(dir);
 client = await daemon.client();
 const request = async (method, params) => {
   try { const result = await client.request(method, params); record({method, params, result}); return result; }
   catch(error) { record({method, params, error:{code:error.code,message:error.message}}); throw error; }
 };
 const view = beeId => client.request("view", {beeId});
 const idle = async (beeId, generation) => waitFor(async()=>{const v=await view(beeId); return v.view.runtimeState === "idle" && v.view.generation === generation ? v : null;}, "idle generation " + generation, 20000);
 const send = async (beeId, body, generation) => {
   const sent = await request("send", {beeId,body});
   await waitFor(async()=>{const r=await client.request("mailbox",{beeId}); return r.messages.some(m=>m.id===sent.messageId && m.deliveredGeneration===generation);}, "delivered",20000);
   return idle(beeId,generation);
 };
 for (const label of ["a","b"]) await request("account.add",{harness:"codex",label,importExisting:true});
 const {beeId} = await request("spawn",{name:"continuity",agent:"codex",cwd:dir,account:"codex-a"});
 const before = await send(beeId,"@remember:nonce-D-secret-free",1);
 const id = before.bee.providerSessionId;
 assert.ok(id);
 const invisibleHome = join(dir,"homes","codex-b");
 mkdirSync(invisibleHome,{recursive:true});
 const rejected = spawnSync(process.execPath,[resolve("v2/driver-hsr/test-agent/fake-codex.mjs")],{input:JSON.stringify({id:99,method:"thread/resume",params:{threadId:id}})+"\n",encoding:"utf8",env:{HOME:process.env.HOME,PATH:process.env.PATH,CODEX_HOME:invisibleHome,FAKE_CODEX_STRICT_HOME:"1"}});
 assert.equal(JSON.parse(rejected.stdout.trim()).error.message,"rollout unavailable in CODEX_HOME");
 record({stage:"resume-by-id-alone-refused",response:JSON.parse(rejected.stdout.trim())});
 record({stage:"source",beeId,account:before.bee.account,sessionId:id,generation:before.view.generation});
 const swap = await request("bee.swapAccount",{beeId,account:"codex-b",idempotencyKey:"D-swap"});
 assert.equal(swap.transcript,"present");
 const after = await send(beeId,"@recall",2);
 assert.equal(after.bee.account,"codex-b");
 assert.equal(after.bee.providerSessionId,id);
 assert.equal(rows(effects).length,1);
 assert.equal(rows(effects)[0].reply,"recall:nonce-D-secret-free");
 assert.equal(rows(effects)[0].home,join(dir,"homes","codex-b"));
 const resume = rows(rpcLog).find(r=>r.method==="thread/resume" && r.env.CODEX_HOME===join(dir,"homes","codex-b"));
 assert.ok(resume?.params.path?.startsWith(join(dir,"homes","codex-b","sessions")+"/"));
 record({stage:"continuity-passed",account:after.bee.account,generation:after.view.generation,sessionId:id,resumePath:resume.params.path,effects:rows(effects)});
 await request("stop",{beeId});
 await waitFor(async()=>(await view(beeId)).view.runtimeState==="stopped","stopped");
 const back = await request("bee.swapAccount",{beeId,account:"codex-a"});
 assert.equal(back.transcript,"present");
 await send(beeId,"@remember:nonce-D-roundtrip",3);
 const repeated = await request("bee.swapAccount",{beeId,account:"codex-b"});
 assert.equal(repeated.transcript,"present");
 await send(beeId,"@slow:5",4);
 const resumed = rows(rpcLog).filter(r=>r.method==="thread/resume").at(-1);
 assert.ok(readFileSync(resumed.params.path,"utf8").includes("nonce-D-roundtrip"));
 record({stage:"roundtrip-passed",generation:4,effectCount:rows(effects).length,nonce:JSON.parse(readFileSync(resumed.params.path,"utf8").trim().split("\n").filter(line=>JSON.parse(line).type==="fixture_nonce").at(-1)).nonce});
 const late = await request("spawn",{name:"late-effect",agent:"codex",cwd:dir,account:"codex-a"});
 await send(late.beeId,"@remember:late-memory",1);
 const pending = await request("send",{beeId:late.beeId,body:"@lateEffect:late-tool-D @slow:30000"});
 await waitFor(async()=>{const r=await client.request("mailbox",{beeId:late.beeId});return r.messages.some(m=>m.id===pending.messageId && m.deliveredAt);},"late turn accepted");
 await waitFor(()=>rows(rpcLog).some(r=>r.method==="turn/start" && JSON.stringify(r.params).includes("@lateEffect")),"late turn started");
 await request("bee.swapAccount",{beeId:late.beeId,account:"codex-b"});
 await send(late.beeId,"@checkLate",2);
 const recall = rows(rpcLog).find(r=>r.method==="fixture/lateRecall");
 assert.equal(recall.params.reply,"late:late-tool-D");
 assert.equal(rows(lateEffects).length,1);
 record({stage:"late-effect-passed",reply:recall.params.reply,effects:rows(lateEffects)});
 const missing = await request("spawn",{name:"missing",agent:"codex",cwd:dir,account:"codex-a"});
 const missingBefore = await send(missing.beeId,"@remember:missing-nonce",1);
 const sourcePath=join(dir,"homes","codex-a","sessions",`rollout-${missingBefore.bee.providerSessionId}.jsonl`);
 const collision = codexSwapHistoryPath(join(dir,"homes","codex-b"),missing.beeId,missingBefore.bee.providerSessionId);
 mkdirSync(collision);
 await assert.rejects(()=>request("bee.swapAccount",{beeId:missing.beeId,account:"codex-b"}),e=>e.code==="transcript_unavailable");
 assert.equal((await view(missing.beeId)).bee.account,"codex-a");
 assert.equal(readdirSync(join(dir,"homes","codex-b","sessions","honeybee")).some(file=>file.endsWith(".partial")),false);
 assert.equal(readdirSync(join(dir,"homes","codex-b",".honeybee-rollout-trash")).length,1);
 record({stage:"rename-refusal-passed",account:"codex-a",partials:0,quarantinedLinks:1});
 renameSync(collision,collision+".collision.trashed");
 renameSync(sourcePath,sourcePath+".real");
 symlinkSync(sourcePath+".real",sourcePath);
 await assert.rejects(()=>request("bee.swapAccount",{beeId:missing.beeId,account:"codex-b"}), e=>e.code==="transcript_unavailable");
 const refusedLink = await view(missing.beeId);
 assert.equal(refusedLink.bee.account,"codex-a");
 assert.equal(refusedLink.view.generation,1);
 assert.equal(readdirSync(join(dir,"homes","codex-b","sessions","honeybee")).some(file=>file.endsWith(".partial")),false);
 record({stage:"symlink-source-refused",account:refusedLink.bee.account,generation:refusedLink.view.generation,partials:0});
 renameSync(sourcePath,sourcePath+".symlink.trashed");
 renameSync(sourcePath+".real",sourcePath);
 renameSync(sourcePath,sourcePath+".trashed");
 await assert.rejects(()=>request("bee.swapAccount",{beeId:missing.beeId,account:"codex-b"}), e=>e.code==="transcript_unavailable");
 const missingAfter=await view(missing.beeId);
 assert.equal(missingAfter.bee.account,missingBefore.bee.account);
 assert.deepEqual(missingAfter.bee.env,missingBefore.bee.env);
 assert.equal(missingAfter.bee.providerSessionId,missingBefore.bee.providerSessionId);
 assert.equal(missingAfter.view.generation,missingBefore.view.generation);
 assert.equal(missingAfter.view.runtimeState,"idle");
 record({stage:"missing-refusal-passed",before:{account:missingBefore.bee.account,env:missingBefore.bee.env,generation:missingBefore.view.generation,sessionId:missingBefore.bee.providerSessionId},after:{account:missingAfter.bee.account,env:missingAfter.bee.env,generation:missingAfter.view.generation,sessionId:missingAfter.bee.providerSessionId},effectCount:rows(effects).length});
 record({passed:true});
} finally {
 client?.close();
 if(daemon) { await daemon.stop(); writeFileSync(join(proof,"daemon-output.log"),daemon.output()); }
 if(existsSync(join(dir,"hived.log"))) copyFileSync(join(dir,"hived.log"),join(proof,"hived.log"));
}

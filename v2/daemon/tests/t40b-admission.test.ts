import { runV2Cli } from "../../cli/src/main.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import { openCoreStore } from "../../core/src/index.ts";
import { hashCellOpRequest } from "../../core/src/cellMove.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { eligibilityDigest, eligibilityFields, type EligibilityRegistration, type EligibilityAnswer } from "../src/satelliteEligibility.ts";
import { join } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import { eligibilityPeer } from "./eligibility-fixture.ts";
import { RpcClient } from "../../cli/src/client.ts";
import type { SpawnResult, ViewResult, SnapshotResult } from "../src/protocol.ts";
import { NO_SATELLITE_NOTICE } from "../src/satelliteEligibility.ts";

test("single-machine automatic spawn works without Apiary, retains its notice on replay and accepts mail", async t => {
  const rig = makeDaemonDir({nodeKind:"workstation"}); const daemon = await startDaemon(rig.dir);
  const client = await RpcClient.connect(daemon.socketPath,3000,undefined,{capabilities:["workstation.admission.v1"]});
  t.after(async () => {client.close(); await daemon.stop(); rig.cleanup();});
  const args = {name:"single-machine",agent:"stub",cwd:rig.dir,idempotencyKey:"single"};
  const result = await client.request<SpawnResult>("spawn",args);
  assert.deepEqual(result.notice,NO_SATELLITE_NOTICE);
  assert.equal(result.admissionDiagnostic?.reason,"no_subscription");
  await waitFor(async () => (await client.request<ViewResult>("view",{beeId:result.beeId})).view.runtimeState === "idle","single-machine stub");
  assert.equal((await client.request<ViewResult>("view",{beeId:result.beeId})).bee!.admissionBasis,"automatic_local_fallback");
  const replay = await client.request<SpawnResult>("spawn",args);
  assert.equal(replay.beeId,result.beeId); assert.deepEqual(replay.notice,NO_SATELLITE_NOTICE);
  await client.request("send",{beeId:result.beeId,body:"local mail"});
  const saved = process.env.HIVE_BEE_ID; const out: string[] = [], err: string[] = [];
  try {
    process.env.HIVE_BEE_ID = result.beeId;
    const exit = await runV2Cli(["spawn","cli-fallback","--agent","stub","--cwd",rig.dir,"--data-dir",rig.dir,"--json"],{out:line=>out.push(line),err:line=>err.push(line)});
    assert.equal(exit,0); assert.deepEqual(JSON.parse(out.at(-1)!).notice,NO_SATELLITE_NOTICE);
    assert.equal(err.filter(line=>line === NO_SATELLITE_NOTICE.message).length,1);
  } finally { if (saved === undefined) delete process.env.HIVE_BEE_ID; else process.env.HIVE_BEE_ID = saved; }

});

test("only registered positive eligibility denies; same key admits after loss and replay ignores a later satellite", async t => {
  const rig = makeDaemonDir({nodeKind:"workstation",rpcLocalTrust:{requireObservationCaller:true}});
  const daemon = await startDaemon(rig.dir); const client = await RpcClient.connect(daemon.socketPath,3000,undefined,{capabilities:["workstation.admission.v1"]});
  t.after(async () => {client.close(); await daemon.stop(); rig.cleanup();});
  const peer = await eligibilityPeer(t,rig.dir,daemon.socketPath);
  const args = {name:"fleet-loss",agent:"stub",cwd:rig.dir,idempotencyKey:"fleet-loss"};
  await assert.rejects(client.request("spawn",args), error => {
    const e = error as {code?:string;details?:{satellite?:{nodeId:string;name:string}}};
    return e.code === "workstation_heavy_work_denied" && e.details?.satellite?.nodeId === "fixture-worker";
  });
  assert.equal((await client.request<SnapshotResult>("snapshot")).views.length,0);
  await peer.mode("ineligible");
  const admitted = await client.request<SpawnResult>("spawn",args);
  assert.deepEqual(admitted.notice,NO_SATELLITE_NOTICE); assert.equal(admitted.admissionDiagnostic?.reason,"no_candidate");
  await peer.mode("eligible");
  assert.equal((await client.request<SpawnResult>("spawn",args)).beeId,admitted.beeId);
  assert.equal((await client.request<SnapshotResult>("snapshot")).views.length,1);
  await peer.mode("unreachable");
  const timeout = await client.request<SpawnResult>("spawn",{...args,name:"unreachable",idempotencyKey:"unreachable"},5000);
  assert.equal(timeout.admissionDiagnostic?.reason,"timeout"); assert.deepEqual(timeout.notice,NO_SATELLITE_NOTICE);
  await peer.mode("disconnect");
  const disconnected = await client.request<SpawnResult>("spawn",{...args,name:"disconnect",idempotencyKey:"disconnect"},5000);
  assert.equal(disconnected.admissionDiagnostic?.reason,"no_subscription");
});


test("carried decisions require current local registration and bind the exact raw request", async t => {
  const rig = makeDaemonDir({nodeKind:"workstation",rpcLocalTrust:{requireObservationCaller:true}});
  const daemon = await startDaemon(rig.dir); const service = await RpcClient.connect(daemon.socketPath);
  t.after(async () => {service.close(); await daemon.stop(); rig.cleanup();});
  const args = {name:"carried",agent:"stub",cwd:rig.dir,idempotencyKey:"carried"};
  const fake: EligibilityAnswer = {version:1,queryId:"fake",daemonInstanceId:"fake",registrationEpoch:"fake",destinationNodeId:"local",requestDigest:"fake",expiresAtMs:Date.now()+1500,eligible:true,satellite:{nodeId:"other",name:"Fake"}};
  const ignored = await service.request<SpawnResult>("spawn",{...args,idempotencyKey:"untrusted-carrier"},3000,{satelliteEligibility:fake});
  assert.equal(ignored.admissionDiagnostic?.reason,"no_subscription");
  const challenge = await service.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(rig.dir,"rpc-private","registration.key"));
  const token = createHmac("sha256",key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  const reg = await service.request<EligibilityRegistration>("rpc.localTrust.register",{pid:process.pid,challengeId:challenge.challengeId,token});
  const decision = (params:Record<string,unknown>, eligible:boolean): EligibilityAnswer => ({version:1,queryId:randomUUID(),daemonInstanceId:reg.daemonInstanceId,registrationEpoch:reg.registrationEpoch,destinationNodeId:"local",requestDigest:eligibilityDigest(reg,"local","spawn",eligibilityFields(params)!,"apiary-routed"),expiresAtMs:Date.now()+1500,eligible,...(eligible?{satellite:{nodeId:"worker",name:"Named satellite"}}:{})});
  await assert.rejects(service.request("spawn",args,3000,{satelliteEligibility:decision(args,true)}),error => (error as Error).message.includes("Named satellite"));
  const accepted = await service.request<SpawnResult>("spawn",args,3000,{satelliteEligibility:decision(args,false)});
  assert.equal(accepted.admissionDiagnostic?.reason,"no_candidate");
  const staleArgs = {...args,name:"stale",idempotencyKey:"stale"};
  const stale = await service.request<SpawnResult>("spawn",staleArgs,3000,{satelliteEligibility:{...decision(staleArgs,true),registrationEpoch:"old"}});
  assert.equal(stale.admissionDiagnostic?.reason,"digest_mismatch");
});

test("effect-free legacy denial can requeue once, but changed arguments or start evidence cannot", async t => {
  const rig = makeDaemonDir({nodeKind:"workstation"});
  const store = openCoreStore(join(rig.dir,"core.sqlite3"));
  store.createBee({id:"owner",name:"owner",agent:"stub",substrate:"hsr",cwd:rig.dir,admissionBasis:"continuation"});
  const space = join(rig.dir,"cells","fixture","fixture-space-123456789abc"); mkdirSync(space,{recursive:true});
  const cell = store.putCell({sourceBeeId:"owner",originRepo:rig.dir,sha:"a".repeat(40),wrapper:"fixture",spaceName:"fixture-space-123456789abc",spaceDir:space,gitCommonDirRealpath:join(rig.dir,".git"),objectFormat:"sha1",sandbox:false});
  const sentinel = join(space,"legacy-ran");
  const args = {cellId:cell.id,idempotencyKey:"legacy-denied",argv:[process.execPath,"-e","require('node:fs').appendFileSync(process.argv[1],'ran')",sentinel]};
  const hash = (a:typeof args) => hashCellOpRequest({cellId:a.cellId,kind:"exec",argv:a.argv,cwd:null,timeoutMs:null,admission:null,actor:null,client:null});
  const op = store.putCellOp({cellId:cell.id,kind:"exec",idempotencyKey:args.idempotencyKey,requestHash:hash(args),argv:[]});
  store.updateCellOp(op.id,{status:"failed",failure:"workstation_heavy_work_denied"});
  const uncertainArgs = {...args,idempotencyKey:"started-before",argv:["true"]};
  const started = store.putCellOp({cellId:cell.id,kind:"exec",idempotencyKey:uncertainArgs.idempotencyKey,requestHash:hash(uncertainArgs),argv:[]});
  store.updateCellOp(started.id,{status:"running"}); store.updateCellOp(started.id,{status:"failed",failure:"workstation_heavy_work_denied"});
  store.close();
  const daemon = await startDaemon(rig.dir); const client = await RpcClient.connect(daemon.socketPath);
  t.after(async () => {client.close(); await daemon.stop(); rig.cleanup();});
  await assert.rejects(client.request("cell.exec",{...args,argv:["false"]}),{code:"idempotency_conflict"});
  const result = await client.request<{status:string;admissionDiagnostic?:{reason:string}}>("cell.exec",args,5000);
  assert.equal(result.status,"done"); assert.equal(result.admissionDiagnostic?.reason,"criteria_unsupported"); assert.equal(existsSync(sentinel),true);
  const replay = await client.request<{status:string;deduped?:boolean}>("cell.exec",args,5000);
  assert.equal(replay.status,"done"); assert.equal(replay.deduped,true); assert.equal(readFileSync(sentinel,"utf8"),"ran");
  assert.equal((await client.request<{status:string}>("cell.exec",uncertainArgs)).status,"failed");
});

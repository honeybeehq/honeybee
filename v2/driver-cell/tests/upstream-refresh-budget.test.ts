import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { CellDriver, DEFAULT_UPSTREAM_REFRESH, upstreamRefreshDelay } from "../src/driver.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { makeRig } from "./helpers.ts";

type Internals = { scheduleRefresh(origin: unknown, fetch?: boolean): void; ensureCell(): unknown; inner: {start():void}; poolWorkers:Map<string,Worker>; origins:Map<string,{lastFetchAt:number}> };
function setup(extra: Record<string, unknown> = {}, intervalMs = 600000) {
  const rig=makeRig();
  const driver=new CellDriver({cellsRoot:rig.cellsRoot,nodeKind:"workstation",disableCow:true,
    resolveHarness:()=>({adapter:stubAdapter,command:process.execPath,args:[],env:{PATH:"/usr/bin:/bin",HOME:rig.root}}),
    resolveCell:()=>({sandbox:false,provision:{beeId:"bee",originRepo:rig.origin.repo,sha:rig.origin.sha,wrapper:"bee",repoName:"fixture",cellId:"cell"}}),
    hsr:{sessionLogDir:join(rig.root,"logs")},
    upstreamRefresh:{root:join(rig.root,"upstream"),nodeKey:"fixture-node",intervalMs},...extra});
  return {rig,driver,internal:driver as unknown as Internals};
}

test("upstream refresh delay bounds jitter and gives nodes stable initial offsets",()=>{
  const interval=DEFAULT_UPSTREAM_REFRESH.intervalMs;
  assert.ok(interval>=600000);
  for(const random of [-1,0,0.5,1,2]) {
    const first=upstreamRefreshDelay(interval,"node-a",true,random),repeat=upstreamRefreshDelay(interval,"node-a",false,random);
    assert.ok(first>=interval&&first<=interval*2.2);
    assert.ok(repeat>=interval&&repeat<=interval*1.2);
  }
  assert.equal(upstreamRefreshDelay(interval,"node-a",true,0),upstreamRefreshDelay(interval,"node-a",true,0));
  assert.notEqual(upstreamRefreshDelay(interval,"node-a",true,0),upstreamRefreshDelay(interval,"node-b",true,0));
});

test("upstream refresh starts after the node offset and repeats no faster than its interval",t=>{
  const interval=1200000;const {rig,driver,internal}=setup({},interval);const originalRandom=Math.random;const calls:boolean[]=[];
  t.mock.timers.enable({apis:["setTimeout","Date"],now:2_000_000_000_000});Math.random=()=>0;
  internal.scheduleRefresh=(_origin,fetch=true)=>{calls.push(fetch);};
  try {
    driver.trackOrigins([{originRepo:rig.origin.repo,repoName:"fixture",usedAt:Date.now()}]);
    assert.deepEqual(calls,[]);
    const initial=upstreamRefreshDelay(interval,"fixture-node",true,0);
    t.mock.timers.tick(initial-1);assert.deepEqual(calls,[]);
    t.mock.timers.tick(1);assert.deepEqual(calls,[true]);
    t.mock.timers.tick(interval-1);assert.equal(calls.length,1);
    t.mock.timers.tick(1);assert.equal(calls.length,2);
  }finally{driver.disposeAll();rig.cleanup();Math.random=originalRandom;t.mock.timers.reset();}
});

test("startup and both spawn completion paths only schedule local pool work",async()=>{
  for(const backgroundProvisioning of [false,true]) {
    const provisional=makeRig();const worker=join(provisional.root,"provision.mjs");
    writeFileSync(worker,"import {parentPort} from 'node:worker_threads';parentPort.postMessage({ok:true});");
    const {rig,driver,internal}=setup({backgroundProvisioning,provisionWorkerUrl:pathToFileURL(worker),warmPool:{targetFree:1}});
    const calls:boolean[]=[];internal.scheduleRefresh=(_origin,fetch=true)=>{calls.push(fetch);};
    internal.ensureCell=()=>({});internal.inner.start=()=>{};
    try {
      driver.trackOrigins([{originRepo:rig.origin.repo,repoName:"fixture",usedAt:Date.now()}]);
      assert.deepEqual(calls,[false]);
      driver.start("bee",1);
      const until=Date.now()+2000;
      while(calls.length<2){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10));}
      assert.deepEqual(calls,[false,false]);
    }finally{driver.disposeAll();await new Promise(resolve=>setTimeout(resolve,20));rig.cleanup();provisional.cleanup();}
  }
});

test("periodic upstream refresh preserves per-origin single-flight and retry budget",async()=>{
  const provisional=makeRig(),worker=join(provisional.root,"pool.mjs");
  writeFileSync(worker,"import {parentPort,workerData} from 'node:worker_threads';import {appendFileSync} from 'node:fs';import {join} from 'node:path';appendFileSync(join(workerData.cellsRoot,'calls'),JSON.stringify(workerData)+'\\n');parentPort.once('message',()=>{parentPort.postMessage({built:0});parentPort.close();});");
  const {rig,driver,internal}=setup({poolWorkerUrl:pathToFileURL(worker)});
  try {
    driver.trackOrigins([{originRepo:rig.origin.repo,repoName:"fixture",usedAt:Date.now()}]);
    const origin=internal.origins.get(rig.origin.repo)!;
    internal.scheduleRefresh(origin);internal.scheduleRefresh(origin);
    assert.equal(internal.poolWorkers.size,1);
    const until=Date.now()+2000;
    while(!existsSync(join(rig.cellsRoot,"calls"))){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10));}
    const calls=readFileSync(join(rig.cellsRoot,"calls"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    assert.equal(calls.length,1);assert.equal(calls[0].upstream.maxAgeMs,600000);
    [...internal.poolWorkers.values()][0]!.postMessage("finish");
    while(internal.poolWorkers.size){assert.ok(Date.now()<until);await new Promise(resolve=>setTimeout(resolve,10));}
    internal.scheduleRefresh(origin);assert.equal(internal.poolWorkers.size,0);
  }finally{for(const w of internal.poolWorkers.values())await w.terminate();driver.disposeAll();rig.cleanup();provisional.cleanup();}
});


test("disabled upstream refresh schedules no startup or timer fetch", t => {
  const {rig,driver,internal}=setup({upstreamRefresh:undefined});
  const calls:boolean[]=[];internal.scheduleRefresh=(_origin,fetch=true)=>{calls.push(fetch);};
  t.mock.timers.enable({apis:["setTimeout","Date"],now:2_000_000_000_000});
  try {
    driver.trackOrigins([{originRepo:rig.origin.repo,repoName:"fixture",usedAt:Date.now()}]);
    t.mock.timers.tick(86400000);
    assert.deepEqual(calls,[]);
  } finally {driver.disposeAll();rig.cleanup();t.mock.timers.reset();}
});

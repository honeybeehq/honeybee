import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const [beforeArg,afterArg,outArg]=process.argv.slice(2),roots=[beforeArg,afterArg].map(p=>resolve(p)),rounds=15,NOW=1800000000000;
const hash=x=>createHash('sha256').update(x).digest('hex');
const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=root=>({root,revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(git(root,'ls-files','v2').trim().split('\n').filter(f=>f.endsWith('.ts')&&f.includes('/src/')).map(f=>[f,hash(readFileSync(join(root,f)))]))});
const source=roots.map(fingerprint);for(const root of roots)assert.doesNotMatch(git(root,'status','--porcelain'),/^.. v2\//m);
const changedSourceFiles=Object.keys(source[0].hashes).filter(f=>source[0].hashes[f]!==source[1].hashes[f]);assert.deepEqual(changedSourceFiles,['v2/core/src/store.ts']);
const toolHash=hash(readFileSync(new URL(import.meta.url))),modules=[];for(const root of roots)modules.push(await import(pathToFileURL(join(root,'v2/core/src/index.ts'))));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();},bootUUID=boot();
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn();const wallMs=performance.now()-t,u=process.cpuUsage(c);return {value,wallMs,cpuMs:(u.user+u.system)/1000};};
const summary=raw=>Object.fromEntries(['wallMs','cpuMs'].map(k=>{const a=raw.map(r=>r[k]).sort((a,b)=>a-b);return [k,{n:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],min:a[0],max:a.at(-1)}];}));
const report={completed:false,startedAt:new Date().toISOString(),source,changedSourceFiles,toolHash,rounds,environment:{bootUUID,node:process.version,execArgv:process.execArgv,cpu:cpus()[0].model,cores:cpus().length,loadBefore:loadavg()},scope:'Real CoreStore task feeds on copied disposable stores and distinct source modules. ABBA, 3 warmup rounds, 15 measured rounds. Batch runs inside outer transaction, rolled back outside timing: excludes durable commit. Full returned feed bodies, state and audit compared across sides outside timing. No real runtime or readiness. All fixtures via public API.',results:[]};
const save=()=>writeFileSync(outArg,JSON.stringify(report,null,2)+'\n');save();
try{
for(const spec of [{name:'positive-feed',bees:100,tasks:10,questions:0,pending:0},{name:'open-questions',bees:100,tasks:10,questions:10,pending:0},{name:'pending-bodies',bees:100,tasks:10,questions:0,pending:10}]){
 const dir=mkdtempSync(join(tmpdir(),'hb-task-paired-')),paths=[join(dir,'before.sqlite3'),join(dir,'after.sqlite3')],stores=[];
 try{
  const seed=modules[0].openCoreStore(paths[0],{now:()=>NOW});const ids=Array.from({length:spec.bees},(_,i)=>`t-${String(i).padStart(4,'0')}`);
  try{seed.transact(()=>{for(const id of ids){seed.createBee({id,name:id,agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState(id,1,'running');seed.setTaskSupply(id,{on:true,limit:100});for(let j=0;j<spec.tasks;j++)seed.addTask({list:modules[0].beeTaskList(id),title:`task-${j}`,body:'task body',originKind:'user',originSender:'operator'});for(let j=0;j<spec.questions;j++)seed.askQuestion(id,{text:'q'.repeat(4096)});for(let j=0;j<spec.pending;j++)seed.send(id,'m'.repeat(4096),{urgency:'idle'});}});}finally{seed.close();}
  copyFileSync(paths[0],paths[1]);for(let i=0;i<2;i++)stores.push(modules[i].openCoreStore(paths[i],{now:()=>NOW}));
  const raw=[[],[]],initial=stores.map(s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()})));assert.equal(initial[0],initial[1]);let canonical=null;
  for(let round=-3;round<rounds;round++)for(const side of [0,1,1,0]){
   const s=stores[side],sentinel={};let observed;
   try{s.transact(()=>{const m=measure(()=>ids.map(id=>s.tryFeedTaskSupply(id)));if(round>=0)raw[side].push({wallMs:m.wallMs,cpuMs:m.cpuMs});
    const fed=m.value.filter(Boolean);assert.equal(fed.length,spec.name==='positive-feed'?spec.bees:0);
    observed=hash(JSON.stringify({returned:m.value,bodies:fed.map(r=>s.getMessage(r.fed.mailboxMessageId)?.body),state:s.dumpState(),audit:s.auditRows()}));throw sentinel;});}catch(e){if(e!==sentinel)throw e;}
   if(canonical===null)canonical=observed;assert.equal(observed,canonical);assert.equal(hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()})),initial[side]);
  }
  report.results.push({spec,raw,summary:raw.map(summary),correctness:{returnedBodiesStateAuditEqual:true,rollbackRestored:true}});save();console.log(spec.name,raw.map(r=>summary(r).cpuMs.p50));
 }finally{for(const s of stores)s.close();rmSync(dir,{recursive:true,force:true});}
}
assert.deepEqual(roots.map(fingerprint),source);assert.equal(boot(),bootUUID);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);report.completed=true;
}catch(e){report.failure=String(e?.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();}

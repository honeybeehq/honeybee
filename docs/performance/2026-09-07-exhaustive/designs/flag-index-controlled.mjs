import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [rootArg,outArg,roundArg='15',mode='index']=process.argv.slice(2), root=resolve(rootArg), rounds=Number(roundArg);
assert(Number.isInteger(rounds)&&rounds>=3&&rounds<=30);assert(['index','control'].includes(mode));
const NOW=1800000000000, hash=x=>createHash('sha256').update(x).digest('hex');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=()=>({revision:git('rev-parse','HEAD').trim(),hashes:Object.fromEntries(git('ls-files','v2').trim().split('\n').filter(f=>f.endsWith('.ts')&&f.includes('/src/')).map(f=>[f,hash(readFileSync(join(root,f)))]))});
const source=fingerprint(), status=git('status','--porcelain');assert.doesNotMatch(status,/^.. v2\//m);
const toolHash=hash(readFileSync(new URL(import.meta.url)));
const {openCoreStore}=await import(pathToFileURL(join(root,'v2/core/src/index.ts')));
const index='CREATE INDEX flags_due_prototype ON flags(resets_at, id) WHERE cleared_at IS NULL AND resets_at IS NOT NULL';
const sql='SELECT * FROM flags WHERE cleared_at IS NULL AND resets_at IS NOT NULL AND resets_at <= ? ORDER BY id';
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn();const wallMs=performance.now()-t,u=process.cpuUsage(c);return {value,wallMs,cpuMs:(u.user+u.system)/1000};};
const summary=raw=>Object.fromEntries(['wallMs','cpuMs'].map(k=>{const a=raw.map(r=>r[k]).sort((a,b)=>a-b);return [k,{n:a.length,p50:a[Math.ceil(a.length*.5)-1],p95:a[Math.ceil(a.length*.95)-1],min:a[0],max:a.at(-1)}];}));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const bootUUID=boot();
const report={completed:false,startedAt:new Date().toISOString(),source,status,toolHash,index,sql,rounds,mode,environment:{bootUUID,node:process.version,execArgv:process.execArgv,cpu:cpus()[0].model,cores:cpus().length,loadBefore:loadavg()},scope:'Prototype index only; same exact CoreStore module and SQLite authority on copied disposable databases. Not a production speedup claim. Raw seeded history is outside timing. Durable flag writes use production WAL/NORMAL. Parent CPU includes SQLite, excludes no child work because measured operations launch none. One index-install sample is not a percentile. Reads and writes are ABBA; assertions outside timing.',results:[]};
const save=()=>writeFileSync(outArg,JSON.stringify(report,null,2)+'\n');save();
try {
for(const spec of [
 {name:'empty',cleared:0,active:0,due:0},
 {name:'history-future',cleared:100000,active:1000,due:0},
 {name:'active-future',cleared:0,active:20000,due:0},
 {name:'history-due',cleared:100000,active:1000,due:1000},
 {name:'all-due',cleared:0,active:1000,due:1000},
]){
 const dir=mkdtempSync(join(tmpdir(),'hb-flags-index-'));let stores=[];
 try{
  const paths=[join(dir,'before.sqlite3'),join(dir,'after.sqlite3')];let s=openCoreStore(paths[0],{now:()=>NOW});
  s.transact(()=>{for(let i=0;i<Math.max(1,spec.active);i++){const id=`f-${String(i).padStart(6,'0')}`;s.createBee({id,name:id,agent:'stub',substrate:'hsr',cwd:dir});s.updateRuntimeState(id,1,'stopped',{exitCause:'clean'});}});s.close();
  const seed=new DatabaseSync(paths[0]);seed.exec('PRAGMA synchronous=OFF; BEGIN');const insert=seed.prepare("INSERT INTO flags(bee_id,flag,detail,set_at,cleared_at,resets_at) VALUES(?,'resource_blocked','fixture',?,?,?)");
  for(let i=0;i<spec.cleared;i++)insert.run('f-000000',NOW-1000,NOW-500,NOW-700);
  for(let i=0;i<spec.active;i++)insert.run(`f-${String(i).padStart(6,'0')}`,NOW-100,null,i<spec.due?NOW-i:NOW+1000+i);
  seed.exec('COMMIT');seed.close();copyFileSync(paths[0],paths[1]);
  const db=new DatabaseSync(paths[1]);const install=measure(()=>{if(mode==='index')db.exec(index);});db.close();delete install.value;
  const plans=paths.map(p=>{const d=new DatabaseSync(p,{readOnly:true});try{return {bytes:statSync(p).size,plan:d.prepare('EXPLAIN QUERY PLAN '+sql).all(NOW)};}finally{d.close();}});
  stores=paths.map(p=>openCoreStore(p,{now:()=>NOW}));
  const raw=[[],[]],beforeSeq=stores.map(s=>s.lastAuditSeq());
  for(let round=-3;round<rounds;round++)for(const side of [0,1,1,0]){
   const st=stores[side];let observed;const sentinel={};
   // Roll back each due burst so its rows and audit writes are identical next sample.
   // BEGIN/ROLLBACK are outside the measured operation; this phase measures expiry logic,
   // not durable commit latency. Durable set/clear operations are measured separately below.
   try{st.transact(()=>{const m=measure(()=>st.expireFlags(NOW));observed=m.value;if(round>=0)raw[side].push({wallMs:m.wallMs,cpuMs:m.cpuMs});throw sentinel;});}catch(e){if(e!==sentinel)throw e;}
   assert.equal(observed.length,spec.due);assert.deepEqual(observed.map(r=>r.id),Array.from({length:spec.due},(_,i)=>spec.cleared+i+1));assert(observed.every(r=>r.clearedAt===null));assert.equal(st.lastAuditSeq(),beforeSeq[side]);
  }
  const writes=[[],[]];
  for(let round=-3;round<rounds;round++)for(const side of [0,1,1,0]){
   const st=stores[side];const m=measure(()=>{for(let i=0;i<10;i++){st.setFlag('f-000000','auth_needed','write-cost',{resetsAt:NOW+500});st.clearFlag('f-000000','auth_needed');}});if(round>=0)writes[side].push({wallMs:m.wallMs,cpuMs:m.cpuMs});
   assert(!st.activeFlags('f-000000').some(f=>f.flag==='auth_needed'));
  }
  assert.deepEqual(stores[0].dumpState(),stores[1].dumpState());assert.deepEqual(stores[0].auditRows(),stores[1].auditRows());
  report.results.push({spec,install,storage:plans,expiry:{raw,summary:raw.map(summary)},durableTenSetClearCycles:{raw:writes,summary:writes.map(summary)},correctness:{orderedDueRows:true,rollbackRestoredAudit:true,finalStateAndAuditEqual:true}});save();console.log(spec.name,raw.map(r=>summary(r).cpuMs.p50),writes.map(r=>summary(r).cpuMs.p50));
 }finally{for(const s of stores)s.close();rmSync(dir,{recursive:true,force:true});}
}
assert.equal(boot(),bootUUID);assert.deepEqual(fingerprint(),source);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);report.completed=true;
}catch(e){report.failure=String(e?.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();}

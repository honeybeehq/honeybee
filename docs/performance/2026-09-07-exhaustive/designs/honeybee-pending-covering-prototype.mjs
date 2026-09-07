import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [rootArg,outArg,controlArg='false',roundsArg='15',scale='canonical']=process.argv.slice(2);
assert(rootArg&&outArg);assert(['true','false'].includes(controlArg));assert(['smoke','canonical'].includes(scale));
const root=resolve(rootArg),out=resolve(outArg),control=controlArg==='true',rounds=Number(roundsArg);
assert(Number.isSafeInteger(rounds)&&rounds>=3&&rounds<=30);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=()=>{assert.equal(git('status','--porcelain').trim(),'');const files=git('ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>(p.endsWith('.ts')&&p.includes('/src/'))||p.endsWith('package.json')||p==='package-lock.json'||p==='v2/daemon/tests/helpers.ts');return {revision:git('rev-parse','HEAD').trim(),hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const source=fingerprint(),toolHash=hash(readFileSync(new URL(import.meta.url)));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return hash(r.stdout.trim());};
const local=p=>import(pathToFileURL(join(root,p)).href);
const {openCoreStore}=await local('v2/core/src/index.ts');const {DaemonCore}=await local('v2/daemon/src/loops.ts');const {FakeDriver}=await local('v2/daemon/tests/helpers.ts');const {captureSql}=await local('scripts/perf/sql-trace.mjs');
const sqlToolHash=hash(readFileSync(join(root,'scripts/perf/sql-trace.mjs')));
const indexName='mailbox_pending_metadata',indexSql=`CREATE INDEX ${indexName} ON mailbox(bee_id,id,urgency,enqueued_at) WHERE delivered_at IS NULL`;
const scenarios=scale==='smoke'?[{pending:20,bodyBytes:64}]:[{pending:1000,bodyBytes:64},{pending:20000,bodyBytes:64},{pending:100,bodyBytes:1048576}];
const report={completed:false,startedAt:new Date().toISOString(),source,toolHash,sqlToolHash,control,indexSql,environment:{node:process.version,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},workload:{scenarios,rounds,order:'ABBA',warmups:3,writeBatch:100},scope:'Offline-index mechanism prototype: one real source module and two initially byte-identical DB copies. Index installed outside reads through direct DDL; ordinary CoreStore/DaemonCore reads and durable public send+cancel writes. FakeDriver; no workers or live runtime. Shared heap/cache can cross sides. Allocation and native memory not measured. Installation is one CREATE INDEX sample, not startup. Storage measured on closed checkpointed files.',results:[]};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const dist=xs=>{const s=[...xs].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],min:s[0],max:s.at(-1)};};
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn();const wallMs=performance.now()-t,u=process.cpuUsage(c);return {wallMs,cpuMs:(u.user+u.system)/1000,value};};
const state=s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()}));
const storage=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return {fileBytes:statSync(path).size,pageCount:db.prepare('PRAGMA page_count').get().page_count,freePages:db.prepare('PRAGMA freelist_count').get().freelist_count,index:db.prepare('SELECT name,COUNT(*) AS pages,SUM(pgsize) AS bytes FROM dbstat WHERE name=? GROUP BY name').all(indexName),quickCheck:db.prepare('PRAGMA quick_check').get().quick_check};}finally{db.close();}};
const dir=mkdtempSync(join(tmpdir(),'hb-pending-cover-'));const opened=[];save();
try{
 for(const scenario of scenarios){
  const prefix=`${scenario.pending}-${scenario.bodyBytes}`,seedPath=join(dir,prefix+'-seed.sqlite'),seed=openCoreStore(seedPath,{now:()=>1000});
  const bee='00000000-0000-4000-8000-000000000001';
  seed.transact(()=>{seed.createBee({id:bee,name:'target',handle:'PM.target',agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState(bee,1,'running');for(let n=0;n<scenario.pending;n++)seed.send(bee,'x'.repeat(scenario.bodyBytes),{urgency:'idle'});});
  const seedSeq=seed.lastAuditSeq();seed.close();const fixtureSha256=hash(readFileSync(seedPath));
  const paths=[0,1].map(side=>join(dir,prefix+'-'+side+'.sqlite'));const install=[];
  for(const [side,path] of paths.entries()){
   copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);
   const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(indexName),undefined);
   const result=measure(()=>{if(side===1&&!control)db.exec(indexSql);});install.push({wallMs:result.wallMs,cpuMs:result.cpuMs,ddlExecuted:side===1&&!control});db.close();
  }
  const beforeWritesStorage=paths.map(storage);assert(beforeWritesStorage.every(s=>s.quickCheck==='ok'));
  const rigs=paths.map(path=>{const store=openCoreStore(path,{now:()=>1000});opened.push(store);const driver=new FakeDriver(()=>1000);let violations=0;const core=new DaemonCore({store,driver,now:()=>1000,policy:{commandsPerStep:0,bootHangTimeoutSteps:1e12,i1DeadlineSteps:1e12},onI1Violation:()=>violations++,log:()=>{}});return {store,driver,core,violations:()=>violations};});
  const initial=rigs.map(r=>state(r.store));assert.equal(initial[0],initial[1]);assert(rigs.every(r=>r.store.lastAuditSeq()===seedSeq));
  const operations={i1:r=>r.store.readI1PendingSnapshot(),work:r=>r.store.readDaemonWork(),step:r=>r.core.step()};
  const results={};
  for(const [name,fn] of Object.entries(operations)){
   assert.deepEqual(fn(rigs[0]),fn(rigs[1]));for(let n=0;n<3;n++)for(const side of [0,1,1,0])fn(rigs[side]);
   const raw=[[],[]];for(let n=0;n<rounds;n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs}=measure(()=>fn(rigs[side]));raw[side].push({wallMs,cpuMs});}
   results[name]={raw,metrics:raw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))}))};
  }
  const diagnostics=rigs.map(r=>captureSql(()=>r.store.readI1PendingSnapshot()).statements);
  for(const [i,r] of rigs.entries()){assert.equal(state(r.store),initial[i]);assert.equal(r.violations(),0);assert.deepEqual(r.driver.starts,[]);assert.deepEqual(r.driver.deliveredIds,[]);assert.deepEqual(r.driver.interrupts,[]);}
  const write=r=>{for(let j=0;j<100;j++){const msg=r.store.send(bee,'write'.repeat(13),{urgency:'idle'}).message;assert.equal(r.store.cancelMessage(bee,msg.id).canceled,true);}};
  for(const side of [0,1])write(rigs[side]);const writeRaw=[[],[]];
  for(let n=0;n<Math.min(rounds,5);n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs}=measure(()=>write(rigs[side]));writeRaw[side].push({wallMs,cpuMs});}
  assert.equal(state(rigs[0].store),state(rigs[1].store));assert(rigs.every(r=>r.store.listUndeliveredMessages().length===scenario.pending));
  for(const r of rigs){r.store.close();opened.splice(opened.indexOf(r.store),1);}
  const queryPlans=paths.map((path,side)=>{const db=new DatabaseSync(path,{readOnly:true});try{return diagnostics[side].filter(s=>s.kind==='all').map(s=>({sql:s.sql,plan:db.prepare('EXPLAIN QUERY PLAN '+s.sql).all()}));}finally{db.close();}});
  const afterWritesStorage=paths.map(storage);assert(afterWritesStorage.every(s=>s.quickCheck==='ok'));
  report.results.push({scenario,fixtureSha256,install,beforeWritesStorage,results,diagnostics,queryPlans,writeRaw,writeMetrics:writeRaw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))})),afterWritesStorage});save();
 }
 assert.deepEqual(fingerprint(),source);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);assert.equal(hash(readFileSync(join(root,'scripts/perf/sql-trace.mjs'))),sqlToolHash);assert.equal(boot(),report.environment.boot);report.completed=true;
}catch(e){report.failure=String(e.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const s of opened)s.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

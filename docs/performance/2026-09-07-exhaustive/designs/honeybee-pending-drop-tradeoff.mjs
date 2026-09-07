import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
const [beforeArg,afterArg,outArg,controlArg='false',roundsArg='15',scale='canonical']=process.argv.slice(2);
assert(beforeArg&&afterArg&&outArg);assert(['true','false'].includes(controlArg));assert(['smoke','canonical'].includes(scale));
const roots=[beforeArg,afterArg].map(p=>resolve(p)),out=resolve(outArg),control=controlArg==='true',rounds=Number(roundsArg);assert.notEqual(roots[0],roots[1]);
assert(Number.isSafeInteger(rounds)&&rounds>=3&&rounds<=30);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=root=>{assert.equal(git(root,'status','--porcelain').trim(),'');const files=git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>(p.endsWith('.ts')&&p.includes('/src/'))||p.endsWith('package.json')||p==='package-lock.json'||p==='v2/daemon/tests/helpers.ts');return {revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const sources=roots.map(fingerprint),toolHash=hash(readFileSync(new URL(import.meta.url)));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return hash(r.stdout.trim());};
assert.deepEqual(Object.keys(sources[0].hashes),Object.keys(sources[1].hashes));
assert.deepEqual(Object.keys(sources[0].hashes).filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]),control?[]:['v2/core/src/schema.ts','v2/core/src/store.ts']);
const modules=await Promise.all(roots.map(async root=>({core:await import(pathToFileURL(join(root,'v2/core/src/index.ts')).href),daemon:await import(pathToFileURL(join(root,'v2/daemon/src/loops.ts')).href),fake:await import(pathToFileURL(join(root,'v2/daemon/tests/helpers.ts')).href)})));
assert.notEqual(modules[0].core.CoreStore,modules[1].core.CoreStore);
const {captureSql}=await import(pathToFileURL(join(roots[0],'scripts/perf/sql-trace.mjs')).href);
const sqlToolHash=hash(readFileSync(join(roots[0],'scripts/perf/sql-trace.mjs')));
const open=(side,path)=>modules[side].core.openCoreStore(path,{now:()=>1000});
const indexName='mailbox_undelivered',replacementIndexName='mailbox_pending_metadata';
const scenarios=scale==='smoke'?[{pending:20,bodyBytes:64}]:[{pending:1000,bodyBytes:64},{pending:20000,bodyBytes:64},{pending:100,bodyBytes:1048576},{pending:20,bodyBytes:64,deliveredHistory:100000}];
const report={completed:false,startedAt:new Date().toISOString(),sources,toolHash,sqlToolHash,control,indexName,replacementIndexName,environment:{node:process.version,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},workload:{scenarios,rounds,order:'ABBA',warmups:3,writeBatch:100},scope:'Two immutable production roots with distinct module instances and exact schema/store source delta. Initially byte-identical databases with both pending indexes; public constructor removes the redundant old index only on the candidate. ABBA fresh-file opens include the one-time index drop with file copying, assertions and close outside clock. Held mail seeded by public API, delivered history inserted offline with real bee ID and foreign-key checks. Real CoreStore/DaemonCore reads and durable public send+cancel, send+delivery and send+expedite+cancel writes. FakeDriver; no workers or live runtime. Shared process heap/cache can cross sides. Allocation and native memory not measured. Storage measured on closed checkpointed files; DROP may free pages for reuse without shrinking the file. Wider-index effects on full-body reads are timed explicitly.',results:[]};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const dist=xs=>{const s=[...xs].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],min:s[0],max:s.at(-1)};};
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn();const wallMs=performance.now()-t,u=process.cpuUsage(c);return {wallMs,cpuMs:(u.user+u.system)/1000,value};};
const state=s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()}));
const storage=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return {fileBytes:statSync(path).size,pageCount:db.prepare('PRAGMA page_count').get().page_count,freePages:db.prepare('PRAGMA freelist_count').get().freelist_count,index:db.prepare('SELECT name,COUNT(*) AS pages,SUM(pgsize) AS bytes FROM dbstat WHERE name=? GROUP BY name').all(indexName),replacementIndex:db.prepare('SELECT name,COUNT(*) AS pages,SUM(pgsize) AS bytes FROM dbstat WHERE name=? GROUP BY name').all(replacementIndexName),quickCheck:db.prepare('PRAGMA quick_check').get().quick_check};}finally{db.close();}};
const dir=mkdtempSync(join(tmpdir(),'hb-pending-drop-'));const opened=[];save();
try{
 for(const scenario of scenarios){
  const prefix=`${scenario.pending}-${scenario.bodyBytes}`,seedPath=join(dir,prefix+'-seed.sqlite'),seed=open(0,seedPath);
  const bee='00000000-0000-4000-8000-000000000001';
  seed.transact(()=>{seed.createBee({id:bee,name:'target',handle:'PM.target',agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState(bee,1,'running');for(let n=0;n<scenario.pending;n++)seed.send(bee,'x'.repeat(scenario.bodyBytes),{urgency:'idle'});});
  const seedSeq=seed.lastAuditSeq();seed.close();
  if(scenario.deliveredHistory){const db=new DatabaseSync(seedPath);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');const insert=db.prepare("INSERT INTO mailbox(bee_id,sender,body,urgency,enqueued_at,delivered_at,delivered_generation) VALUES(?,'fixture','delivered body','next',500,600,1)");for(let n=0;n<scenario.deliveredHistory;n++)insert.run(bee);db.exec('COMMIT');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();}
  const fixtureSha256=hash(readFileSync(seedPath));
  const paths=[0,1].map(side=>join(dir,prefix+'-'+side+'.sqlite'));const openRaw=[[],[]];
  for(let n=0;n<3;n++)for(const side of [0,1,1,0]){
   const path=join(dir,prefix+'-open.sqlite');copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);
   const {wallMs,cpuMs,value:store}=measure(()=>open(side,path));openRaw[side].push({wallMs,cpuMs});store.close();
   const info=storage(path);assert.equal(info.index.length,side===1&&!control?0:1);assert.equal(info.replacementIndex.length,1);assert.equal(info.quickCheck,'ok');rmSync(path);
  }
  for(const [side,path]of paths.entries()){copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);const store=open(side,path);store.close();}
  const beforeWritesStorage=paths.map(storage);assert(beforeWritesStorage.every(s=>s.quickCheck==='ok'));
  const rigs=paths.map((path,side)=>{const store=open(side,path);opened.push(store);const driver=new modules[side].fake.FakeDriver(()=>1000);let violations=0;const core=new modules[side].daemon.DaemonCore({store,driver,now:()=>1000,policy:{commandsPerStep:0,bootHangTimeoutSteps:1e12,i1DeadlineSteps:1e12},onI1Violation:()=>violations++,log:()=>{}});return {store,driver,core,violations:()=>violations};});
  const initial=rigs.map(r=>state(r.store));assert.equal(initial[0],initial[1]);assert(rigs.every(r=>r.store.lastAuditSeq()===seedSeq));
  const operations={i1:r=>r.store.readI1PendingSnapshot(),work:r=>r.store.readDaemonWork(),step:r=>r.core.step(),perBeeFull:r=>r.store.undeliveredMessages(bee),globalFull:r=>r.store.listUndeliveredMessages()};
  const results={};
  for(const [name,fn] of Object.entries(operations)){
   assert.deepEqual(fn(rigs[0]),fn(rigs[1]));for(let n=0;n<3;n++)for(const side of [0,1,1,0])fn(rigs[side]);
   const raw=[[],[]];for(let n=0;n<rounds;n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs}=measure(()=>fn(rigs[side]));raw[side].push({wallMs,cpuMs});}
   results[name]={raw,metrics:raw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))}))};
  }
  const diagnostics=rigs.map(r=>captureSql(()=>{r.store.readI1PendingSnapshot();r.store.readDaemonWork();}).statements);
  for(const [i,r] of rigs.entries()){assert.equal(state(r.store),initial[i]);assert.equal(r.violations(),0);assert.deepEqual(r.driver.starts,[]);assert.deepEqual(r.driver.deliveredIds,[]);assert.deepEqual(r.driver.interrupts,[]);}
  const writes={};
  for(const terminal of ['cancel','deliver','expedite-cancel']){
   const write=r=>{const outcomes=[];for(let j=0;j<100;j++){const msg=r.store.send(bee,'write'.repeat(13),{urgency:'idle'}).message;if(terminal==='expedite-cancel')outcomes.push(r.store.expediteMessage(bee,msg.id,'now').applied);outcomes.push(terminal==='deliver'?r.store.markDelivered(msg.id,1).applied:r.store.cancelMessage(bee,msg.id).canceled);}return outcomes;};
   for(const side of [0,1])assert(write(rigs[side]).every(Boolean));const raw=[[],[]];
   for(let n=0;n<5;n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs,value}=measure(()=>write(rigs[side]));assert(value.every(Boolean));raw[side].push({wallMs,cpuMs});}
   writes[terminal]={raw,metrics:raw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))}))};
  }
  assert.equal(state(rigs[0].store),state(rigs[1].store));assert(rigs.every(r=>r.store.listUndeliveredMessages().length===scenario.pending));
  for(const r of rigs){r.store.close();opened.splice(opened.indexOf(r.store),1);}
  const queryPlans=paths.map((path,side)=>{const db=new DatabaseSync(path,{readOnly:true});try{return diagnostics[side].filter(s=>s.kind==='all').map(s=>({sql:s.sql,plan:db.prepare('EXPLAIN QUERY PLAN '+s.sql).all()}));}finally{db.close();}});
  const afterWritesStorage=paths.map(storage);assert(afterWritesStorage.every(s=>s.quickCheck==='ok'));
  report.results.push({scenario,fixtureSha256,openRaw,openMetrics:openRaw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))})),beforeWritesStorage,results,diagnostics,queryPlans,writes,afterWritesStorage});save();
 }
 assert.deepEqual(roots.map(fingerprint),sources);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);assert.equal(hash(readFileSync(join(roots[0],'scripts/perf/sql-trace.mjs'))),sqlToolHash);assert.equal(boot(),report.environment.boot);report.completed=true;
}catch(e){report.failure=String(e.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const s of opened)s.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

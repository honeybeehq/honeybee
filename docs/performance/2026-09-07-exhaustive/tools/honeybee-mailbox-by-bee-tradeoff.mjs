import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {cpus,loadavg,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
const [beforeArg,afterArg,outArg,controlArg='false',roundsArg='15',scale='canonical']=process.argv.slice(2);
assert(beforeArg&&afterArg&&outArg,'before after out [control] [rounds] [smoke|canonical]');
assert(['true','false'].includes(controlArg));assert(['smoke','canonical'].includes(scale));
const roots=[beforeArg,afterArg].map(p=>realpathSync(p)),out=resolve(outArg),control=controlArg==='true',rounds=Number(roundsArg);
assert.notEqual(roots[0],roots[1]);assert(Number.isSafeInteger(rounds)&&rounds>=3&&rounds<=30);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=root=>{assert.equal(git(root,'status','--porcelain').trim(),'');const files=git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>(p.endsWith('.ts')&&p.includes('/src/'))||p.endsWith('package.json')||p==='package-lock.json'||p==='v2/daemon/tests/helpers.ts');return {revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const sources=roots.map(fingerprint),toolHash=hash(readFileSync(new URL(import.meta.url)));
assert.deepEqual(Object.keys(sources[0].hashes),Object.keys(sources[1].hashes));
assert.deepEqual(Object.keys(sources[0].hashes).filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]),control?[]:['v2/core/src/schema.ts','v2/core/src/store.ts']);
const moduleUrls=roots.map(root=>pathToFileURL(join(root,'v2/core/src/index.ts')).href);
const modules=await Promise.all(moduleUrls.map(url=>import(url)));
assert.notEqual(modules[0].CoreStore,modules[1].CoreStore);
const tracePath=join(roots[0],'scripts/perf/sql-trace.mjs'),{captureSql}=await import(pathToFileURL(tracePath).href),sqlToolHash=hash(readFileSync(tracePath));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return hash(r.stdout.trim());};
const indexName='mailbox_delivered_by_bee',now=()=>1000,open=(side,path)=>modules[side].openCoreStore(path,{now});
const target='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const scenarios=scale==='smoke'?[{name:'empty-target',target:0,other:200,bodyBytes:64},{name:'sparse-target',target:20,other:200,bodyBytes:64},{name:'full-target',target:200,other:0,bodyBytes:64},{name:'delivered-history-target',target:20,other:0,bodyBytes:64,extraDelivered:200,allTargetPending:true},{name:'large-target',target:5,other:20,bodyBytes:16384}]:[
 {name:'empty-target',target:0,other:100000,bodyBytes:64},
 {name:'sparse-target',target:20,other:100000,bodyBytes:64},
 {name:'full-target',target:100000,other:0,bodyBytes:64},
 {name:'delivered-history-target',target:20,other:0,bodyBytes:64,extraDelivered:100000,allTargetPending:true},
 {name:'large-target',target:100,other:1000,bodyBytes:1048576},
];
const report={completed:false,startedAt:new Date().toISOString(),roots,moduleUrls,sources,toolHash,sqlToolHash,control,indexName,
 environment:{node:process.version,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},
 workload:{scenarios,reads:{rounds,order:'ABBA',warmupRounds:3,warmupSamplesPerSide:6,samplesPerSide:rounds*2},opens:{rounds:3,order:'ABBA',warmupSamplesPerSide:0,samplesPerSide:6,reopen:'one already-installed reopen immediately after each fresh-file constructor'},writes:{rounds:5,order:'ABBA',warmupBatchesPerSide:1,samplesPerSide:10,batchCycles:100,expectedPerStore:{sends:3300,cancels:2200,deliveries:1100,expedites:1100,auditRows:7700,retainedMessages:1100}},deliveredFraction:'every third seeded row is pending unless allTargetPending; extraDelivered rows are all delivered'},
 scope:'Immutable modules; exactly schema.ts and store.ts differ; public constructor installs index on byte-identical pre-index databases. Offline mailbox fixture uses real existing UUID Bees and foreign-key checks, but does not synthesize enqueue audit/projection history. Only listMessages and pending/full-body authority reads consume those rows. Public timed send/cancel, send/deliver, and send/expedite/cancel writes retain production WAL/NORMAL durability and normal semantic audit. Read clocks exclude validation and diagnostics. Same-process caches/GC may cross sides. No retained-memory measurement. First open measures the full constructor including installation, not isolated CREATE INDEX; it excludes copy, close and inspection. Reopen measures the constructor on that installed database after close; caches warm. Storage on checkpointed closed files.',results:[]};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const dist=xs=>{const s=[...xs].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],min:s[0],max:s.at(-1)};};
const summarize=raw=>raw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))}));
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn(),wallMs=performance.now()-t,u=process.cpuUsage(c);return {wallMs,cpuMs:(u.user+u.system)/1000,value};};
const state=s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()}));
const storage=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return {fileBytes:statSync(path).size,pageCount:db.prepare('PRAGMA page_count').get().page_count,freePages:db.prepare('PRAGMA freelist_count').get().freelist_count,index:db.prepare('SELECT name,COUNT(*) AS pages,SUM(pgsize) AS bytes FROM dbstat WHERE name=? GROUP BY name').all(indexName),quickCheck:db.prepare('PRAGMA quick_check').get().quick_check};}finally{db.close();}};
const dir=mkdtempSync(join(tmpdir(),'hb-mailbox-by-bee-'));const opened=[];save();
try{
 for(const scenario of scenarios){
  const seedPath=join(dir,scenario.name+'-seed.sqlite'),seed=open(0,seedPath);
  seed.transact(()=>{for(const [id,name]of[[target,'target'],[other,'other']]){seed.createBee({id,name,handle:'IX.'+name,agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState(id,1,'running');}});
  const seedSeq=seed.lastAuditSeq();seed.close();
  const db=new DatabaseSync(seedPath);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const insert=db.prepare("INSERT INTO mailbox(bee_id,sender,body,priority,urgency,enqueued_at,delivered_at,delivered_generation) VALUES(?,'fixture',?,?,'idle',500,?,?)");
  // Interleave target rows through unrelated history; avoid a contiguous target-only tail.
  const count=Math.max(scenario.target,scenario.other),targetBody='t'.repeat(scenario.bodyBytes);let targetOrdinal=0,otherOrdinal=0;
  for(let n=0;n<count;n++){
   if(Math.floor((n+1)*scenario.other/count)>otherOrdinal){const j=otherOrdinal++;insert.run(other,'other'.repeat(13),j%5,j%3===0?null:600,j%3===0?null:1);}
   if(Math.floor((n+1)*scenario.target/count)>targetOrdinal){const j=targetOrdinal++,pending=scenario.allTargetPending||j%3===0;insert.run(target,targetBody,j%7,pending?null:600,pending?null:1);}
  }
  assert.equal(targetOrdinal,scenario.target);assert.equal(otherOrdinal,scenario.other);
  if(scenario.extraDelivered){for(let n=0;n<scenario.extraDelivered;n++)insert.run(target,'h'.repeat(scenario.bodyBytes),0,600,1);}
  db.exec('COMMIT');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  const fixtureSha256=hash(readFileSync(seedPath)),openRaw=[[],[]],reopenRaw=[[],[]];
  for(let n=0;n<3;n++)for(const side of [0,1,1,0]){
   const path=join(dir,scenario.name+'-open.sqlite');copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);
   const {wallMs,cpuMs,value:store}=measure(()=>open(side,path));openRaw[side].push({wallMs,cpuMs});store.close();
   const info=storage(path);assert.equal(info.index.length,side===1&&!control?1:0);assert.equal(info.quickCheck,'ok');
   const reopened=measure(()=>open(side,path));reopenRaw[side].push({wallMs:reopened.wallMs,cpuMs:reopened.cpuMs});reopened.value.close();rmSync(path);
  }
  const paths=[0,1].map(side=>join(dir,scenario.name+'-'+side+'.sqlite'));
  for(const [side,path]of paths.entries()){copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);open(side,path).close();}
  const beforeWritesStorage=paths.map(storage);let stores=paths.map((path,side)=>open(side,path));opened.push(...stores);
  const initial=stores.map(state);assert.equal(initial[0],initial[1]);assert(stores.every(s=>s.lastAuditSeq()===seedSeq));
  const operations={listTarget:s=>s.listMessages(target),pendingTarget:s=>s.undeliveredMessages(target)};
  const results={};
  for(const[name,fn]of Object.entries(operations)){
   const before=fn(stores[0]),after=fn(stores[1]);assert.deepEqual(after,before);
   assert.equal(before.length,name==='listTarget'?scenario.target+(scenario.extraDelivered??0):(scenario.allTargetPending?scenario.target:Math.ceil(scenario.target/3)));
   assert(before.every((m,i)=>m.beeId===target&&(i===0||m.id>before[i-1].id)));
   for(let n=0;n<3;n++)for(const side of [0,1,1,0])fn(stores[side]);
   const raw=[[],[]];for(let n=0;n<rounds;n++)for(const side of [0,1,1,0]){const{wallMs,cpuMs}=measure(()=>fn(stores[side]));raw[side].push({wallMs,cpuMs});}
   results[name]={raw,metrics:summarize(raw)};
  }
  const diagnostics=stores.map(s=>captureSql(()=>{s.listMessages(target);s.undeliveredMessages(target);s.readI1PendingSnapshot();s.readDaemonWork();}).statements);
  assert(stores.every((s,i)=>state(s)===initial[i]));
  // CoreStore holds an exclusive connection lock. Close read stores before
  // separate readonly EXPLAIN connections; reopen unchanged fixtures for writes.
  for(const s of stores){s.close();opened.splice(opened.indexOf(s),1);}
  const queryPlans=paths.map((path,side)=>{const db=new DatabaseSync(path,{readOnly:true});try{return diagnostics[side].filter(s=>s.kind==='all').map(s=>({sql:s.sql,plan:db.prepare('EXPLAIN QUERY PLAN '+s.sql).all(...Array((s.sql.match(/\?/g)??[]).length).fill(target))}));}finally{db.close();}});
  stores=paths.map((path,side)=>open(side,path));opened.push(...stores);
  assert(stores.every((s,i)=>state(s)===initial[i]));
  const writes={};
  for(const terminal of ['cancel','deliver','expedite-cancel']){
   const write=s=>{const ok=[];for(let j=0;j<100;j++){const m=s.send(target,'write'.repeat(13),{urgency:'idle'}).message;if(terminal==='expedite-cancel')ok.push(s.expediteMessage(target,m.id,'now').applied);ok.push(terminal==='deliver'?s.markDelivered(m.id,1).applied:s.cancelMessage(target,m.id).canceled);}return ok;};
   for(const s of stores)assert(write(s).every(Boolean));const raw=[[],[]];
   for(let n=0;n<5;n++)for(const side of [0,1,1,0]){const{wallMs,cpuMs,value}=measure(()=>write(stores[side]));assert(value.every(Boolean));raw[side].push({wallMs,cpuMs});}
   writes[terminal]={raw,metrics:summarize(raw)};
  }
  const writeAuditDeltas=stores.map(s=>s.lastAuditSeq()-seedSeq);assert.deepEqual(writeAuditDeltas,[7700,7700]);
  assert.equal(state(stores[0]),state(stores[1]));
  assert(stores.every(s=>s.listMessages(target).length===scenario.target+(scenario.extraDelivered??0)+1100));
  for(const s of stores){s.close();opened.splice(opened.indexOf(s),1);}
  const afterWritesStorage=paths.map(storage);assert(afterWritesStorage.every(s=>s.quickCheck==='ok'));
  report.results.push({scenario,fixtureSha256,openRaw,openMetrics:summarize(openRaw),reopenRaw,reopenMetrics:summarize(reopenRaw),beforeWritesStorage,results,diagnostics,queryPlans,queryPlanPhase:'before writes, same fixture as timed reads',writeAuditDeltas,writes,afterWritesStorage});save();
 }
 assert.deepEqual(roots.map(fingerprint),sources);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);assert.equal(hash(readFileSync(tracePath)),sqlToolHash);assert.equal(boot(),report.environment.boot);report.completed=true;
}catch(e){report.failure=String(e.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const s of opened)s.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

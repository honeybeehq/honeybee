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
const roots=[beforeArg,afterArg].map(p=>resolve(p)),out=resolve(outArg),control=controlArg==='true',rounds=Number(roundsArg);
assert.notEqual(roots[0],roots[1]);assert(Number.isSafeInteger(rounds)&&rounds>=3&&rounds<=30);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=root=>{assert.equal(git(root,'status','--porcelain').trim(),'');const files=git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>(p.endsWith('.ts')&&p.includes('/src/'))||p.endsWith('package.json')||p==='package-lock.json'||p==='v2/daemon/tests/helpers.ts');return {revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const sources=roots.map(fingerprint),toolHash=hash(readFileSync(new URL(import.meta.url)));
assert.deepEqual(Object.keys(sources[0].hashes),Object.keys(sources[1].hashes));
assert.deepEqual(Object.keys(sources[0].hashes).filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]),control?[]:['v2/core/src/schema.ts']);
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return hash(r.stdout.trim());};
const modules=await Promise.all(roots.map(async root=>({core:await import(pathToFileURL(join(root,'v2/core/src/index.ts')).href),daemon:await import(pathToFileURL(join(root,'v2/daemon/src/loops.ts')).href),fake:await import(pathToFileURL(join(root,'v2/daemon/tests/helpers.ts')).href)})));
assert.notEqual(modules[0].core.CoreStore,modules[1].core.CoreStore);
const indexName='commands_stop_recovery';
const sql=`SELECT 1 FROM commands
       WHERE bee_id = ? AND status IN ('done','running')
         AND verb = 'stop' AND target_generation = ?
         AND json_type(args, '$.thenRevive') = 'true'
       LIMIT 1`;
for(const root of roots)assert(readFileSync(join(root,'v2/core/src/store.ts'),'utf8').includes(sql));
const count=scale==='smoke'?100:100000,gens=scale==='smoke'?4:200;
const scenarios=[{name:'same-generation',count,gens:1,mixed:false,probe:1},{name:'spread-generations',count,gens,mixed:false,probe:gens},{name:'mixed-verbs',count,gens:1,mixed:true,probe:1},{name:'off-generation',count,gens,mixed:false,probe:gens+1}];
const report={completed:false,startedAt:new Date().toISOString(),sources,toolHash,control,environment:{node:process.version,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},workload:{scenarios,rounds,order:'ABBA',warmups:3,writeBatch:100,writeRounds:3,openRounds:3},scope:'Two distinct immutable real CoreStore/DaemonCore modules. Each side starts from a byte-identical pre-index DB. Runtime generations seeded through public APIs; settled command history inserted offline in one transaction, with existing bee IDs, valid JSON and foreign_key_check. Public reads/boot and normal durable enqueue/claim/complete or fail writes. Fresh-template copies before each measured open include first index installation; file copying, close/checkpoint and assertions outside open clock. Same generation retains JSON residual. No live runtime or worker. Raw process CPU/wall; no retained-memory claim.',results:[]};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const dist=xs=>{const s=[...xs].sort((a,b)=>a-b);return {n:s.length,p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],min:s[0],max:s.at(-1)};};
const summarize=raw=>raw.map(xs=>({wallMs:dist(xs.map(x=>x.wallMs)),cpuMs:dist(xs.map(x=>x.cpuMs))}));
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn();const wallMs=performance.now()-t,u=process.cpuUsage(c);return {wallMs,cpuMs:(u.user+u.system)/1000,value};};
const state=s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()}));
const storage=path=>{const db=new DatabaseSync(path,{readOnly:true});try{return {fileBytes:statSync(path).size,pageCount:db.prepare('PRAGMA page_count').get().page_count,freePages:db.prepare('PRAGMA freelist_count').get().freelist_count,index:db.prepare('SELECT name,COUNT(*) AS pages,SUM(pgsize) AS bytes FROM dbstat WHERE name=? GROUP BY name').all(indexName),indexSql:db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(indexName)?.sql??null,plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all('00000000-0000-4000-8000-000000000001',1),quickCheck:db.prepare('PRAGMA quick_check').get().quick_check,foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all()};}finally{db.close();}};
const dir=mkdtempSync(join(tmpdir(),'hb-stop-tradeoff-'));const opened=[];save();
const open=(side,path)=>modules[side].core.openCoreStore(path,{now:()=>1000,maxAttempts:1});
const close=s=>{s.close();opened.splice(opened.indexOf(s),1);};
try{
 for(const scenario of scenarios){
  const seedPath=join(dir,scenario.name+'-seed.sqlite'),seed=open(0,seedPath);opened.push(seed);
  seed.transact(()=>{seed.createBee({id:'00000000-0000-4000-8000-000000000001',name:'00000000-0000-4000-8000-000000000001',handle:'SR.target',agent:'stub',substrate:'hsr',cwd:dir});for(let gen=1;gen<=scenario.gens;gen++){if(gen>1)assert.equal(seed.reviveBee('00000000-0000-4000-8000-000000000001').generation,gen);seed.updateRuntimeState('00000000-0000-4000-8000-000000000001',gen,'stopped',{exitCause:'clean'});}seed.createBee({id:'00000000-0000-4000-8000-000000000002',name:'00000000-0000-4000-8000-000000000002',handle:'SR.writer',agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState('00000000-0000-4000-8000-000000000002',1,'stopped',{exitCause:'clean'});});
  close(seed);
  const db=new DatabaseSync(seedPath);assert.equal(db.prepare('SELECT name FROM sqlite_schema WHERE name=?').get(indexName),undefined);db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  const insert=db.prepare(`INSERT INTO commands(verb,bee_id,args,target_generation,status,attempts,next_attempt_at,enqueued_at,finished_at,failure_cause,idempotency_key) VALUES(?,'00000000-0000-4000-8000-000000000001',?,?,'done',1,0,0,1,NULL,NULL)`);
  const args=JSON.stringify({thenRevive:false,reason:'read-cost-fixture'});
  for(let n=0;n<scenario.count;n++)insert.run(scenario.mixed&&n%2?'send_wake':'stop',args,1+n%scenario.gens);
  db.exec('COMMIT');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
  const fixtureSha256=hash(readFileSync(seedPath)),seedStorage=storage(seedPath),openRaw=[[],[]];
  // Each clock sees the same old-format file, even on the second open sample.
  for(let n=0;n<3;n++)for(const side of [0,1,1,0]){
   const path=join(dir,scenario.name+'-open.sqlite');copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);
   const {value:store,wallMs,cpuMs}=measure(()=>open(side,path));opened.push(store);openRaw[side].push({wallMs,cpuMs});close(store);
   const info=storage(path);assert.equal(Boolean(info.indexSql),side===1&&!control);assert.equal(info.quickCheck,'ok');assert.deepEqual(info.foreignKeyViolations,[]);rmSync(path);
  }
  const paths=[0,1].map(side=>join(dir,scenario.name+'-'+side+'.sqlite'));
  const rigs=paths.map((path,side)=>{copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);const store=open(side,path);opened.push(store);const driver=new modules[side].fake.FakeDriver(()=>1000);driver.autoBoot=false;const core=new modules[side].daemon.DaemonCore({store,driver,now:()=>1000,policy:{commandsPerStep:0,i1DeadlineSteps:null,idleWindowSteps:null},onI1Violation:()=>assert.fail('unexpected violation'),log:()=>{}});return {store,driver,core};});
  const initial=rigs.map(r=>state(r.store));assert.equal(initial[0],initial[1]);
  const seq=rigs.map(r=>r.store.lastAuditSeq());const results={};
  for(const [name,fn] of Object.entries({predicate:r=>r.store.hasStopThenReviveRequest('00000000-0000-4000-8000-000000000001',scenario.probe),boot:r=>r.core.boot()})){
   const check=value=>name==='predicate'?assert.equal(value,false):assert.deepEqual(value,{adopted:0,stoppedByReconcile:0,requeuedCommands:0,orphansReaped:0,wakesEnqueued:0});
   for(let n=0;n<3;n++)for(const side of [0,1,1,0])check(fn(rigs[side]));
   const raw=[[],[]];for(let n=0;n<rounds;n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs,value}=measure(()=>fn(rigs[side]));check(value);raw[side].push({wallMs,cpuMs});}results[name]={raw,metrics:summarize(raw)};
  }
  assert.equal(state(rigs[0].store),state(rigs[1].store));
  for(const [side,r] of rigs.entries()){const rows=r.store.auditRows(seq[side]);assert.equal(rows.length,2*(3+rounds));assert(rows.every(row=>row.kind==='boot.reconciled'));assert.deepEqual(r.driver.starts,[]);assert.deepEqual(r.driver.deliveredIds,[]);assert.deepEqual(r.driver.interrupts,[]);}
  // Boot correctly reconciles non-live runtimes. Create a fresh usable generation
  // for the subsequent command-write fixture, outside its clocks.
  for(const r of rigs){const revived=r.store.reviveBee('00000000-0000-4000-8000-000000000002');r.store.updateRuntimeState('00000000-0000-4000-8000-000000000002',revived.generation,'running');}
  const writes={};
  for(const terminal of ['done','failed']){
   const write=r=>{const ids=[];for(let j=0;j<100;j++){const cmd=r.store.enqueueCommand('stop','00000000-0000-4000-8000-000000000002',{thenRevive:false});const claimed=r.store.claimNextCommand();ids.push([cmd.id,claimed?.id]);if(terminal==='done')r.store.completeCommand(cmd.id);else r.store.reportCommandFailure(cmd.id,'node_unreachable');}return ids;};
   for(const side of [0,1])for(const [id,claimed]of write(rigs[side]))assert.equal(id,claimed);
   const raw=[[],[]];for(let n=0;n<3;n++)for(const side of [0,1,1,0]){const {wallMs,cpuMs,value}=measure(()=>write(rigs[side]));for(const [id,claimed]of value)assert.equal(id,claimed);raw[side].push({wallMs,cpuMs});}writes[terminal]={raw,metrics:summarize(raw)};
  }
  assert.equal(state(rigs[0].store),state(rigs[1].store));
  for(const r of rigs){const history=r.store.listCommands({beeId:'00000000-0000-4000-8000-000000000001'});assert.equal(history.length,scenario.count);assert(history.every(c=>c.status==='done'&&c.args.thenRevive===false));const written=r.store.listCommands({beeId:'00000000-0000-4000-8000-000000000002'});assert.equal(written.length,1400);assert.equal(written.filter(c=>c.status==='done').length,700);assert.equal(written.filter(c=>c.status==='failed').length,700);close(r.store);}
  const finalStorage=paths.map(storage);for(const [side,info]of finalStorage.entries()){assert.equal(Boolean(info.indexSql),side===1&&!control);assert.equal(info.quickCheck,'ok');assert.deepEqual(info.foreignKeyViolations,[]);const plan=info.plan.map(p=>p.detail).join('\n');assert.match(plan,side===1&&!control?/commands_stop_recovery \(bee_id=\? AND target_generation=\?\)/:/commands_by_bee_status/);}
  report.results.push({scenario,fixtureSha256,seedStorage,openRaw,openMetrics:summarize(openRaw),results,writes,finalStorage});save();
 }
 assert.deepEqual(roots.map(fingerprint),sources);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);assert.equal(boot(),report.environment.boot);report.completed=true;
}catch(e){report.failure=String(e.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const s of opened)s.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

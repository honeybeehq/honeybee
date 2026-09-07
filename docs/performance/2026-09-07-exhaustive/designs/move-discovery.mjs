import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,loadavg,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
const [before,after,out,expectedChanges,roundsArg='15']=process.argv.slice(2);
assert(before&&after&&out&&expectedChanges!==undefined);
const roots=[before,after].map(p=>resolve(p)),rounds=Number(roundsArg);
assert.notEqual(roots[0],roots[1]);assert(Number.isInteger(rounds)&&rounds>=3&&rounds<=30);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>{const p=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(p.status,0,p.stderr);return p.stdout;};
const fingerprint=root=>{assert.doesNotMatch(git(root,'status','--porcelain'),/^.. v2\//m);return {revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>p.includes('/src/')||p.endsWith('package.json')||p==='package-lock.json'||p==='v2/daemon/tests/helpers.ts').map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const sources=roots.map(fingerprint),changed=[...new Set(sources.flatMap(s=>Object.keys(s.hashes)))].filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]).sort();
assert.deepEqual(changed,expectedChanges.split(',').filter(Boolean).sort());
const toolHash=hash(readFileSync(new URL(import.meta.url))),boot=()=>{const p=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return hash(p.stdout.trim());};
const modules=[];
for(const root of roots){const load=p=>import(pathToFileURL(join(root,p)).href);modules.push({...await load('v2/core/src/index.ts'),...await load('v2/daemon/src/loops.ts'),...await load('v2/daemon/tests/helpers.ts')});}
assert.notEqual(modules[0].CoreStore,modules[1].CoreStore);
const report={completed:false,startedAt:new Date().toISOString(),sources,changed,toolHash,environment:{node:process.version,execArgv:process.execArgv,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},workload:{rounds,order:'ABBA',samplesPerSide:rounds*2,warmupRounds:3,history:[0,1000,100000],active:[0,1,10]},scope:'Real listActiveBeeMoves on copied databases. Historical failed receipts are synthesized offline from a public-API receipt; active moves use public admission. Whole quiet steps are measured only at zero active moves with FakeDriver and commands disabled. Checks/setup/cleanup excluded. No process-spawn, RPC, migration, or storage improvement claim.',results:[]};
const dir=mkdtempSync(join(tmpdir(),'hb-move-discovery-')),opened=new Set();
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');save();
const stats=xs=>{const s=[...xs].sort((a,b)=>a-b);return {n:s.length,min:s[0],p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],max:s.at(-1)};};
const open=(module,path)=>{const store=module.openCoreStore(path,{now:()=>1800000000000});opened.add(store);return store;};
const close=store=>{store.close();opened.delete(store);};
function createMove(store,label){
 const {bee}=store.createBee({id:label,name:label,agent:'claude',substrate:'cell',cwd:`/tmp/${label}`});
 store.updateRuntimeState(bee.id,1,'stopped',{exitCause:'clean'});
 const cell=store.putCell({sourceBeeId:bee.id,originRepo:'/tmp/origin',sha:'abc',wrapper:label,spaceName:'fixture-space-c1',spaceDir:bee.cwd,gitCommonDirRealpath:'/tmp/origin/.git',objectFormat:'sha1'});
 return store.admitBeeMove({beeId:bee.id,idempotencyKey:label,requestHash:label,expected:{placementVersion:0,cellId:cell.id},destinationCwd:'/tmp/checkout'});
}
try{
 for(const [history,active] of [[0,0],[1000,0],[100000,0],[100000,1],[100000,10]]){
  const name=`h${history}-a${active}`,seedPath=join(dir,`${name}-seed.sqlite`),seed=open(modules[0],seedPath);
  const old=createMove(seed,'historical');seed.failBeeMove(old.id,{stage:'context',code:'transcript_unavailable',detail:'fixture'});
  const expected=[];for(let i=0;i<active;i++)expected.push(createMove(seed,`active-${i}`));expected.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  close(seed);
  const db=new DatabaseSync(seedPath);
  try{
   const template=db.prepare('SELECT * FROM bee_moves WHERE id=?').get(old.id),columns=Object.keys(template),quoted=columns.map(s=>'"'+s.replaceAll('"','""')+'"');
   const insert=db.prepare(`INSERT INTO bee_moves(${quoted.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
   db.exec('PRAGMA synchronous=OFF; BEGIN IMMEDIATE');db.prepare('DELETE FROM bee_moves WHERE id=?').run(old.id);
   for(let i=0;i<history;i++){
    const id=`dead0000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`;
    const row={...template,id,idempotency_key:id,stop_command_key:`stop-${id}`,revive_command_key:`revive-${id}`};insert.run(...columns.map(c=>row[c]));
   }
   db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM bee_moves').get().n),history+active);
  }finally{db.close();}
  const fixtureHash=hash(readFileSync(seedPath));
  const sides=modules.map((module,side)=>{
   const path=join(dir,`${name}-${side}.sqlite`);copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureHash);
   const store=open(module,path),driver=new module.FakeDriver(()=>1800000000000);
   const core=new module.DaemonCore({store,driver,now:()=>1800000000000,policy:{commandsPerStep:0,bootHangTimeoutSteps:1e12},log:()=>{}});
   let query='';const original=DatabaseSync.prototype.prepare;
   DatabaseSync.prototype.prepare=function(sql){if(sql.includes('SELECT m.* FROM bees b JOIN bee_moves m'))query=sql;return Reflect.apply(original,this,[sql]);};
   try{assert.deepEqual(store.listActiveBeeMoves(),expected);}finally{DatabaseSync.prototype.prepare=original;}
   assert(query);return {store,driver,core,path,query,seq:store.lastAuditSeq()};
  });
  const operations=[];
  for(const operation of active===0?['discovery','quietStep']:['discovery']){
   const invoke=side=>operation==='discovery'?sides[side].store.listActiveBeeMoves():sides[side].core.step();
   const check=(side,value)=>{if(operation==='discovery')assert.deepEqual(value,expected);assert.equal(sides[side].store.lastAuditSeq(),sides[side].seq);};
   for(let r=0;r<3;r++)for(const side of [0,1,1,0])check(side,invoke(side));
   const raw=[[],[]];
   for(let r=0;r<rounds;r++)for(const side of [0,1,1,0]){
    const cpu=process.cpuUsage(),start=performance.now(),value=invoke(side),wallMs=performance.now()-start,used=process.cpuUsage(cpu);
    raw[side].push({wallMs,cpuMs:(used.user+used.system)/1000});check(side,value);
   }
   operations.push({operation,raw,metrics:raw.map(xs=>({wallMs:stats(xs.map(s=>s.wallMs)),cpuMs:stats(xs.map(s=>s.cpuMs))}))});
  }
  const plans=[];
  for(const side of sides){
   assert.deepEqual(side.store.listActiveBeeMoves(),expected);assert.equal(side.store.lastAuditSeq(),side.seq);assert.deepEqual(side.driver.starts,[]);assert.deepEqual(side.driver.deliveredIds,[]);close(side.store);
   const db=new DatabaseSync(side.path,{readOnly:true});try{plans.push(db.prepare(`EXPLAIN QUERY PLAN ${side.query}`).all().map(r=>String(r.detail)));assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM bee_moves').get().n),history+active);assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{db.close();}
  }
  report.results.push({name,history,active,fixtureHash,expectedActiveHash:hash(JSON.stringify(expected)),operations,plans});save();
 }
 assert.deepEqual(roots.map(fingerprint),sources);assert.equal(boot(),report.environment.boot);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);report.completed=true;
}catch(e){report.failure=String(e?.stack??e);throw e;}
finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const store of opened)store.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

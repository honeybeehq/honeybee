import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,loadavg,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {Session} from 'node:inspector/promises';
const [beforeArg,afterArg,outArg,controlArg='false',mode='none',scale='canonical']=process.argv.slice(2);
assert(beforeArg&&afterArg&&outArg);assert(['true','false'].includes(controlArg));assert(['none','profile'].includes(mode));assert(['smoke','canonical'].includes(scale));
const roots=[beforeArg,afterArg].map(p=>realpathSync(p)),out=resolve(outArg),control=controlArg==='true';assert.notEqual(...roots);assert(!existsSync(out),'report already exists');
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(root,...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=root=>{assert.equal(git(root,'status','--porcelain').trim(),'');const files=git(root,'ls-files','v2','package.json','package-lock.json').trim().split('\n').filter(p=>(p.endsWith('.ts')&&p.includes('/src/'))||p.endsWith('package.json')||p==='package-lock.json');return{revision:git(root,'rev-parse','HEAD').trim(),hashes:Object.fromEntries(files.map(p=>[p,hash(readFileSync(join(root,p)))]))};};
const sources=roots.map(fingerprint),toolHash=hash(readFileSync(new URL(import.meta.url)));assert.deepEqual(Object.keys(sources[0].hashes),Object.keys(sources[1].hashes));assert.deepEqual(Object.keys(sources[0].hashes).filter(p=>sources[0].hashes[p]!==sources[1].hashes[p]),control?[]:['v2/core/src/store.ts']);
const moduleUrls=roots.map(root=>pathToFileURL(join(root,'v2/core/src/index.ts')).href),modules=await Promise.all(moduleUrls.map(url=>import(url)));assert.notEqual(modules[0].CoreStore,modules[1].CoreStore);
const tracePath=join(roots[0],'scripts/perf/sql-trace.mjs'),{captureSql}=await import(pathToFileURL(tracePath).href),sqlToolHash=hash(readFileSync(tracePath));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return hash(r.stdout.trim());};
const target='00000000-0000-4000-8000-000000000001',now=()=>1000,open=(side,path)=>modules[side].openCoreStore(path,{now});
const scenarios=[{name:'empty',count:0,calls:scale==='smoke'?10:1000},{name:'twenty',count:20,calls:scale==='smoke'?10:1000},{name:'thousand',count:scale==='smoke'?50:1000,calls:scale==='smoke'?2:20}];
const rounds=scale==='smoke'?3:15,report={completed:false,startedAt:new Date().toISOString(),roots,moduleUrls,sources,toolHash,sqlToolHash,control,mode,environment:{node:process.version,cpu:cpus()[0].model,boot:boot(),loadBefore:loadavg()},workload:{scenarios,rounds,warmupRounds:3,warmupBatchesPerSide:6,batchesPerSide:rounds*2,order:'ABBA',bodyBytes:64,delivered:'every row except each third'},scope:'Public CoreStore fixture in one transaction, real running Bee, identical closed-file copies. Whole read batches are timed; results report per-batch and per-call CPU/wall. Cold first read and warmed prepares are separate SQL diagnostics, excluded from clocks. SQL text/rows/order/audit state parity asserted. Same-process GC and OS caches may cross sides. Allocation profiles include collected objects and exclude setup/diagnostic/timing loops; they measure V8 sampled allocation traffic, not retained memory or native SQLite statement memory. No worker, RPC, title-provider or fleet idle claim.',results:[]};
const save=()=>writeFileSync(out,JSON.stringify(report,null,2)+'\n');
const measure=fn=>{const c=process.cpuUsage(),t=performance.now();const value=fn(),wallMs=performance.now()-t,u=process.cpuUsage(c);return{wallMs,cpuMs:(u.user+u.system)/1000,value};};
const dist=xs=>{const s=[...xs].sort((a,b)=>a-b);return{n:s.length,p50:s[Math.floor((s.length-1)/2)],p95:s[Math.ceil((s.length-1)*.95)],min:s[0],max:s.at(-1)};};
const state=s=>hash(JSON.stringify({state:s.dumpState(),audit:s.auditRows()}));
const dir=mkdtempSync(join(tmpdir(),'hb-mailbox-stmt-cache-')),opened=[];save();
try{
 for(const scenario of scenarios){
  const seedPath=join(dir,scenario.name+'-seed.sqlite'),seed=open(0,seedPath);
  seed.transact(()=>{seed.createBee({id:target,name:'target',handle:'IX.target',agent:'stub',substrate:'hsr',cwd:dir});seed.updateRuntimeState(target,1,'running');for(let i=0;i<scenario.count;i++){const m=seed.send(target,'x'.repeat(64),{urgency:'idle'}).message;if(i%3!==0)assert(seed.markDelivered(m.id,1).applied);}});seed.close();
  const fixtureSha256=hash(readFileSync(seedPath)),paths=[0,1].map(side=>join(dir,scenario.name+'-'+side+'.sqlite'));
  for(const path of paths){copyFileSync(seedPath,path);assert.equal(hash(readFileSync(path)),fixtureSha256);}
  const stores=paths.map((path,side)=>open(side,path));opened.push(...stores);
  const initial=stores.map(state);assert.equal(initial[0],initial[1]);
  const cold=stores.map(s=>captureSql(()=>s.listMessages(target)));
  assert.deepEqual(cold[0].value,cold[1].value);assert.equal(cold[0].value.length,scenario.count);
  for(const value of cold[0].value)assert.deepEqual(value,stores[0].getMessage(value.id));
  const coldSql=cold.map(d=>d.statements.find(x=>x.kind==='all'));assert(coldSql.every(Boolean));assert.equal(coldSql[0].sql,coldSql[1].sql);assert(cold.every(d=>d.statements.filter(x=>x.kind==='prepare').reduce((n,x)=>n+x.calls,0)===1));
  const batch=s=>{let rows=0;for(let i=0;i<scenario.calls;i++)rows+=s.listMessages(target).length;return rows;};
  for(let i=0;i<3;i++)for(const side of [0,1,1,0])assert.equal(batch(stores[side]),scenario.count*scenario.calls);
  const raw=[[],[]];for(let i=0;i<rounds;i++)for(const side of [0,1,1,0]){const{wallMs,cpuMs,value}=measure(()=>batch(stores[side]));assert.equal(value,scenario.count*scenario.calls);raw[side].push({wallMs,cpuMs});}
  const diagnostics=stores.map(s=>captureSql(()=>batch(s)).statements);
  const expectedPrepares=[scenario.calls,control?scenario.calls:0];
  for(const [side,d]of diagnostics.entries()){assert.equal(d.filter(x=>x.kind==='prepare').reduce((n,x)=>n+x.calls,0),expectedPrepares[side]);const reads=d.filter(x=>x.kind==='all');assert.equal(reads.length,1);assert.equal(reads[0].sql,coldSql[0].sql);assert.equal(reads[0].calls,scenario.calls);assert.equal(reads[0].rows,scenario.calls*scenario.count);}
  const profiles=[];
  if(mode==='profile')for(const [side,s]of stores.entries()){
   const session=new Session();session.connect();try{await session.post('HeapProfiler.enable');await session.post('HeapProfiler.startSampling',{samplingInterval:4096,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});assert.equal(batch(s),scenario.calls*scenario.count);const{profile}=await session.post('HeapProfiler.stopSampling');const path=out+'.'+scenario.name+'.'+side+'.heapprofile';writeFileSync(path,JSON.stringify(profile));const sum=n=>n.selfSize+n.children.reduce((a,c)=>a+sum(c),0);profiles.push({side,path,sha256:hash(readFileSync(path)),sampledBytes:sum(profile.head),calls:scenario.calls});}finally{session.disconnect();}
  }
  assert(stores.every((s,i)=>state(s)===initial[i]));assert.deepEqual(stores[0].listMessages(target),cold[0].value);assert.deepEqual(stores[1].listMessages(target),cold[0].value);
  for(const s of stores){s.close();opened.splice(opened.indexOf(s),1);}
  report.results.push({scenario,fixtureSha256,raw,metrics:raw.map(xs=>({batchWallMs:dist(xs.map(x=>x.wallMs)),batchCpuMs:dist(xs.map(x=>x.cpuMs)),callWallMs:dist(xs.map(x=>x.wallMs/scenario.calls)),callCpuMs:dist(xs.map(x=>x.cpuMs/scenario.calls))})),cold: cold.map(d=>d.statements),diagnostics,profiles});save();
 }
 assert.deepEqual(roots.map(fingerprint),sources);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);assert.equal(hash(readFileSync(tracePath)),sqlToolHash);assert.equal(boot(),report.environment.boot);report.completed=true;
}catch(e){report.failure=String(e.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();for(const s of opened)s.close();rmSync(dir,{recursive:true,force:true});}
console.log(out);

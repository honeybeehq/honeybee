import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {cpus,loadavg,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [rootArg,outArg,batchArg='1000',cohortsArg='30']=process.argv.slice(2),root=resolve(rootArg),batch=Number(batchArg),cohorts=Number(cohortsArg);
assert(Number.isInteger(batch)&&batch>=1&&batch<=10000);assert(Number.isInteger(cohorts)&&cohorts>=3&&cohorts<=50);assert.equal(typeof global.gc,'function');
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;};
const fingerprint=()=>({revision:git('rev-parse','HEAD').trim(),hashes:Object.fromEntries(git('ls-files','v2').trim().split('\n').filter(f=>f.endsWith('.ts')&&(f.includes('/src/')||f==='v2/daemon/tests/helpers.ts')).map(f=>[f,hash(readFileSync(join(root,f)))]))});
const source=fingerprint();assert.doesNotMatch(git('status','--porcelain'),/^.. v2\//m);const toolHash=hash(readFileSync(new URL(import.meta.url)));
const {openCoreStore}=await import(pathToFileURL(join(root,'v2/core/src/index.ts')));
const {DaemonCore}=await import(pathToFileURL(join(root,'v2/daemon/src/loops.ts')));
const {FakeDriver}=await import(pathToFileURL(join(root,'v2/daemon/tests/helpers.ts')));
const boot=()=>{const r=spawnSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};const bootUUID=boot();
const dir=mkdtempSync(join(tmpdir(),'hb-retained-i1-'));let now=1800000000000,violations=0;
const store=openCoreStore(join(dir,'core.sqlite3'),{now:()=>now});
const driver=new FakeDriver(()=>now);
const core=new DaemonCore({store,driver,now:()=>now,policy:{commandsPerStep:0,bootHangTimeoutSteps:1e12,i1DeadlineSteps:1},onI1Violation:()=>{violations++;},log:()=>{}});
const counts=()=>{assert(core.reportedI1 instanceof Set);assert(core.interruptRequested instanceof Set);return {reportedI1:core.reportedI1.size,interruptRequested:core.interruptRequested.size};};
const sample=()=>{global.gc();return {memory:process.memoryUsage(),counts:counts()};};
const report={completed:false,startedAt:new Date().toISOString(),source,toolHash,environment:{bootUUID,node:process.version,execArgv:process.execArgv,cpu:cpus()[0].model,cores:cpus().length,loadBefore:loadavg()},workload:{batch,cohorts,urgency:'next',deadline:1,commandsPerStep:0},scope:'Real CoreStore and DaemonCore with FakeDriver and a counting I1 callback. No real process or durable I1 callback write. Public API creates then deletes each Bee and all its mail. Private Set cardinalities are diagnostic observations, not a new production API. Post-GC heapUsed is process retained JavaScript heap, not private/RSS memory or exact Set bytes. DB audit history remains durable. No timing-speedup claim.',before:sample(),samples:[]};
const save=()=>writeFileSync(outArg,JSON.stringify(report,null,2)+'\n');save();
try{
 for(let c=0;c<cohorts;c++){
  const id=`retention-${c}`;store.transact(()=>{store.createBee({id,name:id,agent:'stub',substrate:'hsr',cwd:dir});store.updateRuntimeState(id,1,'stopped',{exitCause:'clean'});for(let i=0;i<batch;i++)store.send(id,'body',{urgency:'next'});});
  now+=batch+100;const previous=violations;core.step();assert.equal(violations-previous,batch);core.step();assert.equal(violations-previous,batch,'live pending reports remain deduplicated');const pending=counts();
  store.deleteBee(id);assert.equal(store.getBee(id),null);assert.equal(store.listUndeliveredMessages().length,0);core.step();
  const after=sample();report.samples.push({cohort:c+1,totalViolations:violations,pending,after});save();
 }
 assert.deepEqual(driver.starts,[]);assert.deepEqual(driver.deliveredIds,[]);assert.equal(violations,batch*cohorts);assert.deepEqual(fingerprint(),source);assert.equal(boot(),bootUUID);assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);report.completed=true;
}catch(e){report.failure=String(e?.stack??e);throw e;}finally{report.finishedAt=new Date().toISOString();report.environment.loadAfter=loadavg();save();store.close();rmSync(dir,{recursive:true,force:true});}
console.log(outArg,report.before.counts,report.samples.at(-1).after.counts,report.before.memory.heapUsed,report.samples.at(-1).after.memory.heapUsed);

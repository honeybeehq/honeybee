import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir,cpus,loadavg} from 'node:os';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
const [rootArg,outArg]=process.argv.slice(2);assert(rootArg&&outArg);const root=resolve(rootArg),out=resolve(outArg);
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
assert.equal(git('status','--porcelain'),'');const revision=git('rev-parse','HEAD'),toolHash=hash(readFileSync(new URL(import.meta.url)));
const {openCoreStore}=await import(pathToFileURL(join(root,'v2/core/src/index.ts')));
const dir=mkdtempSync(join(tmpdir(),'hb-title-aggregate-cost-')),path=join(dir,'core.sqlite');let store,db;
const sql='SELECT SUM(count) AS count, MAX(maxId) AS maxId FROM (SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL UNION ALL SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL)';
const report={completed:false,revision,toolHash,node:process.version,cpu:cpus()[0].model,loadBefore:loadavg(),scope:'Planning diagnostic only, not production A/B. Same-process cached raw aggregate versus public listMessages on a public-created Bee with offline-seeded valid mailbox rows. Fixtures have no matching synthetic enqueue audit rows. Separate query operations/statement implementations; does not measure complete autoTitle scan, retained RAM or future candidate speedup.',results:[]};
try {
 store=openCoreStore(path,{now:()=>1000});const {bee}=store.createBee({name:'aggregate cost',handle:'AC.proof',agent:'stub',substrate:'hsr',cwd:dir});store.close();store=undefined;
 for(const n of [0,20,1000,100000]) {
  db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON;BEGIN');db.exec('DELETE FROM mailbox');const insert=db.prepare("INSERT INTO mailbox(bee_id,sender,body,enqueued_at,urgency,delivered_at,delivered_generation) VALUES(?,'operator',?,1000,'idle',?,?)");for(let i=0;i<n;i++)insert.run(bee.id,'x'.repeat(64),i%3===0?null:1000,i%3===0?null:1);db.exec('COMMIT');
  const query=db.prepare(sql),initial=query.get(bee.id,bee.id);assert.equal(initial.count,n);const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(bee.id,bee.id),opcodes=db.prepare('EXPLAIN '+sql).all(bee.id,bee.id);db.close();db=undefined;
  store=openCoreStore(path,{now:()=>1000});const read=()=>store.listMessages(bee.id);assert.equal(read().length,n);
  // Use the same authority connection for both operations; no competing connections.
  const raw=Reflect.get(store,'db');assert(raw instanceof DatabaseSync);const aggregate=raw.prepare(sql);const probe=()=>aggregate.get(bee.id,bee.id);assert.deepEqual(probe(),initial);
  const calls=n>=100000?1:n>=1000?10:1000,rounds=6,batches=[[],[]];
  const ops=[()=>{let total=0;for(let i=0;i<calls;i++)total+=read().length;return total;},()=>{let total=0;for(let i=0;i<calls;i++)total+=probe().count;return total;}];
  for(let i=0;i<3;i++)for(const side of [0,1,1,0])assert.equal(ops[side](),n*calls);
  for(let i=0;i<rounds;i++)for(const side of [0,1,1,0]){const c=process.cpuUsage(),t=performance.now();const rows=ops[side](),wallMs=performance.now()-t,u=process.cpuUsage(c);assert.equal(rows,n*calls);batches[side].push({cpuMs:(u.user+u.system)/1000,wallMs});}
  assert.deepEqual(probe(),initial);assert.equal(read().length,n);store.close();store=undefined;
  const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];report.results.push({n,calls,plan,opcodes,raw:batches,cpuMsPerCall:batches.map(xs=>median(xs.map(x=>x.cpuMs/calls))),wallMsPerCall:batches.map(xs=>median(xs.map(x=>x.wallMs/calls)))});
 }
 assert.equal(git('rev-parse','HEAD'),revision);assert.equal(git('status','--porcelain'),'');assert.equal(hash(readFileSync(new URL(import.meta.url))),toolHash);report.completed=true;
}finally{db?.close();store?.close();rmSync(dir,{recursive:true,force:true});report.loadAfter=loadavg();writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report.results.map(({n,cpuMsPerCall,wallMsPerCall})=>({n,cpuMsPerCall,wallMsPerCall}))));

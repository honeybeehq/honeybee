import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openCoreStore} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/core/src/index.ts';
const dir=mkdtempSync(join(tmpdir(),'hb-title-aggregate-plan-')),path=join(dir,'core.sqlite');
let store,db;
try {
 store=openCoreStore(path,{now:()=>1000});
 const {bee}=store.createBee({name:'aggregate plan',handle:'AP.proof',agent:'stub',substrate:'hsr',cwd:dir});
 store.updateRuntimeState(bee.id,1,'running');
 store.transact(()=>{for(let i=0;i<20;i++){const {message}=store.send(bee.id,'body'+i,{urgency:'idle'});if(i%3!==0)store.markDelivered(message.id,1);}});
 const rows=store.listMessages(bee.id);store.close();store=undefined;db=new DatabaseSync(path,{readOnly:true});
 const queries={pending:'SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL',delivered:'SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL',combined:'SELECT SUM(count) AS count, MAX(maxId) AS maxId FROM (SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL UNION ALL SELECT COUNT(*) AS count, MAX(id) AS maxId FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL)'};
 const results=Object.fromEntries(Object.entries(queries).map(([name,sql])=>{const args=name==='combined'?[bee.id,bee.id]:[bee.id];return [name,{sql,rows:db.prepare(sql).all(...args),plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args),opcodes:db.prepare('EXPLAIN '+sql).all(...args)}];}));
 assert.equal(results.combined.rows[0].count,rows.length);assert.equal(results.combined.rows[0].maxId,rows.at(-1).id);
 const report={completed:true,node:process.version,sqlite:db.prepare('SELECT sqlite_version() AS version').get(),scope:'Structural scratch on actual schema, 20 public-API rows, no performance timing claims.',results};
 writeFileSync('/tmp/honeybee-autotitle-architecture/aggregate-plan-study.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([n,r])=>[n,{plan:r.plan,columns:r.opcodes.filter(x=>x.opcode==='Column'||x.opcode==='IdxRowid'||x.opcode==='DeferredSeek')}]))));
}finally{db?.close();store?.close();rmSync(dir,{recursive:true,force:true});}

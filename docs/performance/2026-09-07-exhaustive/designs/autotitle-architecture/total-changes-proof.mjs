import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCoreStore} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/core/src/index.ts';
const dir=mkdtempSync(join(tmpdir(),'hb-title-total-changes-')),path=join(dir,'core.sqlite');let s=openCoreStore(path,{now:()=>1000});
try {
 const observations=[];const read=(label)=>{const db=Reflect.get(s,'db');assert(db instanceof DatabaseSync);const n=db.prepare('SELECT total_changes() AS n').get().n;assert.equal(typeof n,'number');observations.push({label,n,inTransaction:s.inTransaction});return n;};
 const {bee}=s.createBee({name:'change proof',handle:'TC.proof',agent:'stub',substrate:'hsr',cwd:dir});s.updateRuntimeState(bee.id,1,'running');const initial=read('initial');const message=s.send(bee.id,'hi',{urgency:'idle'}).message;const sent=read('send');assert(sent>initial);
 const rollback=new Error('rollback');assert.throws(()=>s.transact(()=>{s.transact(()=>s.send(bee.id,'speculative',{urgency:'idle'}));assert(read('nested-write')>sent);throw rollback;}),e=>e===rollback);const rolled=read('after-rollback');assert(rolled>sent);assert.equal(s.listMessages(bee.id).length,1);
 assert.throws(()=>s.markDelivered(-1,1),/message not found/);assert.equal(read('missing-mark-throws'),rolled);
 s.markDelivered(message.id,1);const delivered=read('delivery');assert(delivered>rolled);
 assert.equal(s.markDelivered(message.id,1).applied,false);assert(read('duplicate-delivery-audited-no-op')>delivered);
 s.deleteBee(bee.id);const deleted=read('delete-cascade');assert(deleted>delivered);
 s.close();s=openCoreStore(path,{now:()=>1000});read('reopened-new-instance');
 writeFileSync('/tmp/honeybee-autotitle-architecture/total-changes-proof.json',JSON.stringify({completed:true,node:process.version,scope:'Actual node:sqlite authority connection; changes include rollback work and unrelated writes. Tokens would need separate store identity on reopen. No performance or cache implementation claim.',observations},null,2)+'\n');console.log(JSON.stringify(observations));
}finally{s.close();rmSync(dir,{recursive:true,force:true});}

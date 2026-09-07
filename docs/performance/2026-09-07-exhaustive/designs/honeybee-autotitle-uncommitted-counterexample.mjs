import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCoreStore} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/core/src/index.ts';
const dir=mkdtempSync(join(tmpdir(),'hb-title-cache-proof-')),store=openCoreStore(join(dir,'core.sqlite'),{now:()=>1000});
try{
 const {bee}=store.createBee({name:'cache proof',handle:'TP.proof',agent:'stub',substrate:'hsr',cwd:dir});store.updateRuntimeState(bee.id,1,'running');
 const project=()=>{const rows=store.listMessages(bee.id);return{pair:{maxId:rows.at(-1)?.id??0,count:rows.length},bodies:rows.map(x=>x.body),inTransaction:store.inTransaction};};
 const rollback=new Error('intentional rollback');let speculative;
 assert.throws(()=>store.transact(()=>{store.send(bee.id,'speculative body A',{urgency:'idle'});speculative=project();throw rollback;}),e=>e===rollback);
 assert.deepEqual(store.listMessages(bee.id),[]);store.send(bee.id,'committed body B',{urgency:'idle'});const committed=project();assert.deepEqual(speculative.pair,committed.pair);assert.notDeepEqual(speculative.bodies,committed.bodies);assert.equal(speculative.inTransaction,true);assert.equal(committed.inTransaction,false);
 const report={completed:true,scope:'Real CoreStore; cache is hypothetical. Equal max/count across rollback does not prove body identity if the earlier read was uncommitted.',speculative,committed};writeFileSync('/tmp/honeybee-autotitle-uncommitted-counterexample.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}

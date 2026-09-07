import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCoreStore} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/core/src/index.ts';
const dir=mkdtempSync(join(tmpdir(),'hb-title-caught-write-'));let remaining=-1;const clockError=new Error('controlled clock failure after INSERT');
const s=openCoreStore(join(dir,'core.sqlite'),{now:()=>{if(remaining===0)throw clockError;if(remaining>0)remaining--;return 1000;}});
try {
 const {bee}=s.createBee({name:'caught write',handle:'CW.proof',agent:'stub',substrate:'hsr',cwd:dir});s.updateRuntimeState(bee.id,1,'running');const before=s.auditRows().length;
 let caught=false;s.transact(()=>{remaining=1;try{s.send(bee.id,'inserted before nested audit throws',{urgency:'idle'});}catch(e){assert.equal(e,clockError);caught=true;}finally{remaining=-1;}assert.equal(s.inTransaction,true);assert.equal(s.listMessages(bee.id).length,1);});
 assert(caught);assert.equal(s.inTransaction,false);const rows=s.listMessages(bee.id);assert.equal(rows.length,1);assert.equal(s.auditRows().length,before);
 const report={completed:true,scope:'Actual public nested transaction contract: caught inner error does not roll back its earlier SQL; outer transaction can commit it. A new version tracker must stage at SQL mutation, not successful method return. This is design evidence, not a proposed change to transaction semantics.',caught,committedBodies:rows.map(x=>x.body),auditRowsBefore:before,auditRowsAfter:s.auditRows().length};
 writeFileSync('/tmp/honeybee-autotitle-architecture/nested-caught-write-proof.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{s.close();rmSync(dir,{recursive:true,force:true});}

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {openCoreStore} from '../../v2/core/src/index.ts';
import {makeDaemonDir,startDaemon,waitFor} from '../../v2/daemon/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'),'set an owned TMPDIR');
const fixture=makeDaemonDir();
const store=openCoreStore(join(fixture.dir,'core.sqlite3'));
store.createBee({id:'held-bee',name:'owned-held-fixture',agent:'stub',substrate:'hsr',cwd:fixture.dir});
store.updateRuntimeState('held-bee',1,'running');
const messages=[];
for(const action of ['resend_anyway','drop']){
 const message=store.send('held-bee','Owned lost-ACK fixture for '+action).message;messages.push(message.id);
 const wireLine=JSON.stringify({id:message.id,method:'owned-fixture'});
 store.prepareDeliveryConfirmationIntent({beeId:'held-bee',messageId:message.id,generation:1,wireLine,digest:createHash('sha256').update(wireLine).digest('hex'),host:{pid:123,birth:'linux:123',bootId:'00000000-0000-0000-0000-000000000000'}});
 store.holdDeliveryConfirmation(message.id,'unknown');
}
store.updateRuntimeState('held-bee',1,'stopped',{exitCause:'crashed'});store.close();
const daemon=await startDaemon(fixture.dir);const client=await daemon.client();
let primaryError;
try{
 const view=await waitFor(async()=>{const row=await client.request('view',{beeId:'held-bee'});return row.view.generation===2&&row.runtime?.state==='idle'&&row;},'owned successor idle',15000);
 const params={beeId:'held-bee',messageId:messages[0],generation:view.view.generation,idempotencyKey:'owned-resend'};
 console.log(JSON.stringify({case:'held-fixture',socketPath:daemon.socketPath,dataDir:fixture.dir,beeId:'held-bee',generation:params.generation,messageIds:messages,pid:daemon.proc.pid}));
 assert(view.view.deliveryConfirmations.every(row=>row.state==='held'&&row.delivered===false));
 const mailbox=await client.request('mailbox',{beeId:'held-bee'});assert(mailbox.messages.every(row=>row.deliveryConfirmation?.state==='held'));
 const audits=await client.request('audit.tail',{beeId:'held-bee',limit:100});
 for(const row of audits.rows.filter(row=>row.kind.startsWith('mail.confirmation_'))){assert.equal(JSON.stringify(row.payload).includes('wireLine'),false);assert.equal(JSON.stringify(row.payload).includes('bootId'),false);}
 if(process.argv.includes('--serve')){
  await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }else{
  await assert.rejects(client.request('mail.delivery.resend_anyway',{...params,generation:1}),{code:'stale_generation'});
  await assert.rejects(client.request('mail.delivery.drop',{...params,extra:true}),{code:'invalid_request'});
  const result=await client.request('mail.delivery.resend_anyway',params);assert(result.replacementMessageId>messages[1]);
  assert.deepEqual(await client.request('mail.delivery.resend_anyway',params),{...result,deduped:true});
  await assert.rejects(client.request('mail.delivery.drop',params),{code:'idempotency_conflict'});
  await assert.rejects(client.request('mail.delivery.drop',{...params,idempotencyKey:'not-held'}),{code:'delivery_not_held'});
  const drop=await client.request('mail.delivery.drop',{...params,messageId:messages[1],idempotencyKey:'owned-drop'});assert.equal(drop.replacementMessageId,null);
  const delivered=await waitFor(async()=>{const row=await client.request('mailbox',{beeId:'held-bee'});return row.messages.find(message=>message.id===result.replacementMessageId&&message.deliveredAt!==null);},'replacement delivery');
  assert.equal(delivered.body,'Owned lost-ACK fixture for resend_anyway');
  console.log(JSON.stringify({case:'operator-resolution-rpcs',replacementMessageId:result.replacementMessageId,drop:true,idempotent:true,staleGenerationRefused:true,notHeldRefused:true,conflictingKeyRefused:true,auditPrivateFieldsRemoved:true}));
 }
}catch(error){primaryError=error;console.error(error);throw error;}
finally{client.close();try{await daemon.stop();}catch(error){console.error('owned daemon cleanup:',error.message);if(!primaryError)throw error;}}

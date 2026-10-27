import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {CoreStore} from '../../core/src/index.ts';
import {backupFactId,verifyBackupCapacity,verifyBackupRestoreDrill,type BackupRestoreDrill,type BackupCapacityAttestation} from '../../core/src/backupClientFacts.ts';
import {repoKey,BackupFacts} from './backupServiceSupport.ts';
import {validateBackupServiceConfig} from './backupServiceConfig.ts';
export function backupClientStatus(store:CoreStore,dataDir:string,after:string,now=Date.now()){
 let capacity:unknown=null;try{
  const config=validateBackupServiceConfig(JSON.parse(readFileSync(join(dataDir,'backup-service.json'),'utf8')));
  if(config.role==='machine'){
   const row=store.backupState('machine:capacity:'+repoKey(config.repository),'capacity','machine');
   if(row?.kind==='capacity'){const attestation=verifyBackupCapacity(row.value as BackupCapacityAttestation,config.grantPublicKey,config.machine,config.repository),ageMs=now-attestation.payload.observation.observedAt;capacity={attestation,ageMs,clockSkewAllowanceMs:30000,stale:ageMs< -30000||store.backupState('machine:capacity-health:'+repoKey(config.repository),'capacityHealth','machine')?.value.valid!==true||ageMs>config.observationMaxAgeMs||attestation.payload.observation.band==='unknown'};}
  }
 }catch{/* Missing configuration/trust is unknown, never a fabricated healthy observation. */}
 const restoreDrills:BackupRestoreDrill[]=[];try{const trust=JSON.parse(readFileSync(join(dataDir,'backup-trust.json'),'utf8'));for(const drill of store.latestBackupRestoreDrills()){try{restoreDrills.push(verifyBackupRestoreDrill(drill,trust.publicKeys[drill.payload.verifier.keyId]));}catch{}}}catch{}
 restoreDrills.sort((a,b)=>Date.parse(b.payload.checkedAt)-Date.parse(a.payload.checkedAt)||a.payload.id.localeCompare(b.payload.id));
 return{states:store.listBackupStates('',after,250),capacity,restoreDrills};
}
export function acceptRestoreDrill(store:CoreStore,dataDir:string,input:unknown,now=Date.now()){
 const value=input as BackupRestoreDrill,trust=JSON.parse(readFileSync(join(dataDir,'backup-trust.json'),'utf8')),drill=verifyBackupRestoreDrill(value,trust.publicKeys[value.payload.verifier.keyId]),p=drill.payload;
 if(Date.parse(p.checkedAt)>now+30000)throw Error('drill_invalid');
 const op=store.getCellOp(p.generation);if(op?.kind!=='backup')throw Error('drill_invalid');const record=JSON.parse(op.stdout);
 if(p.result==='passed'&&(p.checks.files!==record.receipt?.payload.files||p.checks.bytes!==record.receipt?.payload.bytes))throw Error('drill_invalid');
 if(record.cellId!==p.cellId||record.machine!==p.machine||record.snapshotId!==p.snapshotId||record.manifestHash!==p.manifestHash||record.receipt?.payload.repositoryId!==p.repositoryId||backupFactId(record.receipt)!==p.receiptHash)throw Error('drill_invalid');
 const facts=new BackupFacts({store,dataDir,tools:{git:'',hem:'',restic:''},now:()=>now},'machine'),id='machine:drill:'+backupFactId({verifier:p.verifier,id:p.id}),prior=facts.get(id,'drill');
 if(prior&&backupFactId(prior)!==backupFactId(drill))throw Error('idempotency_conflict');facts.put(id,'drill',drill);return{status:'recorded' as const,drill};
}

/** Explicit local operator acknowledgement after authority state loss; never automatic. */
export function acceptCapacityEpoch(store:CoreStore,dataDir:string,epoch:unknown,now=Date.now()){
 const config=validateBackupServiceConfig(JSON.parse(readFileSync(join(dataDir,'backup-service.json'),'utf8')));if(config.role!=='machine'||typeof epoch!=='string')throw Error('invalid_request');
 const facts=new BackupFacts({store,dataDir,tools:{git:'',hem:'',restic:''},now:Date.now},'machine'),pending=facts.get('machine:capacity-pending:'+repoKey(config.repository),'capacity');if(!pending||pending.payload.epoch!==epoch)throw Error('invalid_request');verifyBackupCapacity(pending,config.grantPublicKey,config.machine,config.repository);if(now-pending.payload.observation.observedAt>config.observationMaxAgeMs||pending.payload.observation.observedAt>now+30000)throw Error('capacity_unknown');facts.put('machine:capacity-epoch:'+repoKey(config.repository),'capacityEpoch',{epoch});return{status:'accepted',epoch};
}

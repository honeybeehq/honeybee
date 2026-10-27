import {inspectProcess} from '../../harness/src/processIdentity.ts';
/** A restore never writes a Cell path: only fresh private owner staging. */
import {readFile,mkdir,realpath,readdir,statfs,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {backupFactId} from '../../core/src/backupClientFacts.ts';
import {verifyBackupReceipt,canonicalBackupJson} from '../../core/src/backupReceipt.ts';
import type {BackupRestoreOperation} from '../../core/src/backupService.ts';
import {BackupFacts,type BackupServiceOwner} from './backupServiceSupport.ts';
import {BackupVerificationError,discoverRecoveryCatalogue,readBackCapture,materializeVerifiedCapture,disposeVerifiedCapture,type BackupRepositoryAccess} from './backupVerification.ts';
export interface RestoreServiceOwner extends BackupServiceOwner {busy:(cellId:string)=>boolean;freeBytes?:()=>Promise<number>}
export class BackupRestoreService {
 private disposal:Promise<{status:string;reason?:string}>|null=null;
 private active=new Map<string,Promise<BackupRestoreOperation|{status:'refused';reason:string}>>();
 readonly owner:RestoreServiceOwner;
 constructor(owner:RestoreServiceOwner){this.owner=owner;}
 restore(params:Record<string,unknown>){
  if(typeof params.cellId!=='string'||!params.cellId||typeof params.generation!=='string'||!params.generation||typeof params.idempotencyKey!=='string'||!params.idempotencyKey||params.idempotencyKey.length>512)return Promise.resolve({status:'refused' as const,reason:'invalid_request'});
  const request={cellId:params.cellId,generation:params.generation},requestHash=backupFactId(request),id='machine:restore:'+backupFactId(params.idempotencyKey),facts=new BackupFacts(this.owner,'machine'),old=facts.get(id,'restore');
  if(old){if(old.requestHash!==requestHash)return Promise.resolve({status:'refused' as const,reason:'idempotency_conflict'});if(this.active.has(id))return this.active.get(id)!;if(old.status==='disposed')return Promise.resolve({status:'refused' as const,reason:'stage_disposed'});if(old.status==='running'){const unknown={...old,status:'outcome_unknown' as const,reason:'interrupted'};facts.put(id,'restore',unknown);return Promise.resolve(unknown);}return Promise.resolve(old);}
  if(this.owner.busy(request.cellId)||this.active.size||this.disposal)return Promise.resolve({status:'refused' as const,reason:'busy'});
  const op:BackupRestoreOperation={id,requestHash,...request,status:'running',reason:null,path:null,startedAt:this.owner.now(),finishedAt:null,receiptHash:''};facts.put(id,'restore',op);
  const work=this.perform(op,facts).finally(()=>{this.active.delete(id);});this.active.set(id,work);return work;
 }
 markInterrupted(){const facts=new BackupFacts(this.owner,'machine');for(const op of this.owner.store.pendingBackupRestores())if(op.status==='running'&&!this.active.has(op.id))facts.put(op.id,'restore',{...op,status:'outcome_unknown',reason:'interrupted',cleanup:'held',finishedAt:this.owner.now()});}
 async reconcile(){
  const facts=new BackupFacts(this.owner,'machine');for(const old of this.owner.store.pendingBackupRestores())if(!this.active.has(old.id)&&(old.status==='running'||old.status==='outcome_unknown'&&old.cleanup==='held')){
    let held=false;if(old.guard){const live=inspectProcess(old.guard.pid);held=live.kind==='unavailable'||live.kind==='present'&&live.birth===old.guard.birth&&live.bootId===old.guard.bootId;}
    if(!held&&old.stageRoot){const data=await realpath(this.owner.dataDir);if(old.stageRoot===join(data,'backup-restores',old.id.split(':').at(-1)!))await rm(old.stageRoot,{recursive:true,force:true});else held=true;}
    facts.put(old.id,'restore',{...old,status:'outcome_unknown',reason:'interrupted',path:null,cleanup:held?'held':'removed',finishedAt:this.owner.now()});
  }
 }
 dispose(key:unknown):Promise<{status:string;reason?:string}>{
  if(this.disposal||this.active.size)return Promise.resolve({status:'refused',reason:'busy'});const work=this.disposeOnce(key).finally(()=>{this.disposal=null;});this.disposal=work;return work;
 }
 private async disposeOnce(key:unknown){
  await this.reconcile();
  if(typeof key!=='string'||!key)return{status:'refused',reason:'invalid_request'};const id='machine:restore:'+backupFactId(key),facts=new BackupFacts(this.owner,'machine'),op=facts.get(id,'restore');if(!op)return{status:'refused',reason:'not_found'};if(this.active.has(id)||op.cleanup==='held'||op.status==='running')return{status:'refused',reason:'busy'};
  const data=await realpath(this.owner.dataDir);if(op.stageRoot!==join(data,'backup-restores',id.split(':').at(-1)!))return{status:'refused',reason:'invalid_request'};
  await rm(op.stageRoot,{recursive:true,force:true});facts.put(id,'restore',{...op,status:'disposed',reason:'stage_disposed',path:null,cleanup:'removed'});return{status:'disposed'};
 }
 async settled(){await Promise.allSettled([...this.active.values(),...(this.disposal?[this.disposal]:[])]);}
 private async perform(op:BackupRestoreOperation,facts:BackupFacts):Promise<BackupRestoreOperation>{
  let stage:Awaited<ReturnType<typeof readBackCapture>>|undefined;
  const finish=(patch:Partial<BackupRestoreOperation>)=>{const result={...op,...patch,finishedAt:this.owner.now()};facts.put(op.id,'restore',result);return result;};
  try{
   // Configured recovery authority only: uploaders never acquire signing/delete credentials.
   const config=JSON.parse(await readFile(join(this.owner.dataDir,'backup-restore.json'),'utf8')) as {access:BackupRepositoryAccess;repositoryId:string;maxRestoreBytes:number};
   if(!config.access||!config.access.credentialRef?.endsWith('-reader')||!/^[a-f0-9]{64}$/.test(config.repositoryId)||!Number.isSafeInteger(config.maxRestoreBytes)||config.maxRestoreBytes<1||config.maxRestoreBytes>100*1024**3)throw new BackupVerificationError('invalid_request');
   const source=this.owner.store.getCellOp(op.generation);if(source?.kind!=='backup'||source.cellId!==op.cellId)throw new BackupVerificationError('receipt_invalid');
   const record=JSON.parse(source.stdout),trust=JSON.parse(await readFile(join(this.owner.dataDir,'backup-trust.json'),'utf8')),receipt=verifyBackupReceipt(record.receipt,trust.publicKeys[record.receipt?.payload?.verifier?.keyId]);
   if(record.verification!=='verified'||record.repository!==config.access.repository||record.machine!==config.access.machine||receipt.payload.cellId!==op.cellId||receipt.payload.generation!==op.generation||receipt.payload.repositoryId!==config.repositoryId||receipt.payload.snapshotId!==record.snapshotId||receipt.payload.manifestHash!==record.manifestHash)throw new BackupVerificationError('receipt_invalid');
   const dataDir=await realpath(this.owner.dataDir),root=join(dataDir,'backup-restores');await mkdir(root,{recursive:true,mode:0o700});const rootInfo=await lstat(root);if(await realpath(root)!==root||!rootInfo.isDirectory()||(rootInfo.mode&0o777)!==0o700||typeof process.getuid==='function'&&rootInfo.uid!==process.getuid())throw new BackupVerificationError('invalid_request');
   if((await readdir(root)).length>=4)return finish({status:'refused',reason:'stage_limit'});
   const freeBytes=this.owner.freeBytes?await this.owner.freeBytes():await statfs(dataDir).then(disk=>disk.bavail*disk.bsize);if(freeBytes<4*config.maxRestoreBytes+768*1024*1024)return finish({status:'refused',reason:'disk_insufficient'});
   const stageRoot=join(root,op.id.split(':').at(-1)!);await mkdir(stageRoot,{mode:0o700});op={...op,stageRoot};facts.put(op.id,'restore',op);
   const owner={tools:this.owner.tools,stageRoot,maxRestoreBytes:config.maxRestoreBytes,trustedPublicKey:trust.publicKeys[receipt.payload.verifier.keyId],signal:this.owner.signal,resolveSecret:this.owner.resolveSecret,child:(pid:number|null)=>{const live=pid===null?null:inspectProcess(pid);if(pid!==null&&live?.kind!=='present')throw new BackupVerificationError('owner_unavailable');const guard=live?.kind==='present'?{pid:live.pid,birth:live.birth,bootId:live.bootId}:null;op={...op,guard};facts.put(op.id,'restore',op);}};
   const catalogue=await discoverRecoveryCatalogue(op.generation,config.access,owner);
   if(canonicalBackupJson(catalogue.receipt.payload)!==canonicalBackupJson(receipt.payload))throw new BackupVerificationError('receipt_invalid');
   stage=await readBackCapture(catalogue.record,config.access,owner,catalogue.receipt.payload.transcripts);const path=await materializeVerifiedCapture(stage,owner);
   if(this.owner.signal?.aborted)throw new BackupVerificationError('interrupted');
   if(this.owner.busy(op.cellId)){await disposeVerifiedCapture(stage);await rm(stageRoot,{recursive:true,force:true});return finish({status:'refused',reason:'busy',cleanup:'removed'});}
   return finish({status:'restored',path,receiptHash:backupFactId(receipt)});
  }catch(error){if(stage)await disposeVerifiedCapture(stage).catch(()=>undefined);if(op.stageRoot&&!op.guard)await rm(op.stageRoot,{recursive:true,force:true}).catch(()=>undefined);return finish({status:'failed',reason:this.owner.signal?.aborted?'interrupted':error instanceof BackupVerificationError?error.code:'restore_failed'});}
 }
}

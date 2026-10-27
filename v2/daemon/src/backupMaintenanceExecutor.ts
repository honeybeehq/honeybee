/** Separate decrypting executor. It never accepts uploader/writer credentials or client retention dates. */
import type {BackupExecutorConfig} from './backupServiceConfig.ts';
import {backupToolEnv,runBackupTool} from './backupCapture.ts';
import {BackupFacts,BackupServiceError,callBackupEndpoint,insist,serviceHash,serviceSecret,verifyOperationalGrant,type BackupOperationalGrant,type BackupServiceOwner} from './backupServiceSupport.ts';
export class BackupMaintenanceExecutor {
 readonly config:BackupExecutorConfig;readonly owner:BackupServiceOwner;readonly facts:BackupFacts;private running:Promise<unknown>|null=null;
 constructor(config:BackupExecutorConfig,owner:BackupServiceOwner){this.config=config;this.owner=owner;this.facts=new BackupFacts(owner,'executor');}
 run():Promise<unknown>{if(this.running)return this.running;const p=this.runOnce();this.running=p;void p.finally(()=>{this.running=null;}).catch(()=>undefined);return p;}
 private async runOnce():Promise<unknown>{
  const response=await callBackupEndpoint<{grant:BackupOperationalGrant;observation:{repositoryBytes:number};username:string;password:string}>(this.owner,this.config.authorityUrl,this.config.authorityRef,'/v1/maintenance/claim',{}),p=verifyOperationalGrant(response.grant,this.config.grantPublicKey,this.owner.now());
  const repository=this.config.repositories.find(r=>r.repository===p.repository);insist(repository&&p.role==='maintenance'&&p.machine===this.config.machine&&p.repositoryId===repository.repositoryId&&p.endpoint?.startsWith('rest:')&&['check','prune'].includes(p.kind),'grant_invalid');
  insist(/^global\/fleet-backup-[A-Za-z0-9._-]+-repo-key$/.test(repository.passwordRef)&&/^global\/fleet-backup-[A-Za-z0-9._-]+-reader$/.test(repository.readerRef),'scope_refused');
  insist(p.protectedSetHash===serviceHash(p.protectedIds)&&p.forgetIds.every(id=>/^[a-f0-9]{64}$/.test(id)&&!p.protectedIds.includes(id))&&p.maxDurationMs>0&&p.maxDurationMs<=3600000&&p.maxRepackBytes>0&&p.maxRepackBytes<=10*1024**3,'grant_invalid');
  const id='executor:maintenance:'+p.jobId,previous=this.facts.get(id,'maintenance');this.facts.put(id,'maintenance',{id:p.jobId,repository:p.repository,kind:p.kind as 'check'|'prune',bucket:'grant',state:'running',startedAt:previous?.startedAt??this.owner.now(),finishedAt:null,grantCounter:p.counter,planHash:p.planHash,protectedSetHash:p.protectedSetHash,forgottenIds:previous?.forgottenIds??[],checkResult:null,reason:null});
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),p.maxDurationMs),signal=this.owner.signal?AbortSignal.any([this.owner.signal,abort.signal]):abort.signal,lease={id:p.id,counter:p.counter,jobId:p.jobId};let heartbeatWork:Promise<unknown>=Promise.resolve();
  const heartbeat=setInterval(()=>{heartbeatWork=callBackupEndpoint(this.owner,this.config.authorityUrl,this.config.authorityRef,'/v1/heartbeat',lease).catch(()=>{abort.abort();});},Math.max(100,Math.min(10000,Math.floor((p.expiresAt-p.issuedAt)/3))));
  let ok=false,checkOk=false;const forgotten:string[]=[];
  try{
   const password=await serviceSecret({...this.owner,signal},repository.passwordRef,'password');
   const env={...backupToolEnv(),RESTIC_PASSWORD:password,RESTIC_REST_USERNAME:response.username,RESTIC_REST_PASSWORD:response.password};
   const run=async(args:string[])=>{this.owner.trace?.('restic.start '+args[0]);const output=await runBackupTool(this.owner.tools.restic,['--repo',p.endpoint!,'--no-cache',...args],{tools:this.owner.tools,signal,child:()=>undefined},{env,limit:64*1024*1024});this.owner.trace?.('restic.done '+args[0]);return output;};
   const config=JSON.parse(await run(['cat','config']));insist(config.id===repository.repositoryId,'scope_refused');
   const snapshots=async()=>new Set((JSON.parse(await run(['snapshots','--json'])) as {id:string}[]).map(s=>s.id));
   const before=await snapshots();for(const protectedId of p.protectedIds)insist(before.has(protectedId),'protected_missing');
   await run(['check']);
   if(p.kind==='prune'){
    // Explicit server-selected IDs only. Record each completed deletion before advancing.
    for(const snapshotId of p.forgetIds){if(before.has(snapshotId)){await run(['forget',snapshotId]);forgotten.push(snapshotId);const current=this.facts.get(id,'maintenance')!;this.facts.put(id,'maintenance',{...current,forgottenIds:[...new Set([...current.forgottenIds,...forgotten])]});}}
    const after=await snapshots();for(const protectedId of p.protectedIds)insist(after.has(protectedId),'protected_missing');
    await run(['prune','--max-repack-size',String(p.maxRepackBytes)]);
   }
   // Read a bounded deterministic shard. Full protected-object readback remains the B3 verifier's job.
   const subset=Math.max(1,Math.ceil(2*response.observation.repositoryBytes/Math.max(1,p.maxReadBytes)));const shard=p.counter%subset+1;
   await run(['check','--read-data-subset',String(shard)+'/'+String(subset)]);checkOk=true;
   const after=await snapshots();for(const protectedId of p.protectedIds)insist(after.has(protectedId),'protected_missing');ok=true;
  }catch(error){this.owner.trace?.('executor.failed '+(error instanceof BackupServiceError?error.reason:signal.aborted?'interrupted':'tool_failed'));const current=this.facts.get(id,'maintenance')!;this.facts.put(id,'maintenance',{...current,state:'unknown',reason:signal.aborted?'interrupted':error instanceof BackupServiceError?error.reason:'job_failed'});}
  finally{clearTimeout(timeout);clearInterval(heartbeat);await heartbeatWork;
   // The authority stops its guarded delete endpoint before it releases the fleet lane.
   await callBackupEndpoint(this.owner,this.config.authorityUrl,this.config.authorityRef,'/v1/maintenance/finish',{...lease,ok,checkOk,forgottenIds:forgotten});
   const current=this.facts.get(id,'maintenance')!;this.facts.put(id,'maintenance',{...current,state:ok?'succeeded':'failed',finishedAt:this.owner.now(),checkResult:checkOk?'ok':null});
  }
  return{status:ok?'succeeded':'failed',kind:p.kind,jobId:p.jobId,forgotten:forgotten.length};
 }
}

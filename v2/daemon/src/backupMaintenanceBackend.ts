import {queueBackupAlert} from "./backupAlerts.ts";
import {writerFence} from "./backupWriterFence.ts";
/** Job-scoped non-append-only rest-server, reachable only through the authority proxy. */
import { createHash,createHmac } from 'node:crypto';
import { mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProcess,sameProcess } from '../../harness/src/processIdentity.ts';
import type { BackupMaintenanceRun } from '../../core/src/backupService.ts';
import { runBackupTool } from './backupCapture.ts';
import type { BackupAuthorityConfig } from './backupServiceConfig.ts';
import { BackupFacts,insist,repoKey as importRepoKey,serviceSecret,type BackupServiceOwner } from './backupServiceSupport.ts';
export class BackupMaintenanceBackend {
 readonly reconcile:()=>Promise<void>;readonly config:BackupAuthorityConfig;readonly owner:BackupServiceOwner;readonly facts:BackupFacts;
 private active:{jobId:string;leaseId:string;counter:number;authorization:string;identity:{pid:number;birth:string;bootId:string}|null;ready:boolean;abort:AbortController;settled:Promise<void>;file:string;exited:boolean}|null=null;
 constructor(config:BackupAuthorityConfig,owner:BackupServiceOwner,reconcile:()=>Promise<void>=async()=>{}){this.reconcile=reconcile;this.config=config;this.owner=owner;this.facts=new BackupFacts(owner,'authority');}
 async password(id:string,counter:number):Promise<string>{const secret=await serviceSecret(this.owner,this.config.maintenance.accessKeyRef,'secret');insist(secret.length>=32,'secret_unavailable');return createHmac('sha256',secret).update('backend:'+id+':'+counter).digest('base64url');}
 async ensure(run:BackupMaintenanceRun,leaseId:string,counter:number):Promise<void>{
  if(this.active){insist(this.active.jobId===run.id&&!this.active.exited&&this.active.ready&&this.active.identity&&sameProcess(this.active.identity,inspectProcess(this.active.identity.pid)),'busy');return;}
  if(run.processIdentity){const seen=inspectProcess(run.processIdentity.pid);insist(seen.kind==='gone'||seen.kind==='present'&&!sameProcess(run.processIdentity,seen),'busy');}
  const url=new URL(this.config.maintenance.backendUrl);insist(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/'&&url.port.length>0,'invalid_config');
  if(run.writerFence&&run.writerFence.phase!=='released')await this.stop(run.id);
  const profile=this.config.repositories.find(r=>r.repository===run.repository);insist(profile,'scope_refused');const machine=profile.writerFenceMachine??profile.machine;const key='authority:maintenance:'+run.id;const saveFence=(phase:'stopping'|'stopped'|'bound'|'restarting'|'released',backend:BackupMaintenanceRun['processIdentity'])=>{const current=this.facts.get(key,'maintenance')!;this.facts.put(key,'maintenance',{...current,writerFence:{machine,phase,backend:backend??null}});};
  const grant=run.grantPayload as {maxWriteBytes:number},observation=this.facts.get('authority:observation:'+importRepoKey(run.repository),'observation');insist(observation&&Number.isSafeInteger(grant.maxWriteBytes)&&grant.maxWriteBytes>0,'capacity_unknown');const maxSize=Math.min(profile.limitBytes+grant.maxWriteBytes,observation.repositoryBytes+grant.maxWriteBytes);insist(Number.isSafeInteger(maxSize)&&maxSize>0&&maxSize<=this.config.fleetLimitBytes+this.config.reserveLimitBytes,'capacity_stop');this.facts.put(key,'maintenance',{...this.facts.get(key,'maintenance')!,backendMaxSize:maxSize});
  const password=await this.password(leaseId,counter),username='authority',directory=join(this.config.reserveRoot,'maintenance-auth');await mkdir(directory,{recursive:true,mode:0o700});const file=join(directory,run.id+'.htpasswd');
  await writeFile(file,username+':{SHA}'+createHash('sha1').update(password).digest('base64')+'\n',{mode:0o600});
  try{
  saveFence('stopping',null);await writerFence(this.config.maintenance.writerFenceCommand,'stop',machine,run.id,null,this.owner);saveFence('stopped',null);
  const abort=new AbortController(),signal=this.owner.signal?AbortSignal.any([abort.signal,this.owner.signal]):abort.signal;
  const entry={jobId:run.id,leaseId,counter,authorization:'Basic '+Buffer.from(username+':'+password).toString('base64'),identity:null as {pid:number;birth:string;bootId:string}|null,ready:false,abort,settled:Promise.resolve(),file,exited:false};this.active=entry;
  entry.settled=runBackupTool(this.config.maintenance.backendCommand,['--listen',url.host,'--path',this.config.backupRoot,'--htpasswd-file',file,'--max-size',String(maxSize)],{tools:this.owner.tools,signal,child:pid=>{
   const current=this.facts.get('authority:maintenance:'+run.id,'maintenance');if(!current)return;const identity=pid==null?null:inspectProcess(pid);if(pid!=null){insist(identity?.kind==='present','outcome_unknown');entry.identity={pid:identity.pid,birth:identity.birth,bootId:identity.bootId};}this.facts.put('authority:maintenance:'+run.id,'maintenance',{...current,processIdentity:identity?.kind==='present'?{pid:identity.pid,birth:identity.birth,bootId:identity.bootId}:null});
  }},{detachedGuard:true,beforeStart:async pid=>{const seen=inspectProcess(pid);insist(seen.kind==='present','writer_fence_failed');const identity={pid:seen.pid,birth:seen.birth,bootId:seen.bootId};await writerFence(this.config.maintenance.writerFenceCommand,'status',machine,run.id,identity,this.owner);saveFence('bound',identity);}}).then(()=>undefined).catch(()=>undefined).finally(()=>{entry.exited=true;});
  for(let i=0;i<100;i++){insist(!entry.exited,'owner_unavailable');try{const response=await fetch(url,{headers:{authorization:'Basic '+Buffer.from(username+':'+password).toString('base64')},redirect:'error',signal:AbortSignal.timeout(250)});await response.body?.cancel();if(response.status!==401){await new Promise<void>(r=>setTimeout(r,25));insist(!entry.exited,'owner_unavailable');entry.ready=true;return;}}catch{}await new Promise<void>(r=>setTimeout(r,25));}throw Error('backend_unavailable');
  }catch(error){await this.stop(run.id);throw error;}
 }
 async authorization(leaseId:string,counter:number):Promise<string>{insist(this.active&&!this.active.exited&&this.active.ready&&this.active.identity&&sameProcess(this.active.identity,inspectProcess(this.active.identity.pid))&&this.active.leaseId===leaseId&&this.active.counter===counter,'grant_invalid');return this.active.authorization;}
 async quiet(run:BackupMaintenanceRun):Promise<boolean>{if(this.active?.jobId===run.id){await this.stop(run.id);return true;}if(!run.processIdentity){await this.stop(run.id);return true;}const observed=inspectProcess(run.processIdentity.pid);const absent=observed.kind==='gone'||observed.kind==='present'&&!sameProcess(run.processIdentity,observed);if(absent)await this.stop(run.id);return absent;}
 async stop(jobId?:string):Promise<void>{
  const active=this.active;if(active&&(!jobId||active.jobId===jobId)){active.abort.abort();let deadline:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([active.settled,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new (Error)('writer_fence_failed')),1000);})]);}catch{insist(active.identity&&inspectProcess(active.identity.pid).kind==='gone','writer_fence_failed');await this.releaseFence(active.jobId);let cleanupDeadline:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([active.settled,new Promise<never>((_,reject)=>{cleanupDeadline=setTimeout(()=>reject(new Error('writer_fence_failed')),1000);})]);}catch{this.owner.trace?.('writer.fence released late_pipe_close');}finally{if(cleanupDeadline)clearTimeout(cleanupDeadline);}}finally{if(deadline)clearTimeout(deadline);}await rm(active.file,{force:true});this.active=null;jobId=active.jobId;}
  if(!jobId)return;await this.releaseFence(jobId);
 }
 private async releaseFence(jobId:string):Promise<void>{const key='authority:maintenance:'+jobId,run=this.facts.get(key,'maintenance');if(!run?.writerFence||run.writerFence.phase==='released')return;
  let fence=run.writerFence;let proof=await writerFence(this.config.maintenance.writerFenceCommand,'status',fence.machine,jobId,null,this.owner);if(proof.fenced&&proof.writer==='running')proof=await writerFence(this.config.maintenance.writerFenceCommand,'stop',fence.machine,jobId,null,this.owner);fence={...fence,backend:proof.backend};if(!proof.fenced){this.facts.put(key,'maintenance',{...run,writerFence:{...fence,phase:'released'}});return;}this.facts.put(key,'maintenance',{...run,writerFence:{...fence,phase:'restarting'}});
  await this.reconcile();const restarted=await writerFence(this.config.maintenance.writerFenceCommand,'start',fence.machine,jobId,fence.backend,this.owner);if(!restarted.inventoryComplete){const observationKey='authority:observation:'+importRepoKey(run.repository),old=this.facts.get(observationKey,'observation');if(old)this.facts.put(observationKey,'observation',{...old,observedAt:this.owner.now(),band:'unknown'});queueBackupAlert(this.owner,'authority',jobId+':inventory','writer_fence_failed',this.config.repositories.find(p=>p.repository===run.repository)?.machine??fence.machine,run.repository,'inventory');}
  this.facts.put(key,'maintenance',{...this.facts.get(key,'maintenance')!,writerFence:{...fence,phase:'released',inventoryComplete:restarted.inventoryComplete,inventoryBytes:restarted.inventoryBytes}});
 }
}

/** Job-scoped non-append-only rest-server, reachable only through the authority proxy. */
import { createHash,createHmac } from 'node:crypto';
import { mkdir,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectProcess,sameProcess } from '../../harness/src/processIdentity.ts';
import type { BackupMaintenanceRun } from '../../core/src/backupService.ts';
import { runBackupTool } from './backupCapture.ts';
import type { BackupAuthorityConfig } from './backupServiceConfig.ts';
import { BackupFacts,insist,serviceSecret,type BackupServiceOwner } from './backupServiceSupport.ts';
export class BackupMaintenanceBackend {
 readonly config:BackupAuthorityConfig;readonly owner:BackupServiceOwner;readonly facts:BackupFacts;
 private active:{jobId:string;leaseId:string;counter:number;authorization:string;abort:AbortController;settled:Promise<void>;file:string;exited:boolean}|null=null;
 constructor(config:BackupAuthorityConfig,owner:BackupServiceOwner){this.config=config;this.owner=owner;this.facts=new BackupFacts(owner,'authority');}
 async password(id:string,counter:number):Promise<string>{const secret=await serviceSecret(this.owner,this.config.maintenance.accessKeyRef,'secret');insist(secret.length>=32,'secret_unavailable');return createHmac('sha256',secret).update('backend:'+id+':'+counter).digest('base64url');}
 async ensure(run:BackupMaintenanceRun,leaseId:string,counter:number):Promise<void>{
  if(this.active){insist(this.active.jobId===run.id&&!this.active.exited,'busy');return;}
  if(run.processIdentity){const seen=inspectProcess(run.processIdentity.pid);insist(seen.kind==='gone'||seen.kind==='present'&&!sameProcess(run.processIdentity,seen),'busy');}
  const url=new URL(this.config.maintenance.backendUrl);insist(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/'&&url.port.length>0,'invalid_config');
  const password=await this.password(leaseId,counter),username='authority',directory=join(this.config.reserveRoot,'maintenance-auth');await mkdir(directory,{recursive:true,mode:0o700});const file=join(directory,run.id+'.htpasswd');
  await writeFile(file,username+':{SHA}'+createHash('sha1').update(password).digest('base64')+'\n',{mode:0o600});
  const abort=new AbortController(),signal=this.owner.signal?AbortSignal.any([abort.signal,this.owner.signal]):abort.signal;
  const entry={jobId:run.id,leaseId,counter,authorization:'Basic '+Buffer.from(username+':'+password).toString('base64'),abort,settled:Promise.resolve(),file,exited:false};this.active=entry;
  entry.settled=runBackupTool(this.config.maintenance.backendCommand,['--listen',url.host,'--path',this.config.backupRoot,'--htpasswd-file',file],{tools:this.owner.tools,signal,child:pid=>{
   const current=this.facts.get('authority:maintenance:'+run.id,'maintenance');if(!current)return;const identity=pid==null?null:inspectProcess(pid);if(pid!=null)insist(identity?.kind==='present','outcome_unknown');this.facts.put('authority:maintenance:'+run.id,'maintenance',{...current,processIdentity:identity?.kind==='present'?{pid:identity.pid,birth:identity.birth,bootId:identity.bootId}:null});
  }}).then(()=>undefined).catch(()=>undefined).finally(()=>{entry.exited=true;});
  try{for(let i=0;i<100;i++){insist(!entry.exited,'owner_unavailable');try{const response=await fetch(url,{headers:{authorization:'Basic '+Buffer.from(username+':'+password).toString('base64')},redirect:'error',signal:AbortSignal.timeout(250)});await response.body?.cancel();if(response.status!==401){await new Promise<void>(r=>setTimeout(r,25));insist(!entry.exited,'owner_unavailable');return;}}catch{}await new Promise<void>(r=>setTimeout(r,25));}throw Error('backend_unavailable');}
  catch(error){await this.stop(run.id);throw error;}
 }
 async authorization(leaseId:string,counter:number):Promise<string>{insist(this.active&&!this.active.exited&&this.active.leaseId===leaseId&&this.active.counter===counter,'grant_invalid');return this.active.authorization;}
 async quiet(run:BackupMaintenanceRun):Promise<boolean>{if(this.active?.jobId===run.id){await this.stop(run.id);return true;}if(!run.processIdentity)return true;const observed=inspectProcess(run.processIdentity.pid);return observed.kind==='gone'||observed.kind==='present'&&!sameProcess(run.processIdentity,observed);}
 async stop(jobId?:string):Promise<void>{const active=this.active;if(!active||jobId&&active.jobId!==jobId)return;active.abort.abort();await active.settled;await rm(active.file,{force:true});this.active=null;}
}

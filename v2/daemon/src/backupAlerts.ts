import type { BackupServiceAlert,BackupStateRow } from '../../core/src/backupService.ts';
import { BackupFacts,serviceHash,serviceSecret,type BackupServiceOwner } from './backupServiceSupport.ts';
import { sendBackupAlert,type BackupMailConfig } from './backupMail.ts';
const flushing=new WeakMap<object,Promise<void>>();
export function queueBackupAlert(owner:BackupServiceOwner,role:BackupStateRow['role'],identity:string,code:BackupServiceAlert['code'],machine:string,repository:string):void{
 const facts=new BackupFacts(owner,role),id=serviceHash({identity,code,machine,repository}),key=role+':alert:'+id;if(facts.get(key,'alert'))return;
 facts.put(key,'alert',{id,code,machine,repository,createdAt:owner.now(),state:'pending',attempts:0,nextAttemptAt:owner.now(),messageId:id,sentAt:null});
}
export async function flushBackupAlerts(owner:BackupServiceOwner,role:BackupStateRow['role'],config:BackupMailConfig):Promise<void>{
 const existing=flushing.get(owner.store);if(existing)return existing;
 const work=(async()=>{const facts=new BackupFacts(owner,role),alerts=await facts.scan(role+':alert:','alert');
 for(const alert of alerts.filter(a=>a.state!=='sent'&&a.nextAttemptAt<=owner.now()).slice(0,10)){
  const next={...alert,state:'sending' as const,attempts:alert.attempts+1,nextAttemptAt:owner.now()+Math.min(3600000,30000*2**Math.min(alert.attempts,7))};facts.put(role+':alert:'+alert.id,'alert',next);
  try{await sendBackupAlert(config,next,(ref,field)=>serviceSecret(owner,ref,field));facts.put(role+':alert:'+alert.id,'alert',{...next,state:'sent',sentAt:owner.now()});}
  catch{facts.put(role+':alert:'+alert.id,'alert',{...next,state:'pending'});}
 }} )();flushing.set(owner.store,work);try{await work;}finally{flushing.delete(owner.store);}
}

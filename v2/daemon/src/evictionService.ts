import {repoKey} from './backupServiceSupport.ts';
/** Admission is synchronous; the owner gate is durable before the worker starts. */
import { Worker } from "node:worker_threads";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalBackupJson, verifyBackupReceipt } from "../../core/src/backupReceipt.ts";
import type { CoreStore, CellRow } from "../../core/src/index.ts";
import type { BackupRecord } from "./backupCapture.ts";
import { checkEvictionPolicy, rollbackUnauthorizedPark, VerifiedEvictionError, type EvictionReason, type EvictionPolicy, type VerifiedEvictionInput, type VerifiedEvictionResult } from "./verifiedEviction.ts";
export interface EvictionOwner {store:CoreStore;dataDir:string;cellsRoot:string;keepRoot:string;machine:string;busy:(cell:CellRow,exceptKey?:string)=>boolean;git:string;signal?:AbortSignal;workerUrl?:URL;pinRecovery?:(record:BackupRecord)=>Promise<void>}
export type OwnerEvictionResult={status:"deleted";head:string;operationId:string;generation:string}|{status:"refused";reason:EvictionReason;operationId?:string};
export async function evictThroughOwner(cell:CellRow,mode:"evict"|"remove"|"trim",key:string|undefined,owner:EvictionOwner):Promise<OwnerEvictionResult>{
  const {store}=owner;
  const requestHash=canonicalBackupJson({cellId:cell.id,mode});const old=key?store.getCellOpByKey(key):null;
  let prior:VerifiedEvictionInput|undefined;
  if(old){
    if(old.kind!=="remove"||old.cellId!==cell.id||old.requestHash!==requestHash)throw new Error("idempotency_conflict");
    const saved=JSON.parse(old.stdout);
    if(old.status==="done"||old.status==="failed")return(saved.lastResult??saved) as OwnerEvictionResult;
    if(saved.format!=="honeybee.eviction-intent.v1")return{status:"refused",reason:"outcome_unknown",operationId:old.id};
    prior=saved.input;
  }
  const refuse=(reason:EvictionReason):OwnerEvictionResult=>{
    if(prior&&old){try{rollbackUnauthorizedPark(prior);}catch{return{status:"refused",reason:"outcome_unknown",operationId:old.id};}
      const result:OwnerEvictionResult={status:"refused",reason,operationId:old.id};store.updateCellOp(old.id,{status:"failed",pid:null,failure:reason,stdout:JSON.stringify(result)});return result;}
    return{status:"refused",reason};
  };
  if(owner.signal?.aborted)return refuse("interrupted");
  if(owner.busy(cell,old?.idempotencyKey))return refuse("gate_busy");
  const latest=store.latestCellBackupOp(cell.id);if(!latest&&!prior)return refuse("receipt_missing");
  if(!prior&&latest!.status!=="done")return refuse("receipt_unverified");
  let record:BackupRecord,publicKey:string,policy:EvictionPolicy,repository:string;
  try{
    record=prior?.record??JSON.parse(latest!.stdout) as BackupRecord;
    if(record.verification!=="verified"||!record.receipt)return refuse("receipt_unverified");
    const trust=JSON.parse(readFileSync(join(owner.dataDir,"backup-trust.json"),"utf8"));publicKey=trust?.publicKeys?.[record.receipt.payload.verifier.keyId];
    if(typeof publicKey!=="string")return refuse("receipt_corrupt");
    verifyBackupReceipt(record.receipt,publicKey);
  }catch{return refuse("receipt_corrupt");}
  try{repository=JSON.parse(readFileSync(join(owner.dataDir,"backup.json"),"utf8")).repository;policy=JSON.parse(readFileSync(join(owner.dataDir,"backup-eviction.json"),"utf8"));if(!prior||!existsSync(prior.completionPath))checkEvictionPolicy(policy,repository,Date.now());}
  catch(error){return refuse(error instanceof VerifiedEvictionError?error.reason:"unknown_policy");}
  if((!prior||!existsSync(prior.completionPath))&&existsSync(join(owner.dataDir,'backup-service.json'))){const health=store.backupState('machine:capacity-health:'+repoKey(repository),'capacityHealth','machine');if(!health?.value.valid)return refuse('capacity_stop');}
  if(record.repository!==repository)return refuse("receipt_stale");
  // There is no await between the final live-state check and the durable gate.
  if(owner.busy(cell,old?.idempotencyKey))return refuse("gate_busy");
  const op=old??store.putCellOp({cellId:cell.id,kind:"remove",idempotencyKey:key??"verified-removal:"+randomUUID(),requestHash});
  const input:VerifiedEvictionInput={operationId:op.id,cellId:cell.id,machine:owner.machine,spaceDir:cell.spaceDir,cellsRoot:owner.cellsRoot,keepRoot:owner.keepRoot,record,publicKey,policy,repository,mode,now:Date.now(),git:owner.git,runtimeGeneration:cell.state==="active"?store.currentRuntime(cell.sourceBeeId)?.generation??null:null,cellIdentity:canonicalBackupJson(cell),policyPath:join(owner.dataDir,"backup-eviction.json"),sourceBeePresent:store.getBee(cell.sourceBeeId)!==null,completionPath:join(owner.dataDir,"eviction-completions",op.id+".json"),abortFlag:new SharedArrayBuffer(4)};
  if(prior){input.cellIdentity=prior.cellIdentity;input.runtimeGeneration=prior.runtimeGeneration;}
  store.updateCellOp(op.id,{status:"running",pid:process.pid,stdout:JSON.stringify({format:"honeybee.eviction-intent.v1",input:{...input,publicKey:undefined,abortFlag:undefined},captureGeneration:record.generation})});
  const url=owner.workerUrl??new URL(import.meta.url.endsWith(".ts")?"./evictionWorker.ts":"./eviction-worker.js",import.meta.url);
  try{
    if(!existsSync(input.completionPath)){if(policy.pinRequired&&!owner.pinRecovery)throw new VerifiedEvictionError("pin_unavailable");if(owner.pinRecovery){try{await owner.pinRecovery(record);}catch{throw new VerifiedEvictionError("pin_unavailable");}}}
    const result=await new Promise<VerifiedEvictionResult>((accept,reject)=>{
      const worker=new Worker(url,{workerData:input});let settled=false;
      const abort=()=>{Atomics.store(new Int32Array(input.abortFlag!),0,1);};owner.signal?.addEventListener("abort",abort,{once:true});
      worker.once("message",message=>{settled=true;owner.signal?.removeEventListener("abort",abort);if(message.ok)accept(message.result);else reject(new VerifiedEvictionError(message.reason));});
      worker.once("error",()=>{owner.signal?.removeEventListener("abort",abort);reject(new VerifiedEvictionError("outcome_unknown"));});
      worker.once("exit",()=>{owner.signal?.removeEventListener("abort",abort);if(!settled)reject(new VerifiedEvictionError("outcome_unknown"));});
      worker.postMessage("admitted");
    });
    if(mode==="evict"&&store.getBee(cell.sourceBeeId))store.evictCell(cell.id,{head:result.head,bytes:null,reason:"verified_backup"});else store.markCellRemoved(cell.id);
    const response:OwnerEvictionResult={status:"deleted",head:result.head,generation:result.generation,operationId:op.id};store.updateCellOp(op.id,{status:"done",pid:null,stdout:JSON.stringify(response)});
    try{await (await import("node:fs/promises")).rm(input.completionPath,{force:true});}catch{/* Done row is authoritative if marker cleanup is interrupted. */}
    return response;
  }catch(error){
    const reason=error instanceof VerifiedEvictionError?error.reason:"outcome_unknown";
    const parked=join(owner.cellsRoot,"_evicting",dirname(cell.spaceDir).split("/").at(-1)+".verified."+op.id);
    const ambiguous=existsSync(parked)||!existsSync(cell.spaceDir);const response:OwnerEvictionResult={status:"refused",reason:ambiguous?"outcome_unknown":reason,operationId:op.id};
    store.updateCellOp(op.id,{status:ambiguous?"outcome_unknown":"failed",pid:null,failure:response.reason,stdout:JSON.stringify({format:"honeybee.eviction-intent.v1",input:{...input,publicKey:undefined,abortFlag:undefined},lastResult:response})});return response;
  }
}

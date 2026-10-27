/** Owner-side deletion preflight and synchronous effect, run only in a worker. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, mkdirSync, rmSync, writeFileSync, fsyncSync, chmodSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { backupDigest, canonicalBackupJson, verifyBackupReceipt, type VerifiedBackupReceipt } from "../../core/src/backupReceipt.ts";
import { classifyIgnored } from "../../driver-cell/src/retention.ts";
import type { BackupEntry, BackupManifest, BackupRecord } from "./backupCapture.ts";
export const EVICTION_REASONS=["receipt_missing","receipt_stale","receipt_corrupt","receipt_unverified","content_changed","capacity_stop","unknown_policy","gate_busy","interrupted","outcome_unknown"] as const;
export type EvictionReason=typeof EVICTION_REASONS[number];
export class VerifiedEvictionError extends Error { readonly reason:EvictionReason; constructor(reason:EvictionReason){super(reason);this.reason=reason;} }
function requireThat(value:unknown,reason:EvictionReason):asserts value {if(!value)throw new VerifiedEvictionError(reason);}
export interface EvictionPolicy {version:1;maxReceiptAgeMs:number;capacity:{repository:string;observedAt:number;maxAgeMs:number;repositoryUsedBytes:number;repositoryLimitBytes:number;fleetUsedBytes:number;fleetLimitBytes:number;stopFraction:number}}
export interface VerifiedEvictionInput {operationId:string;cellId:string;machine:string;spaceDir:string;cellsRoot:string;keepRoot:string;record:BackupRecord;publicKey:string;policy:EvictionPolicy;repository:string;mode:"evict"|"remove"|"trim";now:number;git:string;runtimeGeneration:number|null;cellIdentity:string;completionPath:string;policyPath?:string;sourceBeePresent?:boolean;abortFlag?:SharedArrayBuffer}
export interface VerifiedEvictionResult {status:"deleted";head:string;generation:string;parkedDir:string}
export function checkEvictionPolicy(policy:EvictionPolicy,repository:string,now:number):void {
  requireThat(policy?.version===1&&Number.isSafeInteger(policy.maxReceiptAgeMs)&&policy.maxReceiptAgeMs>0,"unknown_policy");
  const c=policy.capacity;
  requireThat(c&&c.repository===repository&&Number.isSafeInteger(c.observedAt)&&c.observedAt<=now&&Number.isSafeInteger(c.maxAgeMs)&&c.maxAgeMs>0&&now-c.observedAt<=c.maxAgeMs&&c.stopFraction===0.9,"unknown_policy");
  for(const value of[c.repositoryUsedBytes,c.repositoryLimitBytes,c.fleetUsedBytes,c.fleetLimitBytes])requireThat(Number.isSafeInteger(value)&&value>=0,"unknown_policy");
  requireThat(c.repositoryLimitBytes>0&&c.fleetLimitBytes>0,"unknown_policy");
  requireThat(c.repositoryUsedBytes<c.repositoryLimitBytes*c.stopFraction&&c.fleetUsedBytes<c.fleetLimitBytes*c.stopFraction,"capacity_stop");
}
function fileEntry(path:string):BackupEntry {
  const before=lstatSync(path),mode=before.mode&0o7777;
  requireThat(realpathSync(dirname(path))===dirname(path),"content_changed");
  if(before.isSymbolicLink()){const target=readlinkSync(path);return{path,kind:"symlink",mode,bytes:Buffer.byteLength(target),sha256:backupDigest(target),target};}
  if(before.isDirectory())return{path,kind:"directory",mode,bytes:0,sha256:backupDigest("")};
  requireThat(before.isFile(),"content_changed");const hash=createHash("sha256"),fd=openSync(path,"r"),buffer=Buffer.alloc(1024*1024);
  try{for(let n;(n=readSync(fd,buffer,0,buffer.length,null))>0;)hash.update(buffer.subarray(0,n));}finally{closeSync(fd);}
  const after=lstatSync(path);requireThat(before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,"content_changed");
  return{path,kind:"file",mode,bytes:before.size,sha256:hash.digest("hex")};
}
const excluded=new Set(["node_modules",".cache",".npm",".pnpm-store","dist","build","out","target",".next","updates","honeybee-updates"]),pruned=new Set(["node_modules",".cache",".npm",".pnpm-store","updates","honeybee-updates"]),evidence=new Set([".proof",".audit","evidence",".evidence"]);
function selectedPaths(root:string,tracked:Set<string>,gitRoot:string):string[]{
  const paths:string[]=[],ancestors=new Set([""]);for(const path of tracked)for(let p=dirname(path);p!==".";p=dirname(p))ancestors.add(p);
  function walk(path:string,important:boolean,skip:boolean){const name=basename(path),rel=relative(root,path);if(name===".git"){requireThat(path===gitRoot,"content_changed");return;}
    const st=lstatSync(path);important||=evidence.has(name);skip||=excluded.has(name);const hasTracked=tracked.has(rel)||ancestors.has(rel);
    if(skip&&!important&&!hasTracked&&pruned.has(name))return;
    if(st.isDirectory()){if(!skip||important||hasTracked)paths.push(path);for(const name of readdirSync(path).sort())walk(join(path,name),important,skip);}
    else if((st.isFile()||st.isSymbolicLink())&&(!skip||important||tracked.has(rel)))paths.push(path);
  }walk(root,false,false);return paths.sort();
}
/** This function runs off the daemon event loop with its durable owner gate held. */
export function performVerifiedEviction(input:VerifiedEvictionInput,hooks:{afterPark?:()=>void;afterAuthorization?:()=>void}={}):VerifiedEvictionResult {
  try{return perform(input,hooks);}catch(error){rollbackUnauthorizedPark(input);throw error;}
}
export function rollbackUnauthorizedPark(input:VerifiedEvictionInput):void {
  const wrapper=dirname(resolve(input.spaceDir)),park=join(resolve(input.cellsRoot),"_evicting",basename(wrapper)+".verified."+input.operationId);
  requireThat(dirname(wrapper)===resolve(input.cellsRoot)&&/^[A-Za-z0-9-]+$/.test(input.operationId),"outcome_unknown");
  let authorized=false;try{const m=JSON.parse(readFileSync(input.completionPath,"utf8"));authorized=m.operationId===input.operationId&&m.manifestHash===input.record.manifestHash&&m.generation===input.record.generation&&m.parkedDir===park;}catch{}
  if(!authorized&&existsSync(park)){requireThat(!existsSync(wrapper),"outcome_unknown");renameSync(park,wrapper);}
}
function perform(input:VerifiedEvictionInput,hooks:{afterPark?:()=>void;afterAuthorization?:()=>void}):VerifiedEvictionResult {
  requireThat(input.mode!=="evict"||JSON.parse(input.cellIdentity).state==="active","receipt_stale");
  const {record}=input;requireThat(record,"receipt_missing");requireThat(record.verification==="verified"&&record.receipt,"receipt_unverified");
  let receipt:VerifiedBackupReceipt;try{receipt=verifyBackupReceipt(record.receipt,input.publicKey);}catch{throw new VerifiedEvictionError("receipt_corrupt");}
  const p=receipt.payload;requireThat(record.state==="snapshot_created"&&record.operationId===record.generation&&p.generation===record.generation&&p.machine===input.machine&&p.cellId===input.cellId&&record.cellId===input.cellId&&record.machine===input.machine&&p.repository===input.repository&&record.repository===input.repository&&p.manifestPath===record.manifestPath&&p.manifestHash===record.manifestHash&&p.snapshotId===record.snapshotId,"receipt_corrupt");
  const wrapper=dirname(resolve(input.spaceDir)),cells=realpathSync(input.cellsRoot),parkedDir=join(cells,"_evicting",basename(wrapper)+".verified."+input.operationId);
  let completed=false;try{const marker=JSON.parse(readFileSync(input.completionPath,"utf8"));completed=marker.operationId===input.operationId&&marker.manifestHash===p.manifestHash&&marker.generation===p.generation&&marker.parkedDir===parkedDir;}catch{/* A missing marker is not authorization. */}
  if(completed){requireThat(!existsSync(wrapper),"outcome_unknown");finishPark(parkedDir);return{status:"deleted",head:p.git.head,generation:p.generation,parkedDir};}
  const cancelled=()=>requireThat(!input.abortFlag||Atomics.load(new Int32Array(input.abortFlag),0)===0,"interrupted");cancelled();
  checkEvictionPolicy(input.policy,input.repository,input.now);requireThat(input.now>=Date.parse(p.verifiedAt)&&input.now-Date.parse(p.verifiedAt)<=input.policy.maxReceiptAgeMs,"receipt_stale");
  let manifest:BackupManifest;try{const bytes=readFileSync(record.manifestPath);requireThat(backupDigest(bytes)===p.manifestHash,"receipt_corrupt");manifest=JSON.parse(bytes.toString());}catch(error){if(error instanceof VerifiedEvictionError)throw error;throw new VerifiedEvictionError("receipt_corrupt");}
  requireThat(manifest.format==="honeybee.capture.v1"&&manifest.generation===p.generation&&manifest.machine===p.machine&&manifest.cell.id===input.cellId&&manifest.cell.spaceDir===input.spaceDir&&manifest.captureKind==="retained_checkout","receipt_stale");
  requireThat((input.sourceBeePresent===false||(manifest.sourceRuntimeGeneration??null)===input.runtimeGeneration)&&canonicalBackupJson(manifest.cell)===input.cellIdentity,"receipt_stale");
  requireThat(manifest.policy.version===1,"unknown_policy");
  const originalRoot=resolve(input.spaceDir);let root=originalRoot;
  const alreadyParked=!existsSync(wrapper)&&existsSync(parkedDir);if(alreadyParked)root=join(parkedDir,basename(originalRoot));
  const mapped=(path:string)=>alreadyParked||root!==originalRoot?(path===wrapper||path.startsWith(wrapper+"/")?parkedDir+path.slice(wrapper.length):path):path;
  const sourceName=(path:string)=>root!==originalRoot&&path.startsWith(parkedDir+"/")?wrapper+path.slice(parkedDir.length):path;
  requireThat(dirname(wrapper)===cells&&realpathSync(alreadyParked?parkedDir:wrapper)===(alreadyParked?parkedDir:wrapper)&&realpathSync(root)===root&&lstatSync(root).isDirectory(),"content_changed");
  const git=(args:string[])=>execFileSync(input.git,["-c","safe.directory="+root,"-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never",...args],{cwd:root,encoding:"utf8",maxBuffer:64*1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_NO_LAZY_FETCH:"1",GIT_NO_REPLACE_OBJECTS:"1"},stdio:["ignore","pipe","pipe"]});
  const verifyTree=()=>{cancelled();
    const expected=manifest.entries.filter(e=>e.path===originalRoot||e.path.startsWith(originalRoot+"/")||e.path===join(wrapper,"box","cell.json")||e.path===join(input.keepRoot,manifest.cell.spaceName)+".json"||e.path===join(input.keepRoot,manifest.cell.spaceName)||e.path.startsWith(join(input.keepRoot,manifest.cell.spaceName)+"/"));
    for(const entry of expected)requireThat(JSON.stringify({...fileEntry(mapped(entry.path)),path:entry.path})===JSON.stringify(entry),"content_changed");
    const tracked=new Set(git(["ls-files","-z"]).split("\0").filter(Boolean));
    const actual=selectedPaths(root,tracked,join(root,".git")).map(sourceName).sort(),wanted=expected.filter(e=>e.path!==manifest.git.index&&(e.path===originalRoot||e.path.startsWith(originalRoot+"/"))).map(e=>e.path).sort();
    requireThat(JSON.stringify(actual)===JSON.stringify(wanted),"content_changed");
    const keep=join(input.keepRoot,manifest.cell.spaceName),kept=existsSync(keep)?selectedPaths(keep,new Set(),join(root,".git")):[];
    requireThat(JSON.stringify(kept)===JSON.stringify(expected.filter(e=>e.path===keep||e.path.startsWith(keep+"/")).map(e=>e.path).sort()),"content_changed");
    requireThat(git(["rev-parse","HEAD"]).trim()===manifest.git.head&&git(["for-each-ref","--format=%(objectname) %(refname)"])===manifest.git.refs&&backupDigest(git(["cat-file","--batch-all-objects","--batch-check=%(objectname)"]))===manifest.git.objectIdsHash,"content_changed");
    // Metadata fence detects a writer changing a file during the complete inventory pass.
    for(const entry of expected)requireThat(JSON.stringify({...fileEntry(mapped(entry.path)),path:entry.path})===JSON.stringify(entry),"content_changed");
  };
  try{verifyTree();}catch(error){if(error instanceof VerifiedEvictionError)throw error;throw new VerifiedEvictionError("content_changed");}
  requireThat(input.mode!=="trim","unknown_policy"); // No partial-tree disposal policy is defined in v1.
  checkEvictionPolicy(input.policy,input.repository,Date.now());
  if(input.mode==="evict"){
    // Normal revive still uses the local origin; a remote-only head requires explicit restore.
    try{const reachable=execFileSync(input.git,["-C",manifest.cell.originRepo,"-c","core.fsmonitor=false","for-each-ref","--contains="+manifest.git.head,"--format=%(refname)"],{encoding:"utf8",maxBuffer:64*1024*1024,env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"},stdio:["ignore","pipe","pipe"]});requireThat(reachable.trim().length>0,"unknown_policy");requireThat(!resolve(manifest.cell.originRepo).startsWith(wrapper+"/")&&resolve(manifest.cell.originRepo)!==wrapper,"unknown_policy");}
    catch{throw new VerifiedEvictionError("unknown_policy");}
    const ignored=classifyIgnored(root);requireThat(ignored.env.length===0&&ignored.keep.length===0,"unknown_policy");
  }
  assertNoOpenWriter(alreadyParked?parkedDir:wrapper);
  cancelled();requireThat(alreadyParked||!existsSync(parkedDir),"outcome_unknown");mkdirSync(dirname(parkedDir),{recursive:true,mode:0o700});
  if(!alreadyParked){renameSync(wrapper,parkedDir);
    for(const path of[cells,dirname(parkedDir)]){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
  }
  root=join(parkedDir,basename(originalRoot));
  hooks.afterPark?.();
  try{verifyTree();assertNoOpenWriter(parkedDir);cancelled();}
  catch(error){if(!existsSync(wrapper))renameSync(parkedDir,wrapper);throw error instanceof VerifiedEvictionError?error:new VerifiedEvictionError("content_changed");}
  let finalPolicy=input.policy;
  if(input.policyPath){try{finalPolicy=JSON.parse(readFileSync(input.policyPath,"utf8"));}catch{throw new VerifiedEvictionError("unknown_policy");}}
  checkEvictionPolicy(finalPolicy,input.repository,Date.now());
  requireThat(Date.now()-Date.parse(p.verifiedAt)<=finalPolicy.maxReceiptAgeMs,"receipt_stale");
  // Authorization is committed after the parked readback, before any unlink. Recovery may finish this effect.
  mkdirSync(dirname(input.completionPath),{recursive:true,mode:0o700});if(existsSync(input.completionPath))rmSync(input.completionPath);const fd=openSync(input.completionPath,"wx",0o600);
  try{writeFileSync(fd,JSON.stringify({operationId:input.operationId,manifestHash:p.manifestHash,generation:p.generation,parkedDir}));fsyncSync(fd);}finally{closeSync(fd);}
  const dirFd=openSync(dirname(input.completionPath),"r");try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
  hooks.afterAuthorization?.();
  finishPark(parkedDir);return{status:"deleted",head:manifest.git.head,generation:manifest.generation,parkedDir};
}
function finishPark(path:string):void {
  if(!existsSync(path))return;
  const writable=(entry:string)=>{const st=lstatSync(entry);if(st.isSymbolicLink())return;if(st.isDirectory()){chmodSync(entry,(st.mode&0o7777)|0o700);for(const name of readdirSync(entry))writable(join(entry,name));}};
  writable(path);rmSync(path,{recursive:true,force:false});
}

function assertNoOpenWriter(wrapper:string):void {
  if(process.platform!=="linux")throw new VerifiedEvictionError("unknown_policy");
  for(const pid of readdirSync("/proc").filter(name=>/^[0-9]+$/.test(name))){
    const probes=[join("/proc",pid,"cwd")];try{for(const fd of readdirSync(join("/proc",pid,"fd")))probes.push(join("/proc",pid,"fd",fd));}catch{/* Other users may hide descriptors; Cells are owner-only. */}
    for(const probe of probes){let target:string;try{target=readlinkSync(probe).replace(/ \(deleted\)$/," ").trimEnd();}catch{continue;}
      requireThat(target!==wrapper&&!target.startsWith(wrapper+"/"),"content_changed");}
  }
}

import { list as listTar, type ReadEntry } from "tar";
/** Independent read/decrypt/verifier service. Not imported by the uploading daemon. */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants, createZstdDecompress } from "node:zlib";
import { backupDigest, backupVerifierKeyId, canonicalBackupJson, verifyBackupReceipt, type BackupVerificationPayload, type TranscriptArchiveIdentity, type TranscriptArchiveSummary, type VerifiedBackupReceipt, type VerifiedTranscriptObject } from "../../core/src/backupReceipt.ts";
import { backupToolEnv, resolveBackupSecret, runBackupTool, type BackupEntry, type BackupManifest, type BackupOwner, type BackupRecord, type BackupTools } from "./backupCapture.ts";

export type VerificationFailure = "invalid_request" | "restore_failed" | "manifest_mismatch" | "content_mismatch" | "git_invalid" | "database_invalid" | "receipt_invalid" | "catalogue_missing" | "catalogue_conflict" | "secret_unavailable" | "authority_denied" | "archive_invalid" | "owner_unavailable" | "interrupted";
export class BackupVerificationError extends Error { readonly code: VerificationFailure; constructor(code: VerificationFailure) { super(code); this.code = code; } }
export interface BackupRepositoryAccess { machine: string; repository: string; passwordRef: string; credentialRef: string }
export interface BackupVerificationOwner {
  tools: BackupTools;
  stageRoot: string;
  maxRestoreBytes: number;
  trustedPublicKey: string;
  signal?: AbortSignal;
  resolveSecret?: BackupOwner["resolveSecret"];
}
export interface BackupVerifierAuthority {
  /** Configured service identity; never supplied by the capture/uploader request. */
  id: string;
  signingKeyRef: string;
}
export interface RecoveryCatalogue {
  format: "honeybee.recovery-catalogue.v1";
  record: BackupRecord;
  receipt: VerifiedBackupReceipt;
}
export interface VerifiedCaptureStage { directory: string; manifest: BackupManifest; record: BackupRecord; files: Map<string,string>; repositoryId: string; transcripts: VerifiedTranscriptObject[] }
export interface VerifiedTranscriptStage {
  format: "honeybee.apiary-transcript-stage.v1";
  receipt: VerifiedBackupReceipt;
  object: VerifiedTranscriptObject;
  compressedPath: string;
  decodedPath: string;
}
export interface TranscriptStageAcceptance { accepted: true; ownerNodeId: string; objectRef: string; receiptId: string }
export type TranscriptStageOwner = (stage: Readonly<VerifiedTranscriptStage>) => Promise<TranscriptStageAcceptance>;
const readbackProofs = new WeakMap<VerifiedCaptureStage,string>();
const stageClaim = (stage: VerifiedCaptureStage) => backupDigest(canonicalBackupJson({directory:stage.directory,files:[...stage.files.entries()],manifest:stage.manifest,record:stage.record,repositoryId:stage.repositoryId,transcripts:stage.transcripts}));
const CATALOGUE_PATH = "/honeybee-recovery-catalogue-v1.json";
const CATALOGUE_TAG = "honeybee-recovery-catalogue-v1";
const id = /^[a-f0-9]{64}$/;
function check(condition: unknown, code: VerificationFailure = "invalid_request"): asserts condition { if (!condition) throw new BackupVerificationError(code); }
function abort(owner: BackupVerificationOwner): void { if (owner.signal?.aborted) throw new BackupVerificationError("interrupted"); }
function pathValid(path: unknown): path is string {
  return typeof path === "string" && path.length < 16384 && path.startsWith("/") && path !== "/" && !/[\x00-\x1f\\]/.test(path) && posix.normalize(path) === path;
}
function processOwner(owner: BackupVerificationOwner) { return { tools: owner.tools, signal: owner.signal, child: () => undefined, resolveSecret: owner.resolveSecret }; }
async function privateStage(owner: BackupVerificationOwner): Promise<string> {
  abort(owner);check(isAbsolute(owner.stageRoot) && owner.maxRestoreBytes > 0 && Number.isSafeInteger(owner.maxRestoreBytes));
  await mkdir(owner.stageRoot,{recursive:true,mode:0o700});
  const root=await import("node:fs/promises").then(fs=>fs.realpath(owner.stageRoot));
  const stage=await mkdtemp(join(root,"verify-"));await chmod(stage,0o700);return stage;
}
async function hashFile(path: string, signal?: AbortSignal): Promise<string> {
  const digest=createHash("sha256");for await(const bytes of createReadStream(path,{signal}))digest.update(bytes);return digest.digest("hex");
}
async function transport(access: BackupRepositoryAccess, owner: BackupVerificationOwner) {
  let url:URL;try {check(access.repository.startsWith("rest:"));url=new URL(access.repository.slice(5));}catch{throw new BackupVerificationError("invalid_request");}
  check(typeof access.machine==="string"&&access.machine.length>0&&access.machine.length<256);
  check(!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[A-Za-z0-9._/-]+\/$/.test(url.pathname));
  check(url.protocol==="https:"||(url.protocol==="http:"&&["127.0.0.1","[::1]"].includes(url.hostname)));
  check(/^global\/fleet-backup-[A-Za-z0-9._-]+-repo-key$/.test(access.passwordRef));
  check(/^global\/fleet-backup-[A-Za-z0-9._-]+-(?:reader|catalogue-writer)$/.test(access.credentialRef));
  let password:string,username:string,credential:string;
  try {password=await resolveBackupSecret(processOwner(owner),access.passwordRef,"password");username=await resolveBackupSecret(processOwner(owner),access.credentialRef,"username");credential=await resolveBackupSecret(processOwner(owner),access.credentialRef,"password");}
  catch{throw new BackupVerificationError(owner.signal?.aborted?"interrupted":"secret_unavailable");}
  const env={...backupToolEnv(),RESTIC_PASSWORD:password,RESTIC_REST_USERNAME:username,RESTIC_REST_PASSWORD:credential};
  return async(args:string[], options:{output?:string;limit?:number;input?:string}={})=>{
    abort(owner);try{return await runBackupTool(owner.tools.restic,["--repo",access.repository,"--no-cache",...args],processOwner(owner),{env,...options});}
    catch{throw new BackupVerificationError(owner.signal?.aborted?"interrupted":"restore_failed");}
  };
}
function parseManifest(bytes:Buffer, record:BackupRecord, maximum:number):BackupManifest {
  check(backupDigest(bytes)===record.manifestHash,"manifest_mismatch");
  let value:unknown;try{value=JSON.parse(bytes.toString("utf8"));}catch{throw new BackupVerificationError("manifest_mismatch");}
  check(value&&typeof value==="object","manifest_mismatch");const m=value as BackupManifest;
  check(m.format==="honeybee.capture.v1"&&m.machine===record.machine&&m.cell?.id===record.cellId&&m.generation===record.generation,"manifest_mismatch");
  check(pathValid(m.cell.spaceDir)&&/^[a-z0-9][a-z0-9-]*-space-[a-z0-9]+$/.test(m.cell.spaceName)&&posix.basename(m.cell.spaceDir)===m.cell.spaceName,"manifest_mismatch");
  const captureRoot=dirname(record.manifestPath),gitRoot=join(m.cell.spaceDir,".git"),keepRoot=join(dirname(dirname(dirname(m.cell.spaceDir))),"cell-keep",m.cell.spaceName),ledger=join(dirname(m.cell.spaceDir),"box","cell.json");
  check(captureRoot!=="/"&&!m.cell.spaceDir.startsWith(captureRoot+"/")&&!captureRoot.startsWith(m.cell.spaceDir+"/"),"manifest_mismatch");
  check(["retained_checkout","evicted_stash"].includes(m.captureKind)&&Array.isArray(m.entries)&&m.entries.length<=1_000_000&&Array.isArray(m.databases),"manifest_mismatch");
  const seen=new Map<string,BackupEntry>();let files=0,total=0;
  for(const entry of m.entries){
    check(entry&&pathValid(entry.path)&&!seen.has(entry.path)&&["file","directory","symlink"].includes(entry.kind),"manifest_mismatch");
    check(entry.path===ledger||entry.path===keepRoot||entry.path===keepRoot+".json"||entry.path.startsWith(keepRoot+"/")||entry.path.startsWith(captureRoot+"/")||(m.captureKind==="retained_checkout"&&(entry.path===m.cell.spaceDir||entry.path.startsWith(m.cell.spaceDir+"/"))),"manifest_mismatch");
    if(entry.path===m.cell.spaceDir||entry.path===keepRoot)check(entry.kind==="directory","manifest_mismatch");
    if(entry.path===gitRoot||entry.path.startsWith(gitRoot+"/"))check(entry.path===join(gitRoot,"index")&&entry.kind==="file"&&m.git?.index===entry.path,"manifest_mismatch");
    check(Number.isSafeInteger(entry.mode)&&entry.mode>=0&&entry.mode<=0o7777&&Number.isSafeInteger(entry.bytes)&&entry.bytes>=0&&id.test(entry.sha256),"manifest_mismatch");
    if(entry.kind==="symlink")check(typeof entry.target==="string"&&Buffer.byteLength(entry.target)<=16384&&backupDigest(entry.target)===entry.sha256&&Buffer.byteLength(entry.target)===entry.bytes,"manifest_mismatch");
    if(entry.kind==="directory")check(entry.bytes===0&&entry.sha256===backupDigest(""),"manifest_mismatch");else files++;
    total+=entry.bytes;check(Number.isSafeInteger(total)&&total<=maximum,"invalid_request");seen.set(entry.path,entry);
  }
  check(files===m.files&&total===m.bytes,"manifest_mismatch");
  for(const entry of m.entries)for(let parent=dirname(entry.path);parent!=="/";parent=dirname(parent))check(!seen.has(parent)||seen.get(parent)?.kind==="directory","manifest_mismatch");
  check(m.git&&/^[a-f0-9]{40,64}$/.test(m.git.head)&&/^[a-f0-9]{40,64}$/.test(m.git.base)&&Array.isArray(m.git.dependencies)&&m.git.dependencies.length===0,"git_invalid");
  if(m.captureKind==="retained_checkout")check(m.git.index===join(gitRoot,"index"),"git_invalid");
  for(const path of [m.git.bundle,m.git.objects,...(m.git.index?[m.git.index]:[])])check(seen.get(path)?.kind==="file","git_invalid");
  for(const db of m.databases)check(db.integrityCheck==="ok"&&seen.get(db.backupPath)?.sha256===db.sha256&&Number.isSafeInteger(db.schemaVersion)&&id.test(db.ddlDigest),"database_invalid");
  return m;
}
/** Exact Apiary v1 JSONL rules: digest includes header/rows and newline, excludes trailer. */
export async function decodeTranscriptArchive(compressed:string, output:string, identity:TranscriptArchiveIdentity, expected:TranscriptArchiveSummary, maxExpandedBytes:number, signal?:AbortSignal):Promise<TranscriptArchiveSummary>{
  check(maxExpandedBytes>0&&Number.isSafeInteger(maxExpandedBytes));const partial=output+".partial";let expanded=0;
  try{
    await pipeline(createReadStream(compressed,{signal}),createZstdDecompress({params:{[constants.ZSTD_d_windowLogMax]:27}}),new Transform({transform(chunk,_encoding,callback){expanded+=chunk.length;callback(expanded>maxExpandedBytes+4096?new BackupVerificationError("archive_invalid"):null,chunk);}}),createWriteStream(partial,{flags:"wx",mode:0o600}),{signal});
    const digest=createHash("sha256"),segments=createHash("sha256");let header=false,trailer=false,inSegments=false;
    const summary:TranscriptArchiveSummary={feedRows:0,segmentRows:0,expandedBytes:0,digest:"",lastLine:0,segmentSeq:0,segmentDigest:""};
    const account=(line:string)=>{summary.expandedBytes+=Buffer.byteLength(line);check(summary.expandedBytes<=maxExpandedBytes,"archive_invalid");digest.update(line);};
    for await(const line of createInterface({input:createReadStream(partial,{signal}),crlfDelay:Infinity})){
      check(Buffer.byteLength(line)<=32*1024*1024&&!trailer,"archive_invalid");const value=JSON.parse(line) as Record<string,unknown>;
      if(!header){check(value.type==="header"&&value.version===1&&["nodeId","beeId","epoch"].every(key=>value[key]===identity[key as keyof TranscriptArchiveIdentity]),"archive_invalid");header=true;account(line+"\n");continue;}
      if(value.type==="trailer"){
        summary.digest=digest.digest("hex");summary.segmentDigest=segments.digest("hex");
        check(Object.entries(summary).every(([key,valueExpected])=>(key==="segmentDigest"&&value[key]===undefined)||value[key]===valueExpected),"archive_invalid");trailer=true;continue;
      }
      check((value.type==="feed"||value.type==="segment")&&value.row&&typeof value.row==="object","archive_invalid");const row=value.row as Record<string,unknown>;
      check(row.bee_id===identity.beeId,"archive_invalid");
      if(value.type==="feed"){
        check(!inSegments&&Number.isSafeInteger(row.line_no)&&Number(row.line_no)>summary.lastLine&&row.raw===""&&typeof row.events==="string"&&Array.isArray(JSON.parse(row.events)),"archive_invalid");summary.feedRows++;summary.lastLine=Number(row.line_no);
      }else{check(Number.isSafeInteger(row.seq)&&Number(row.seq)>=0,"archive_invalid");inSegments=true;summary.segmentRows++;summary.segmentSeq=Math.max(summary.segmentSeq,Number(row.seq));segments.update(line+"\n");}
      account(line+"\n");
    }
    check(header&&trailer&&Object.entries(summary).every(([key,value])=>expected[key as keyof TranscriptArchiveSummary]===value),"archive_invalid");
    await rename(partial,output);return summary;
  }catch(error){await rm(partial,{force:true});if(signal?.aborted)throw new BackupVerificationError("interrupted");throw error instanceof BackupVerificationError?error:new BackupVerificationError("archive_invalid");}
}
/** Validate index paths before installing an untrusted captured index. */
export function validateBackupIndexListing(index:string):void {
  for(const entry of index.split("\0").filter(Boolean)){
        const match=/^([0-9]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);check(match&&match[1]!=="160000","git_invalid");
        const name=match[4]!;check(!name.startsWith("/")&&posix.normalize(name)===name&&!name.startsWith("../")&&!/[\x00-\x1f\\]/.test(name)&&!name.split("/").some(part=>part.toLowerCase()===".git"),"git_invalid");
      }
}
const DATABASE_CHECK=`const{DatabaseSync}=require('node:sqlite');const{createHash}=require('node:crypto');const db=new DatabaseSync(process.argv[1],{readOnly:true});try{db.exec('PRAGMA trusted_schema=OFF;PRAGMA cell_size_check=ON');const rows=db.prepare('PRAGMA integrity_check').all();if(rows.length!==1||rows[0].integrity_check!=='ok')process.exit(2);const meta=db.prepare("SELECT 1 FROM sqlite_master WHERE name='meta' AND type='table'").get();const schemaVersion=meta?Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value??1):1;const ddl=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name').all();process.stdout.write(JSON.stringify({schemaVersion,ddlDigest:createHash('sha256').update(JSON.stringify(ddl)).digest('hex')}));}finally{db.close();}`;
/** Read every captured file back through restic decryption; never touch source paths. */
export async function readBackCapture(record:BackupRecord,access:BackupRepositoryAccess,owner:BackupVerificationOwner,transcripts:VerifiedTranscriptObject[]=[]):Promise<VerifiedCaptureStage>{
  check(access.credentialRef.endsWith("-reader"),"authority_denied");
  check(record.machine===access.machine&&record.repository===access.repository&&id.test(record.manifestHash)&&id.test(record.snapshotId??"")&&pathValid(record.manifestPath)&&record.generation===record.operationId);
  const directory=await privateStage(owner);const restic=await transport(access,owner);
  try{
    const config=JSON.parse(await restic(["cat","config"])) as {id:string};check(id.test(config.id),"restore_failed");
    const manifestFile=join(directory,"manifest.json");await restic(["dump",record.snapshotId!,record.manifestPath],{output:manifestFile,limit:64*1024*1024});
    const manifest=parseManifest(await readFile(manifestFile),record,owner.maxRestoreBytes);
    let expandedBytes=manifest.bytes;
    for(const object of transcripts){check(Number.isSafeInteger(object.summary?.expandedBytes)&&object.summary.expandedBytes>=0,"archive_invalid");expandedBytes+=object.summary.expandedBytes;check(Number.isSafeInteger(expandedBytes)&&expandedBytes<=owner.maxRestoreBytes,"invalid_request");}
    let commonRoot=dirname(record.manifestPath);
    for(const entry of manifest.entries)while(entry.path!==commonRoot&&!entry.path.startsWith(commonRoot==="/"?"/":commonRoot+"/"))commonRoot=dirname(commonRoot);
    const archive=join(directory,"capture.tar");
    const archiveBudget=manifest.bytes+64*1024*1024+manifest.entries.length*2048;
    check(Number.isSafeInteger(archiveBudget)&&archiveBudget<=owner.maxRestoreBytes+128*1024*1024,"invalid_request");
    await restic(["dump",record.snapshotId!,commonRoot,"--archive","tar"],{output:archive,limit:archiveBudget});
    const wanted=new Map(manifest.entries.map(entry=>[entry.path,entry]));const seen=new Set<string>(),files=new Map<string,string>();
    const ancestors=new Set<string>();for(const path of wanted.keys())for(let parent=dirname(path);parent!=="/";parent=dirname(parent))ancestors.add(parent);
    const hardLinks:{path:string;target:string}[]=[];
    const pending:Promise<void>[]=[];let failure:unknown;await mkdir(join(directory,"objects"),{mode:0o700});
    const consume=async(entry:ReadEntry):Promise<void>=>{
      abort(owner);const name=entry.path.replace(/\/$/,"");
      if(name===""||name==="."){check(entry.type==="Directory","manifest_mismatch");entry.resume();return;}
      check(!name.startsWith("/")&&!/[\x00-\x1f\\]/.test(name)&&posix.normalize(name)===name&&!name.startsWith("../"),"manifest_mismatch");
      // restic uses relative short headers and absolute-without-slash PAX paths.
      const absolute="/"+name,prefix=commonRoot==="/"?"":posix.basename(commonRoot);
      let path:string;
      if(commonRoot==="/"||absolute===commonRoot||absolute.startsWith(commonRoot+"/"))path=absolute;
      else{check(name===prefix||name.startsWith(prefix+"/"),"manifest_mismatch");path=commonRoot+name.slice(prefix.length);}
      if(path===commonRoot){check(entry.type==="Directory","manifest_mismatch");entry.resume();return;}
      check(pathValid(path)&&!seen.has(path),"manifest_mismatch");seen.add(path);
      const expected=wanted.get(path);
      if(path===record.manifestPath){check(entry.type==="File"&&entry.size===(await lstat(manifestFile)).size,"manifest_mismatch");const digest=createHash("sha256");for await(const bytes of entry)digest.update(bytes);check(digest.digest("hex")===record.manifestHash,"manifest_mismatch");return;}
      if(!expected){check(entry.type==="Directory"&&ancestors.has(path),"manifest_mismatch");entry.resume();return;}
      check(((entry.mode??0)&0o7777)===expected.mode,"content_mismatch");
      if(expected.kind==="directory"){check(entry.type==="Directory","content_mismatch");entry.resume();return;}
      if(expected.kind==="symlink"){check(entry.type==="SymbolicLink"&&entry.linkpath===expected.target,"content_mismatch");entry.resume();return;}
      if(entry.type==="Link"){
        const prefix=commonRoot==="/"?"":posix.basename(commonRoot)+"/",link=entry.linkpath??"";
        check(!link.startsWith("/")&&posix.normalize(link)===link&&!link.startsWith("../")&&(!prefix||link.startsWith(prefix)||("/"+link).startsWith(commonRoot+"/")),"manifest_mismatch");
        const candidate="/"+link;
        const target=commonRoot==="/"||candidate.startsWith(commonRoot+"/")?candidate:commonRoot+"/"+link.slice(prefix.length);
        const original=wanted.get(target);check(original?.kind==="file"&&original.sha256===expected.sha256&&original.bytes===expected.bytes,"content_mismatch");hardLinks.push({path,target});entry.resume();return;
      }
      check(entry.type==="File"&&entry.size===expected.bytes,"content_mismatch");
      const output=join(directory,"objects",String(files.size)+".data");files.set(path,output);
      await pipeline(entry,createWriteStream(output,{flags:"wx",mode:0o600}),{signal:owner.signal});
      check((await lstat(output)).size===expected.bytes&&await hashFile(output,owner.signal)===expected.sha256,"content_mismatch");
    };
    await listTar({file:archive,strict:true,noResume:true,maxMetaEntrySize:1024*1024,onReadEntry:entry=>{const task=consume(entry).catch(error=>{failure??=error;entry.resume();});pending.push(task);}});
    await Promise.all(pending);if(failure)throw failure;
    while(hardLinks.length){const index=hardLinks.findIndex(link=>files.has(link.target));check(index>=0,"content_mismatch");const link=hardLinks.splice(index,1)[0]!;files.set(link.path,files.get(link.target)!);}
    check(seen.has(record.manifestPath),"manifest_mismatch");for(const entry of manifest.entries)if(entry.kind!=="directory")check(seen.has(entry.path),"content_mismatch");
    await rm(archive);
    const git=(args:string[],options:{inputFile?:string}={})=>runBackupTool(owner.tools.git,["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never",...args],processOwner(owner),{limit:64*1024*1024,...options});
    const repository=join(directory,"git-check");await git(["init","--bare",repository]);
    // Bundle is self-contained; pack also carries index/reflog/dangling objects.
    await git(["-C",repository,"-c","protocol.file.allow=always","fetch",files.get(manifest.git.bundle)!,"+refs/*:refs/*"]);
    await git(["-C",repository,"index-pack","--stdin"],{inputFile:files.get(manifest.git.objects)!});
    if(manifest.git.index){
      await copyFile(files.get(manifest.git.index)!,join(repository,"index"));
      const index=await git(["--git-dir="+repository,"ls-files","--stage","-z"]);
      validateBackupIndexListing(index);
    }
    if(manifest.git.headRef.startsWith("refs/heads/"))await git(["-C",repository,"symbolic-ref","HEAD",manifest.git.headRef]);
    else await git(["-C",repository,"update-ref","--no-deref","HEAD",manifest.git.head]);
    await git(["-C",repository,"fsck","--full"]);
    check(await git(["-C",repository,"for-each-ref","--format=%(objectname) %(refname)"])===manifest.git.refs,"git_invalid");
    const inventory=await git(["-C",repository,...(manifest.captureKind==="evicted_stash"?["rev-list","--objects","--all","--no-object-names"]:["cat-file","--batch-all-objects","--batch-check=%(objectname)"])]);
    check(backupDigest(inventory)===manifest.git.objectIdsHash,"git_invalid");
    for(const revision of [manifest.git.head,manifest.git.base])await git(["-C",repository,"cat-file","-e",revision+"^{commit}"]);
    let checkoutBytes=expandedBytes;
    for(const row of (await git(["-C",repository,"ls-tree","-r","-l","-z",manifest.git.head])).split("\0").filter(Boolean)){
      const columns=row.slice(0,row.indexOf("\t")).trim().split(/\s+/);check(columns[0]!=="160000","git_invalid");
      const bytes=Number(columns[3]);check(Number.isSafeInteger(bytes)&&bytes>=0,"git_invalid");checkoutBytes+=bytes;
      check(Number.isSafeInteger(checkoutBytes)&&checkoutBytes<=owner.maxRestoreBytes,"invalid_request");
    }
    for(const db of manifest.databases){
      try{const facts=JSON.parse(await runBackupTool(process.execPath,["-e",DATABASE_CHECK,files.get(db.backupPath)!],processOwner(owner))) as {schemaVersion:number;ddlDigest:string};check(facts.schemaVersion===db.schemaVersion&&facts.ddlDigest===db.ddlDigest,"database_invalid");}
      catch{throw new BackupVerificationError("database_invalid");}
    }
    for(const object of transcripts){check(files.has(object.sourcePath)&&object.ref===manifest.entries.find(entry=>entry.path===object.sourcePath)?.sha256&&object.bytes===manifest.entries.find(entry=>entry.path===object.sourcePath)?.bytes,"archive_invalid");await decodeTranscriptArchive(files.get(object.sourcePath)!,join(directory,object.ref+".jsonl"),object.identity,object.summary,object.summary.expandedBytes,owner.signal);}
    const stage={directory,manifest,record,files,repositoryId:config.id,transcripts};readbackProofs.set(stage,stageClaim(stage));return stage;
  }catch(error){await rm(directory,{recursive:true,force:true});throw error instanceof BackupVerificationError?error:new BackupVerificationError(owner.signal?.aborted?"interrupted":"restore_failed");}
}
/** Signing material is fetched only after all remote readback/decrypt checks passed. */
export async function signVerifiedCapture(stage:VerifiedCaptureStage,authority:BackupVerifierAuthority,owner:BackupVerificationOwner):Promise<VerifiedBackupReceipt>{
  check(readbackProofs.get(stage)===stageClaim(stage),"authority_denied");
  check(authority.id&&/^global\/fleet-backup-verifier-[A-Za-z0-9._-]+$/.test(authority.signingKeyRef),"authority_denied");check(authority.id!==stage.record.machine,"authority_denied");
  let key;try{const encoded=await resolveBackupSecret(processOwner(owner),authority.signingKeyRef,"signing_key_pkcs8_base64");key=createPrivateKey({key:Buffer.from(encoded,"base64"),format:"der",type:"pkcs8"});}catch{throw new BackupVerificationError("authority_denied");}
  check(key.asymmetricKeyType==="ed25519","authority_denied");const publicKey=createPublicKey(key).export({format:"der",type:"spki"}).toString("base64");
  check(backupVerifierKeyId(publicKey)===backupVerifierKeyId(owner.trustedPublicKey),"authority_denied");const m=stage.manifest;
  const payload:BackupVerificationPayload={format:"honeybee.verified-backup.v1",verification:"verified",machine:m.machine,cellId:m.cell.id,generation:m.generation,
    repository:stage.record.repository,repositoryId:stage.repositoryId,snapshotId:stage.record.snapshotId!,manifestPath:stage.record.manifestPath,manifestHash:stage.record.manifestHash,files:m.files,bytes:m.bytes,
    git:{head:m.git.head,base:m.git.base},databases:m.databases.map(db=>({sha256:db.sha256,schemaVersion:db.schemaVersion,ddlDigest:db.ddlDigest,integrityCheck:"ok"})),transcripts:stage.transcripts,
    verifier:{id:authority.id,keyId:backupVerifierKeyId(publicKey)},verifiedAt:new Date().toISOString()};
  const receipt={payload,signature:sign(null,Buffer.from(canonicalBackupJson(payload)),key).toString("base64")};return verifyBackupReceipt(receipt,owner.trustedPublicKey);
}
function sameCatalogueCapture(a:RecoveryCatalogue,b:RecoveryCatalogue):boolean {
  const claim=(entry:RecoveryCatalogue)=>canonicalBackupJson({...entry.receipt.payload,verifiedAt:""});
  return claim(a)===claim(b);
}
function boundCatalogue(entry:RecoveryCatalogue,repository:string,machine:string,repositoryId:string,key:string):void {
  check(entry?.format==="honeybee.recovery-catalogue.v1","receipt_invalid");
  const receipt=verifyBackupReceipt(entry.receipt,key),p=receipt.payload,r=entry.record;
  check(r&&p.machine===machine&&r.machine===p.machine&&r.cellId===p.cellId&&r.generation===p.generation&&r.operationId===p.generation&&r.manifestPath===p.manifestPath&&r.manifestHash===p.manifestHash&&r.snapshotId===p.snapshotId&&r.repository===repository&&p.repository===repository&&p.repositoryId===repositoryId,"receipt_invalid");
}
function earlierCatalogue(a:RecoveryCatalogue,b:RecoveryCatalogue):RecoveryCatalogue {
  return a.receipt.payload.verifiedAt<b.receipt.payload.verifiedAt?a:a.receipt.payload.verifiedAt>b.receipt.payload.verifiedAt?b:canonicalBackupJson(a)<canonicalBackupJson(b)?a:b;
}
export async function publishRecoveryCatalogue(record:BackupRecord,receipt:VerifiedBackupReceipt,access:BackupRepositoryAccess,owner:BackupVerificationOwner):Promise<string>{
  check(access.credentialRef.endsWith("-catalogue-writer"),"authority_denied");
  verifyBackupReceipt(receipt,owner.trustedPublicKey);check(record.machine===access.machine&&record.manifestHash===receipt.payload.manifestHash&&record.generation===receipt.payload.generation&&record.snapshotId===receipt.payload.snapshotId&&record.repository===access.repository,"receipt_invalid");
  const restic=await transport(access,owner);const config=JSON.parse(await restic(["cat","config"])) as {id:string};check(config.id===receipt.payload.repositoryId,"receipt_invalid");
  const stableRecord={...record,format:"honeybee.backup-draft.v1" as const,verification:"not_verified" as const};delete stableRecord.receipt;delete stableRecord.processIdentity;delete stableRecord.checkpointRetired;
  const entry:RecoveryCatalogue={format:"honeybee.recovery-catalogue.v1",record:stableRecord,receipt};const body=canonicalBackupJson(entry)+"\n";
  const tag=CATALOGUE_TAG+":"+record.generation;const existing=JSON.parse(await restic(["snapshots","--json","--tag",tag])) as {id:string}[];
  let previous: {snapshot:string;entry:RecoveryCatalogue}|undefined;
  for(const snapshot of existing){
    let saved:RecoveryCatalogue;try{saved=JSON.parse(await restic(["dump",snapshot.id,CATALOGUE_PATH]));boundCatalogue(saved,access.repository,access.machine,config.id,owner.trustedPublicKey);}catch{continue;}
    check(sameCatalogueCapture(saved,entry),"catalogue_conflict");
    if(!previous||earlierCatalogue(previous.entry,saved)===saved)previous={snapshot:snapshot.id,entry:saved};
  }
  if(previous)return previous.snapshot;
  const output=await restic(["backup","--json","--stdin","--stdin-filename",CATALOGUE_PATH,"--tag",CATALOGUE_TAG,"--tag",tag],{input:body});
  const summary=output.trim().split("\n").map(line=>JSON.parse(line) as {message_type:string;snapshot_id?:string}).find(row=>row.message_type==="summary");check(id.test(summary?.snapshot_id??""),"restore_failed");
  check(await restic(["dump",summary!.snapshot_id!,CATALOGUE_PATH])===body,"content_mismatch");return summary!.snapshot_id!;
}
/** Bootstrap from the repository alone. A pinned verifier public key prevents accepting an uploader's replacement authority. */
export async function discoverRecoveryCatalogue(generation:string,access:BackupRepositoryAccess,owner:BackupVerificationOwner):Promise<RecoveryCatalogue>{
  check(access.credentialRef.endsWith("-reader"),"authority_denied");
  check(/^[A-Za-z0-9._-]{1,128}$/.test(generation));const restic=await transport(access,owner);const config=JSON.parse(await restic(["cat","config"])) as {id:string};
  const snapshots=JSON.parse(await restic(["snapshots","--json","--tag",CATALOGUE_TAG+":"+generation])) as {id:string}[];let found:RecoveryCatalogue|undefined;
  for(const snapshot of snapshots){
    let entry:RecoveryCatalogue;try{entry=JSON.parse(await restic(["dump",snapshot.id,CATALOGUE_PATH]));boundCatalogue(entry,access.repository,access.machine,config.id,owner.trustedPublicKey);check(entry.receipt.payload.generation===generation,"receipt_invalid");}catch{continue;}
    if(found){check(sameCatalogueCapture(found,entry),"catalogue_conflict");found=earlierCatalogue(found,entry);}else found=entry;
  }
  check(found,"catalogue_missing");return found!;
}
export async function restoreFromCatalogue(generation:string,access:BackupRepositoryAccess,owner:BackupVerificationOwner):Promise<VerifiedCaptureStage>{
  const catalogue=await discoverRecoveryCatalogue(generation,access,owner);return readBackCapture(catalogue.record,access,owner,catalogue.receipt.payload.transcripts);
}
export async function handoffTranscriptStage(stage:VerifiedCaptureStage,receipt:VerifiedBackupReceipt,ref:string,owner:BackupVerificationOwner,accept?:TranscriptStageOwner):Promise<TranscriptStageAcceptance>{
  check(readbackProofs.get(stage)===stageClaim(stage),"receipt_invalid");
  verifyBackupReceipt(receipt,owner.trustedPublicKey);check(receipt.payload.generation===stage.record.generation&&receipt.payload.manifestHash===stage.record.manifestHash,"receipt_invalid");
  const object=receipt.payload.transcripts.find(item=>item.ref===ref);check(object,"archive_invalid");const compressedPath=stage.files.get(object!.sourcePath);check(compressedPath,"archive_invalid");
  check(await hashFile(compressedPath!,owner.signal)===ref&&(await lstat(compressedPath!)).size===object!.bytes,"archive_invalid");
  const decodedPath=join(stage.directory,ref+".handoff.jsonl");await decodeTranscriptArchive(compressedPath!,decodedPath,object!.identity,object!.summary,object!.summary.expandedBytes,owner.signal);
  if(!accept)throw new BackupVerificationError("owner_unavailable");
  const result=await accept({format:"honeybee.apiary-transcript-stage.v1",receipt,object:object!,compressedPath:compressedPath!,decodedPath});
  check(result?.accepted===true&&result.ownerNodeId===object!.identity.nodeId&&result.objectRef===ref&&typeof result.receiptId==="string"&&result.receiptId.length>0,"owner_unavailable");return result;
}

/** Restore only into a fresh stage; absolute source names are mapped below that stage. */
export async function materializeVerifiedCapture(stage:VerifiedCaptureStage,owner:BackupVerificationOwner):Promise<string>{
  check(readbackProofs.get(stage)===stageClaim(stage),"receipt_invalid");const tree=join(stage.directory,"tree");await mkdir(tree,{mode:0o700});
  const target=(source:string)=>join(tree,source.slice(1));
  // All file parents are checked against the manifest before any symlink is installed.
  for(const entry of stage.manifest.entries.filter(entry=>entry.kind!=="symlink")){
    if(entry.path===stage.manifest.git.index)continue;
    const path=target(entry.path);await mkdir(dirname(path),{recursive:true,mode:0o700});
    if(entry.kind==="directory"){await mkdir(path,{recursive:true,mode:0o700});continue;}
    check(await hashFile(stage.files.get(entry.path)!,owner.signal)===entry.sha256,"content_mismatch");await copyFile(stage.files.get(entry.path)!,path);await chmod(path,entry.mode);
  }
  for(const entry of stage.manifest.entries.filter(entry=>entry.kind==="symlink")){await mkdir(dirname(target(entry.path)),{recursive:true,mode:0o700});await symlink(entry.target!,target(entry.path));}
  const finishModes=async()=>{for(const entry of [...stage.manifest.entries].reverse().filter(entry=>entry.kind==="directory"))await chmod(target(entry.path),entry.mode);};
  const m=stage.manifest;const cell=join(stage.directory,"recovered-cell");
  const git=(args:string[],inputFile?:string)=>runBackupTool(owner.tools.git,["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false","-c","protocol.allow=never",...args],processOwner(owner),{inputFile});
  if(m.captureKind==="retained_checkout"){
    // The tree contains the captured index, but no active Git config or hooks.
    const worktree=target(m.cell.spaceDir);const info=await lstat(worktree);check(info.isDirectory()&&!info.isSymbolicLink()&&await realpath(worktree)===worktree&&worktree.startsWith(tree+"/"),"manifest_mismatch");await git(["-C",worktree,"init"]);
    const gitDir=join(worktree,".git");
    await git(["--git-dir="+gitDir,"--work-tree="+worktree,"-c","protocol.file.allow=always","fetch","--update-head-ok",stage.files.get(m.git.bundle)!,"+refs/*:refs/*"]);
    await git(["--git-dir="+gitDir,"--work-tree="+worktree,"index-pack","--stdin"],stage.files.get(m.git.objects)!);
    if(m.git.headRef.startsWith("refs/heads/"))await git(["--git-dir="+gitDir,"--work-tree="+worktree,"symbolic-ref","HEAD",m.git.headRef]);else await git(["--git-dir="+gitDir,"--work-tree="+worktree,"update-ref","--no-deref","HEAD",m.git.head]);
    await git(["--git-dir="+gitDir,"--work-tree="+worktree,"fsck","--full"]);
    if(m.git.index){await copyFile(stage.files.get(m.git.index)!,join(gitDir,"index"));await chmod(join(gitDir,"index"),m.entries.find(entry=>entry.path===m.git.index)!.mode);}
    await finishModes();return worktree;
  }
  await git(["-c","protocol.file.allow=always","clone",stage.files.get(m.git.bundle)!,cell]);
  await git(["-C",cell,"checkout","--detach",m.git.head]);
  // Keep path is discovered from the captured sibling manifest rather than a live source root.
  const keepRoot=join(dirname(dirname(dirname(m.cell.spaceDir))),"cell-keep",m.cell.spaceName);
  const keepManifest=m.entries.find(entry=>entry.kind==="file"&&entry.path===keepRoot+".json");
  check(keepManifest,"manifest_mismatch");
  for(const entry of m.entries.filter(entry=>entry.path.startsWith(keepRoot+"/"))){
    const path=join(cell,relative(keepRoot,entry.path));
    for(let parent=dirname(path);parent!==cell;parent=dirname(parent)){
      const info=await lstat(parent).catch(error=>{if(error.code==="ENOENT")return null;throw error;});check(!info||(!info.isSymbolicLink()&&info.isDirectory()),"manifest_mismatch");
    }
    const existing=await lstat(path).catch(error=>{if(error.code==="ENOENT")return null;throw error;});check(!existing||(entry.kind==="directory"&&existing.isDirectory()&&!existing.isSymbolicLink()),"manifest_mismatch");
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    if(entry.kind==="directory"){await mkdir(path,{recursive:true,mode:0o700});}
    else if(entry.kind==="symlink")await symlink(entry.target!,path);
    else{await copyFile(stage.files.get(entry.path)!,path);await chmod(path,entry.mode);}
  }
  for(const entry of [...m.entries].reverse().filter(entry=>entry.kind==="directory"&&entry.path.startsWith(keepRoot+"/")))await chmod(join(cell,relative(keepRoot,entry.path)),entry.mode);
  await git(["-C",cell,"fsck","--full"]);await finishModes();return cell;
}


export async function verifyAndCatalogue(record:BackupRecord,readAccess:BackupRepositoryAccess,catalogueAccess:BackupRepositoryAccess,authority:BackupVerifierAuthority,owner:BackupVerificationOwner,transcripts:VerifiedTranscriptObject[]=[]):Promise<{stage:VerifiedCaptureStage;receipt:VerifiedBackupReceipt;catalogueSnapshot:string}>{
  const stage=await readBackCapture(record,readAccess,owner,transcripts);
  try {
  let receipt:VerifiedBackupReceipt|undefined;
  try{
    const existing=await discoverRecoveryCatalogue(record.generation,readAccess,owner);
    check(existing.record.snapshotId===record.snapshotId&&existing.record.manifestHash===record.manifestHash&&canonicalBackupJson(existing.receipt.payload.transcripts)===canonicalBackupJson(transcripts),"catalogue_conflict");
    receipt=existing.receipt;
  }catch(error){if(!(error instanceof BackupVerificationError)||error.code!=="catalogue_missing")throw error;}
  receipt??=await signVerifiedCapture(stage,authority,owner);
  const catalogueSnapshot=await publishRecoveryCatalogue(record,receipt,catalogueAccess,owner);
  const catalogued=await discoverRecoveryCatalogue(record.generation,readAccess,owner);
  return{stage,receipt:catalogued.receipt,catalogueSnapshot};
  } catch(error) {await disposeVerifiedCapture(stage);throw error;}
}

/** Caller releases only a stage created by this verifier, never an arbitrary path. */
export async function disposeVerifiedCapture(stage:VerifiedCaptureStage):Promise<void>{
  check(readbackProofs.get(stage)===stageClaim(stage),"invalid_request");await rm(stage.directory,{recursive:true,force:true});readbackProofs.delete(stage);
}

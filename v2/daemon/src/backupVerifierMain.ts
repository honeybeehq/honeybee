import {createBackupVerifierGateway} from "./backupVerifierGateway.ts";
/** Standalone independent-authority service entrypoint; never loaded by the uploading daemon. */
import { readFile, writeFile } from "node:fs/promises";
import { resolveExecutable } from "../../core/src/executables.ts";
import type { BackupRecord } from "./backupCapture.ts";
import { BackupVerificationError, disposeVerifiedCapture, verifyAndCatalogue, discoverRecoveryCatalogue, handoffTranscriptStage, materializeVerifiedCapture, publishRecoveryCatalogue, readBackCapture, signVerifiedCapture, type BackupRepositoryAccess, type BackupVerificationOwner, type BackupVerifierAuthority } from "./backupVerification.ts";
import type { VerifiedTranscriptObject } from "../../core/src/backupReceipt.ts";

async function main():Promise<void>{
  const args=process.argv.slice(2),command=args[0];const value=(flag:string)=>{const index=args.indexOf(flag);if(index<0||!args[index+1])throw new BackupVerificationError("invalid_request");return args[index+1]!;};
  const config=JSON.parse(await readFile(value("--config"),"utf8")) as {role:string;access:BackupRepositoryAccess;catalogueAccess?:BackupRepositoryAccess;owner:Omit<BackupVerificationOwner,"tools"|"resolveSecret">;authority?:BackupVerifierAuthority;gateway?:{tokenRef:string;port:number}};
  if(!["independent-verifier","recovery"].includes(config.role))throw new BackupVerificationError("authority_denied");
  const executable=(name:string)=>{const path=resolveExecutable(name)?.path;if(!path)throw new BackupVerificationError("invalid_request");return path;};
  const owner:BackupVerificationOwner={...config.owner,tools:{git:executable("git"),restic:executable("restic"),hem:executable("hem")}};
  if(command==="serve"){
    if(config.role!=="independent-verifier"||!config.authority||!config.catalogueAccess||!config.gateway||!/^global\/fleet-backup-[A-Za-z0-9._-]+-verify$/.test(config.gateway.tokenRef))throw new BackupVerificationError("authority_denied");
    const server=createBackupVerifierGateway({tokenRef:config.gateway.tokenRef,access:config.access,catalogueAccess:config.catalogueAccess,authority:config.authority},owner);
    server.listen(config.gateway.port,"127.0.0.1");return;
  }
  if(command==="verify"){
    if(config.role!=="independent-verifier"||!config.authority||!config.catalogueAccess)throw new BackupVerificationError("authority_denied");
    const record=JSON.parse(await readFile(value("--record"),"utf8")) as BackupRecord;
    const descriptorArg=args.indexOf("--transcripts");const transcripts:VerifiedTranscriptObject[]=descriptorArg<0?[]:JSON.parse(await readFile(value("--transcripts"),"utf8"));
    const {stage,receipt,catalogueSnapshot,publication}=await verifyAndCatalogue(record,config.access,config.catalogueAccess,config.authority,owner,transcripts);
    try {
      const result={status:"verified",receipt,catalogueSnapshot,publication};await writeFile(value("--output"),JSON.stringify(result)+"\n",{flag:"wx",mode:0o600});
      process.stdout.write(JSON.stringify({status:"verified",generation:record.generation,catalogueSnapshot})+"\n");
    } finally {await disposeVerifiedCapture(stage);}return;
  }
  if(command==="restore"){
    const catalogue=await discoverRecoveryCatalogue(value("--generation"),config.access,owner);
    const stage=await readBackCapture(catalogue.record,config.access,owner,catalogue.receipt.payload.transcripts);
    const path=await materializeVerifiedCapture(stage,owner);process.stdout.write(JSON.stringify({status:"restored",path,generation:catalogue.record.generation})+"\n");return;
  }
  throw new BackupVerificationError("invalid_request");
}
main().catch(error=>{process.stderr.write(JSON.stringify({status:"failed",reason:error instanceof BackupVerificationError?error.code:"verification_failed"})+"\n");process.exitCode=2;});

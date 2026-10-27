/** Public binding between a verified capture and the encrypted catalogue snapshot. */
import { createPublicKey, verify } from "node:crypto";
import { backupDigest, backupVerifierKeyId, canonicalBackupJson, verifyBackupReceipt, type VerifiedBackupReceipt } from "./backupReceipt.ts";
export interface BackupPublicationPayload {format:"honeybee.catalogue-publication.v1";keyId:string;repository:string;repositoryId:string;snapshotId:string;catalogueSnapshotId:string;receiptHash:string;publishedAt:string}
export interface BackupPublication {payload:BackupPublicationPayload;signature:string}
export function verifyBackupPublication(value:unknown,receipt:VerifiedBackupReceipt,publicKey:string):BackupPublication{
 try{verifyBackupReceipt(receipt,publicKey);const row=value as BackupPublication,p=row.payload;
 if(p.format!=="honeybee.catalogue-publication.v1"||p.keyId!==backupVerifierKeyId(publicKey)||p.repository!==receipt.payload.repository||p.repositoryId!==receipt.payload.repositoryId||p.snapshotId!==receipt.payload.snapshotId||p.receiptHash!==backupDigest(canonicalBackupJson(receipt))||!Number.isFinite(Date.parse(p.publishedAt))||!(/^[a-f0-9]{64}$/).test(p.catalogueSnapshotId))throw 0;
 const signature=Buffer.from(row.signature,"base64");if(signature.length!==64||signature.toString("base64")!==row.signature||!verify(null,Buffer.from(canonicalBackupJson(p)),createPublicKey({key:Buffer.from(publicKey,"base64"),format:"der",type:"spki"}),signature))throw 0;
 return{payload:JSON.parse(canonicalBackupJson(p)) as BackupPublicationPayload,signature:row.signature};
 }catch{throw new Error("publication_untrusted");}
}

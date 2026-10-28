/** Signed read-side facts. Neither an uploader nor a UI can mint verifier claims. */
import {createPublicKey,verify} from 'node:crypto';
import {backupDigest,backupVerifierKeyId,canonicalBackupJson} from './backupReceipt.ts';
import type {BackupCapacityObservation,BackupIntegrityHold} from './backupService.ts';
export interface BackupCapacityPayload {format:'honeybee.backup-capacity.v1';machine:string;repository:string;epoch:string;sequence:number;holds:BackupIntegrityHold[];integrityEvents:BackupIntegrityHold[];observation:BackupCapacityObservation;issuedAt:number;accounting:{basis:'logical-manifest-bytes';pinnedBytes:number;retainedBytes:number;fleetPinnedBytes:number;fleetRetainedBytes:number;complete:boolean};}
export interface BackupCapacityAttestation {payload:BackupCapacityPayload;signature:string}
export interface BackupRestoreDrillPayload {format:'honeybee.restore-drill.v1';id:string;machine:string;cellId:string;generation:string;repositoryId:string;snapshotId:string;manifestHash:string;catalogueSnapshotId:string;receiptHash:string;checkedAt:string;result:'passed'|'failed';sourceUnavailable:boolean;checks:{files:number;bytes:number;gitFsck:'ok'|'failed';databases:'ok'|'failed';manifest:'ok'|'failed'};evidenceHash:string;verifier:{id:string;keyId:string}}
export interface BackupRestoreDrill {payload:BackupRestoreDrillPayload;signature:string}
function checked<T extends {payload:unknown;signature:string}>(value:T,key:string):T{
 const bytes=Buffer.from(value.signature,'base64');if(bytes.length!==64||bytes.toString('base64')!==value.signature||!verify(null,Buffer.from(canonicalBackupJson(value.payload)),createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'}),bytes))throw Error('invalid_signed_backup_fact');
 return JSON.parse(canonicalBackupJson({payload:value.payload,signature:value.signature})) as T;
}
export function verifyBackupCapacity(value:BackupCapacityAttestation,key:string,machine:string,repository:string):BackupCapacityAttestation{
 const v=checked(value,key),p=v.payload,o=p.observation,a=p.accounting;
 if(p.format!=='honeybee.backup-capacity.v1'||typeof p.epoch!=='string'||!/^[a-f0-9-]{36}$/.test(p.epoch)||p.machine!==machine||p.repository!==repository||o.repository!==repository||!Number.isSafeInteger(p.sequence)||p.sequence<1||!Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(o.observedAt)||!['normal','warn','review','stop','unknown'].includes(o.band)||a.basis!=='logical-manifest-bytes'||typeof a.complete!=='boolean')throw Error('invalid_signed_backup_fact');
 if(!Array.isArray(p.integrityEvents)||p.integrityEvents.length>10000||p.integrityEvents.some(h=>typeof h.held!=='boolean'||h.repository!==repository||!['check_failed','drill_failed'].includes(h.reason)||typeof h.blockUploads!=='boolean'||!Number.isSafeInteger(h.order)||!Number.isSafeInteger(h.at)))throw Error('invalid_signed_backup_fact');
 if(!Array.isArray(p.holds)||p.holds.length>10000||p.holds.some(h=>!h.held||h.repository!==repository||!['check_failed','drill_failed'].includes(h.reason)||typeof h.blockUploads!=='boolean'||!Number.isSafeInteger(h.order)||!Number.isSafeInteger(h.at)))throw Error('invalid_signed_backup_fact');
 for(const n of[o.repositoryBytes,o.repositoryLimitBytes,o.fleetBytes,o.fleetLimitBytes,o.reserveBytes,o.reserveLimitBytes,a.pinnedBytes,a.retainedBytes,a.fleetPinnedBytes,a.fleetRetainedBytes])if(!Number.isSafeInteger(n)||n<0)throw Error('invalid_signed_backup_fact');return v;
}
export function verifyBackupRestoreDrill(value:BackupRestoreDrill,key:string):BackupRestoreDrill{
 const v=checked(value,key),p=v.payload;
 if(p.format!=='honeybee.restore-drill.v1'||!['passed','failed'].includes(p.result)||typeof p.sourceUnavailable!=='boolean'||!Number.isFinite(Date.parse(p.checkedAt))||new Date(p.checkedAt).toISOString()!==p.checkedAt||p.verifier.keyId!==backupVerifierKeyId(key))throw Error('invalid_restore_drill');
 if(!p.checks||![p.checks.files,p.checks.bytes].every(n=>Number.isSafeInteger(n)&&n>=0)||![p.checks.gitFsck,p.checks.databases,p.checks.manifest].every(s=>['ok','failed'].includes(s))||p.result==='passed'&&[p.checks.gitFsck,p.checks.databases,p.checks.manifest].some(s=>s!=='ok'))throw Error('invalid_restore_drill');
 for(const s of[p.id,p.machine,p.cellId,p.generation,p.verifier.id])if(typeof s!=='string'||!s.length||s.length>512)throw Error('invalid_restore_drill');
 for(const s of[p.repositoryId,p.snapshotId,p.manifestHash,p.catalogueSnapshotId,p.receiptHash,p.evidenceHash])if(!/^[a-f0-9]{64}$/.test(s))throw Error('invalid_restore_drill');return v;
}
export const backupFactId=(value:unknown)=>backupDigest(canonicalBackupJson(value));

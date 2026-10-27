import {isAbsolute,normalize} from "node:path";
import {createPublicKey} from "node:crypto";
import type { BackupRetentionPolicy } from "../../core/src/backupService.ts";
import type { BackupMailConfig } from "./backupMail.ts";
export interface BackupTarget {cellId:string;periodMs:number;jitterMs:number}
export interface BackupMachineConfig {version:1;role:"machine";machine:string;repository:string;authorityUrl:string;authorityRef:string;grantPublicKey:string;verifierUrl:string;verifierRef:string;targets:BackupTarget[];mail:BackupMailConfig;maxReceiptAgeMs:number;observationMaxAgeMs:number;maxAttempts?:number}
export interface BackupAuthorityRepository {machine:string;repository:string;root:string;limitBytes:number;periodMs:number;jitterMs:number;slotWaitMs:number}
export interface BackupAuthorityConfig {version:1;role:"authority";listenPort:number;machine:string;backupRoot:string;reserveRoot:string;fleetLimitBytes:number;reserveLimitBytes:number;repositories:BackupAuthorityRepository[];retention:BackupRetentionPolicy;mail:BackupMailConfig;trustedVerifierKeys:Record<string,string>;grantKeyRef:string;grantPublicKey:string;maintenance:{checkEveryMs:number;pruneEveryMs:number;maxRepackBytes:number;maxDeleteBytes:number;maxDurationMs:number;grantTtlMs:number;checkReadBytes:number;endpoint:string;backendUrl:string;backendCommand:string;accessKeyRef:string};bootstrap?:{repository:string;inventoryHash:string;pinIds:string[];approvedAt:number;approvedBy:string}[];principals:{id:string;role:"machine"|"executor";repository:string;tokenRef:string}[]}
export interface BackupExecutorConfig {version:1;role:"executor";machine:string;authorityUrl:string;authorityRef:string;grantPublicKey:string;repositories:{repository:string;repositoryId:string;passwordRef:string;readerRef:string}[];stageRoot:string;mail:BackupMailConfig}
export type BackupServiceConfig=BackupMachineConfig|BackupAuthorityConfig|BackupExecutorConfig;
export function validateBackupEndpoint(value:string):void{let url:URL;try{url=new URL(value);}catch{throw new Error('invalid_config');}if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw new Error('invalid_config');}
export function validateBackupServiceConfig(value:unknown):BackupServiceConfig{
 const c=value as BackupServiceConfig;if(!c||c.version!==1||!['machine','authority','executor'].includes(c.role)||typeof c.machine!=='string'||!c.machine||c.machine.length>128)throw new Error('invalid_config');
 if(c.role==='machine'){
  validateBackupEndpoint(c.authorityUrl);validateBackupEndpoint(c.verifierUrl);if(!/^global\/fleet-backup-[A-Za-z0-9._-]+-service$/.test(c.authorityRef)||!/^global\/fleet-backup-[A-Za-z0-9._-]+-verify$/.test(c.verifierRef)||!Array.isArray(c.targets)||!c.targets.length||c.targets.length>1000)throw new Error('invalid_config');
  for(const t of c.targets)if(typeof t.cellId!=='string'||!t.cellId||!Number.isSafeInteger(t.periodMs)||t.periodMs<1||!Number.isSafeInteger(t.jitterMs)||t.jitterMs<0||t.jitterMs>=t.periodMs)throw new Error('invalid_config');
  if(!Number.isSafeInteger(c.maxReceiptAgeMs)||c.maxReceiptAgeMs<1||c.maxReceiptAgeMs>86400000||!Number.isSafeInteger(c.observationMaxAgeMs)||c.observationMaxAgeMs<1||c.observationMaxAgeMs>300000)throw new Error('invalid_config');
 }else if(c.role==='authority'){
  if(!Array.isArray(c.repositories)||!c.repositories.length||c.fleetLimitBytes!==24000000000000||c.reserveLimitBytes!==6000000000000||c.repositories.reduce((n,r)=>n+r.limitBytes,0)>c.fleetLimitBytes)throw new Error('invalid_config');
  for(const r of c.repositories)if(!r.repository.startsWith('rest:')||!r.root.startsWith('/')||!Number.isSafeInteger(r.limitBytes)||r.limitBytes<1||!Number.isSafeInteger(r.periodMs)||r.periodMs<1||!Number.isSafeInteger(r.jitterMs)||r.jitterMs<0||!Number.isSafeInteger(r.slotWaitMs)||r.slotWaitMs<0)throw new Error('invalid_config');
  if(!c.backupRoot.startsWith('/')||!c.reserveRoot.startsWith('/')||c.maintenance.maxRepackBytes<1||c.maintenance.maxRepackBytes>10*1024**3||c.maintenance.maxDurationMs<1||c.maintenance.maxDurationMs>3600000)throw new Error('invalid_config');
  validateBackupEndpoint(c.maintenance.endpoint.replace(/^rest:/,''));validateBackupEndpoint(c.maintenance.backendUrl);if(!/^global\/fleet-backup-maintenance-authorizer-[A-Za-z0-9._-]+$/.test(c.grantKeyRef)||!/^global\/fleet-backup-maintenance-access-[A-Za-z0-9._-]+$/.test(c.maintenance.accessKeyRef))throw new Error('invalid_config');
 }else{validateBackupEndpoint(c.authorityUrl);if(!c.stageRoot.startsWith('/')||!Array.isArray(c.repositories)||!c.repositories.length)throw new Error('invalid_config');}
 const path=(p:string)=>typeof p==='string'&&isAbsolute(p)&&p!=="/"&&normalize(p)===p&&!/[\x00-\x1f]/.test(p);
 const integer=(n:number,min=1,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
 const repository=(r:string)=>{if(typeof r!=="string"||!r.startsWith("rest:"))throw new Error("invalid_config");validateBackupEndpoint(r.slice(5));if(!/^\/[A-Za-z0-9._/-]+\/$/.test(new URL(r.slice(5)).pathname)||new URL(r.slice(5)).pathname.split('/').includes('..'))throw new Error("invalid_config");};
 try{if(createPublicKey({key:Buffer.from(c.grantPublicKey,'base64'),format:'der',type:'spki'}).asymmetricKeyType!=='ed25519')throw 0;}catch{throw new Error('invalid_config');}
 const m=c.mail;if(!m||!integer(m.port,1,65535)||typeof m.host!=='string'||!m.host||typeof m.secure!=='boolean'||!/^global\/fleet-backup-alert-[A-Za-z0-9._-]+$/.test(m.recipientRef)||!/^global\/fleet-backup-mail-[A-Za-z0-9._-]+$/.test(m.credentialRef))throw new Error('invalid_config');
 if(c.role==='machine'){if(c.maxAttempts!==undefined&&!integer(c.maxAttempts,1,100))throw new Error('invalid_config');repository(c.repository);if(new Set(c.targets.map(t=>t.cellId)).size!==c.targets.length)throw new Error('invalid_config');}
 if(c.role==='authority'){
  if(!path(c.backupRoot)||!path(c.reserveRoot)||!integer(c.listenPort,1,65535)||!path(c.maintenance.backendCommand)||!c.principals.length||!integer(c.maintenance.maxDeleteBytes)||!integer(c.maintenance.checkReadBytes)||!integer(c.maintenance.grantTtlMs,300,300000)||!integer(c.maintenance.checkEveryMs)||!integer(c.maintenance.pruneEveryMs))throw new Error('invalid_config');
  for(const r of c.repositories){repository(r.repository);if(!path(r.root)||!r.root.startsWith(c.backupRoot+'/'))throw new Error('invalid_config');}
  if(new Set(c.repositories.map(r=>r.repository)).size!==c.repositories.length||new Set(c.repositories.map(r=>r.machine)).size!==c.repositories.length)throw new Error('invalid_config');
  for(const n of[c.retention.hourly,c.retention.daily,c.retention.weekly,c.retention.monthly])if(!integer(n,0,10000))throw new Error('invalid_config');
  if(!integer(c.retention.quarantineMs,0)||!integer(c.retention.maxReceiptAgeMs,1,86400000))throw new Error('invalid_config');
  if(new Set(c.principals.map(p=>p.id)).size!==c.principals.length||new Set(c.principals.map(p=>p.tokenRef)).size!==c.principals.length)throw new Error('invalid_config');for(const principal of c.principals)if(!['machine','executor'].includes(principal.role)||!c.repositories.some(r=>r.repository===principal.repository)||!/^global\/fleet-backup-[A-Za-z0-9._-]+-(?:service|maintenance)$/.test(principal.tokenRef))throw new Error('invalid_config');
 }if(c.role==='executor'){
  if(!path(c.stageRoot)||!/^global\/fleet-backup-[A-Za-z0-9._-]+-maintenance$/.test(c.authorityRef))throw new Error('invalid_config');
  for(const r of c.repositories){repository(r.repository);if(!/^[a-f0-9]{64}$/.test(r.repositoryId)||!/^global\/fleet-backup-[A-Za-z0-9._-]+-repo-key$/.test(r.passwordRef)||!/^global\/fleet-backup-[A-Za-z0-9._-]+-reader$/.test(r.readerRef))throw new Error('invalid_config');}
 }
 return c;
}
/** Approved defaults are serialized into installation config, never forced over operator values. */
export const DEFAULT_BACKUP_RETENTION:BackupRetentionPolicy={hourly:48,daily:30,weekly:12,monthly:12,quarantineMs:86400000,maxReceiptAgeMs:86400000};

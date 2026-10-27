import type {BackupCapacityAttestation,BackupRestoreDrill} from './backupClientFacts.ts';
import type {VerifiedBackupReceipt} from "./backupReceipt.ts";
import type {BackupPublication} from "./backupPublication.ts";
/** Durable machine/service facts. Scheduling does not create a bee or own Cell lifecycle. */
export const BACKUP_JOB_STATES=["queued","uploading","verifying","retry_wait","succeeded","failed","skipped_busy"] as const;
export type BackupJobState=typeof BACKUP_JOB_STATES[number];
export type BackupCapacityBand="normal"|"warn"|"review"|"stop"|"unknown";
export interface BackupCapacityObservation {repository:string;repositoryId:string|null;observedAt:number;repositoryBytes:number;repositoryLogicalBytes?:number;logicalInventoryComplete?:boolean;repositoryLimitBytes:number;fleetBytes:number;fleetLimitBytes:number;reserveBytes:number;reserveLimitBytes:number;band:BackupCapacityBand}
export interface BackupServiceJob {id:string;repository:string;cellId:string;period:number;operationKey:string;state:BackupJobState;attempt:number;startedAt:number|null;updatedAt:number;retryAt:number;reason:string|null;snapshotId:string|null;generation:string|null;leaseId:string|null;leaseCounter:number|null;reportPending?:{receipt:VerifiedBackupReceipt;publication:BackupPublication}|null;reportedAt?:number|null;deferrals?:number}
export interface BackupServiceAlert {id:string;code:"capacity_warn"|"capacity_review"|"capacity_stop"|"capacity_unknown"|"overdue"|"job_failed"|"maintenance_failed"|"maintenance_stuck"|"protected_missing"|"unverified_snapshots"|"protected_key_held"|"writer_fence_failed"|"permissions_invalid";machine:string;repository:string;createdAt:number;state:"pending"|"sending"|"sent";attempts:number;nextAttemptAt:number;messageId:string;sentAt:number|null;phase?:string}
export interface BackupFleetLease {id:string;counter:number;jobId:string;repository:string;machine:string;role:"upload"|"maintenance";createdAt:number;heartbeatAt:number;state:"held"|"unknown"}
export interface BackupArrival {repository:string;snapshotId:string;firstSeenAt:number;bytes:number;present:boolean}
export interface BackupTrustedHistory {repository:string;repositoryId:string;snapshotId:string;catalogueSnapshotId:string;cellId:string;generation:string;receiptHash:string;logicalBytes?:number;verifiedAt:number;registeredAt:number;retiredAt?:number}
export interface BackupRecoveryPin {id:string;repository:string;snapshotId:string;kind:"cell"|"proof";reference:string;generation:string;createdAt:number}
export interface BackupMaintenanceRun {id:string;repository:string;kind:"check"|"prune";bucket:string;state:"queued"|"running"|"succeeded"|"failed"|"unknown";startedAt:number|null;finishedAt:number|null;grantCounter:number;planHash:string|null;protectedSetHash:string|null;forgottenIds:string[];checkResult:"ok"|null;reason:string|null;grantPayload?:unknown;credentialHash?:string;deletedBytes?:number;writtenBytes?:number;readBytes?:number;indexPublished?:boolean;deleteCount?:number;chargedPaths?:string[];lockIds?:string[];processIdentity?:{pid:number;birth:string;bootId:string}|null;writerFence?:{machine:string;phase:"stopping"|"stopped"|"bound"|"restarting"|"released";inventoryComplete?:boolean;inventoryBytes?:number|null;backend:{pid:number;birth:string;bootId:string}|null};backendMaxSize?:number;admissionFailures?:number;notBefore?:number}
export interface BackupWatch {machine:string;repository:string;registeredAt:number;lastArrivalAt:number|null;lastVerifiedAt:number|null;lastBand:BackupCapacityBand;overdue:boolean}
export interface BackupRestoreOperation {id:string;requestHash:string;cellId:string;generation:string;status:"running"|"restored"|"disposed"|"refused"|"failed"|"outcome_unknown";reason:string|null;path:string|null;startedAt:number;finishedAt:number|null;receiptHash:string;guard?:{pid:number;birth:string;bootId:string}|null;stageRoot?:string;cleanup?:"removed"|"held"}
export interface BackupStateFacts {capacityEpoch:{epoch:string};capacityHealth:{repository:string;valid:boolean;checkedAt:number};capacity:BackupCapacityAttestation;drill:BackupRestoreDrill;restore:BackupRestoreOperation;job:BackupServiceJob;lease:{lease:BackupFleetLease|null;counter:number};arrival:BackupArrival;history:BackupTrustedHistory;pin:BackupRecoveryPin;observation:BackupCapacityObservation;alert:BackupServiceAlert;maintenance:BackupMaintenanceRun;watch:BackupWatch;bootstrap:{repository:string;inventoryHash:string;pinIds:string[];approvedAt:number;approvedBy:string}}
export type BackupStateKind=keyof BackupStateFacts;
export interface BackupStateRow<K extends BackupStateKind=BackupStateKind> {format:"honeybee.backup-service.v1";id:string;revision:number;role:"machine"|"authority"|"executor";kind:K;value:BackupStateFacts[K]}
export interface BackupRetentionHistory {arrivals:BackupArrival[];history:BackupTrustedHistory[];pins:BackupRecoveryPin[]}
export interface BackupRetentionPolicy {hourly:number;daily:number;weekly:number;monthly:number;quarantineMs:number;maxReceiptAgeMs:number}
export interface BackupRetentionPlan {keep:string[];forget:string[];unknown:string[];protected:string[]}
/** Only server-owned first-seen clocks group history. Client dates/tags have no role. */
export function planBackupRetention(repository:string,state:BackupRetentionHistory,policy:BackupRetentionPolicy,now:number):BackupRetentionPlan{
 for(const n of[policy.hourly,policy.daily,policy.weekly,policy.monthly])if(!Number.isSafeInteger(n)||n<0||n>10000)throw new Error("unknown_policy");
 if(!Number.isSafeInteger(policy.quarantineMs)||policy.quarantineMs<0||!Number.isSafeInteger(policy.maxReceiptAgeMs)||policy.maxReceiptAgeMs<0)throw new Error("unknown_policy");
 const arrivals=new Map(state.arrivals.filter(a=>a.repository===repository).map(a=>[a.snapshotId,a]));
 const protectedIds=new Set(state.pins.filter(p=>p.repository===repository).map(p=>p.snapshotId));

 for(const h of state.history.filter(h=>h.repository===repository&&!h.retiredAt))if(protectedIds.has(h.catalogueSnapshotId))protectedIds.add(h.snapshotId);
 const known=new Set<string>(),keep=new Set(protectedIds),groups=new Map<string,BackupTrustedHistory[]>();
 for(const h of state.history.filter(h=>h.repository===repository&&!h.retiredAt)){known.add(h.snapshotId);known.add(h.catalogueSnapshotId);const a=arrivals.get(h.snapshotId);if(!a?.present)continue;const group=groups.get(h.cellId)??[];group.push(h);groups.set(h.cellId,group);if(now-a.firstSeenAt<policy.quarantineMs||now-h.verifiedAt<=policy.maxReceiptAgeMs)keep.add(h.snapshotId);}
 const day=86400000;const bucket=(time:number,kind:"hourly"|"daily"|"weekly"|"monthly")=>kind==="monthly"?new Date(time).toISOString().slice(0,7):String(Math.floor((time+(kind==="weekly"?3*day:0))/(kind==="hourly"?3600000:kind==="daily"?day:7*day)));
 for(const rows of groups.values()){
  rows.sort((a,b)=>arrivals.get(b.snapshotId)!.firstSeenAt-arrivals.get(a.snapshotId)!.firstSeenAt||b.registeredAt-a.registeredAt||(a.snapshotId<b.snapshotId?-1:a.snapshotId>b.snapshotId?1:0));
  for(const kind of["hourly","daily","weekly","monthly"]as const){const buckets=new Set<string>();for(const row of rows){const key=bucket(arrivals.get(row.snapshotId)!.firstSeenAt,kind);if(buckets.has(key))continue;if(buckets.size>=policy[kind])break;buckets.add(key);keep.add(row.snapshotId);}}
 }
 const captureForget=[...groups.values()].flat().map(h=>h.snapshotId).filter(id=>!keep.has(id));const forget=[...captureForget];for(const h of state.history.filter(h=>h.repository===repository&&!h.retiredAt)){if(captureForget.includes(h.snapshotId)&&!protectedIds.has(h.catalogueSnapshotId)&&!state.history.some(other=>other.catalogueSnapshotId===h.catalogueSnapshotId&&!captureForget.includes(other.snapshotId)))forget.push(h.catalogueSnapshotId);else{keep.add(h.catalogueSnapshotId);protectedIds.add(h.catalogueSnapshotId);}}const unknown=[...arrivals.keys()].filter(id=>!known.has(id));for(const id of unknown)keep.add(id);
 return{keep:[...keep].sort(),forget:[...new Set(forget)].sort(),unknown:unknown.sort(),protected:[...protectedIds].sort()};
}
export function backupCapacityBand(used:number,limit:number):BackupCapacityBand{
 if(!Number.isSafeInteger(used)||used<0||!Number.isSafeInteger(limit)||limit<=0)return"unknown";
 return used>=limit*0.9?"stop":used>=limit*0.8?"review":used>=limit*0.7?"warn":"normal";
}

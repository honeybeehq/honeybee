/** Durable integrity holds are separate from byte capacity and cannot age themselves green. */
import type {CoreStore} from '../../core/src/index.ts';
import type {BackupIntegrityHold} from '../../core/src/backupService.ts';
import {BackupFacts,repoKey,serviceHash} from './backupServiceSupport.ts';
export function recordIntegrity(facts:BackupFacts,input:BackupIntegrityHold){
 if(input.reason==='check_failed'&&!input.held&&input.checkScope?.kind==='full')for(const old of integrityHolds(facts,input.repository))if(old.reason==='check_failed'&&old.checkScope?.kind!=='full')recordIntegrity(facts,{...input,checkScope:old.checkScope});
 const id=facts.role+':integrity:'+repoKey(input.repository)+':'+(input.reason==='check_failed'?'check:'+serviceHash(input.checkScope??{kind:'full'}):'drill:'+input.snapshotId),prior=facts.get(id,'integrity');
 const changedEpoch=prior?.authorityEpoch&&input.authorityEpoch&&prior.authorityEpoch!==input.authorityEpoch;
 if(changedEpoch&&input.at<=prior!.at)return;
 if(!changedEpoch&&prior&&(prior.order>input.order||prior.order===input.order&&prior.held&&!input.held))return;
 facts.put(id,'integrity',{...input,blockUploads:input.held&&(input.blockUploads||!!prior?.held&&prior.blockUploads)});
}
export function integrityHolds(facts:BackupFacts,repository:string):BackupIntegrityHold[]{return facts.rows(facts.role+':integrity:'+repoKey(repository)+':','integrity').filter(h=>h.held);}
export function integrityReason(holds:BackupIntegrityHold[]):'check_failed'|'drill_failed'|null{return holds.some(h=>h.reason==='check_failed')?'check_failed':holds.some(h=>h.reason==='drill_failed')?'drill_failed':null;}
export function machineIntegrityHolds(store:CoreStore,dataDir:string,repository:string):BackupIntegrityHold[]{
 const facts=new BackupFacts({store,dataDir,tools:{git:'',restic:'',hem:''},now:Date.now},'machine');return[...integrityHolds(facts,repository),...(facts.get('machine:capacity:'+repoKey(repository),'capacity')?.payload.holds??[])];
}
const effects=new WeakMap<CoreStore,Set<{repository:string;flag:SharedArrayBuffer}>>();
export function trackIntegrityEffect(store:CoreStore,repository:string,flag:SharedArrayBuffer){let set=effects.get(store);if(!set){set=new Set();effects.set(store,set);}const value={repository,flag};set.add(value);return()=>{set!.delete(value);};}
export function interruptIntegrityEffects(store:CoreStore,repository:string,reason:'check_failed'|'drill_failed'|null){if(!reason)return;for(const effect of effects.get(store)??[])if(effect.repository===repository)Atomics.compareExchange(new Int32Array(effect.flag),0,0,reason==='check_failed'?2:3);}

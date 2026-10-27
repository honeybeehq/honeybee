/** Narrow privileged boundary: fixed helper argv, typed confirmation, never a shell. */
import {execFile} from 'node:child_process';
import type {RuntimeProcessIdentity} from '../../core/src/processIdentity.ts';
import {processIdentityValue} from '../../core/src/processIdentity.ts';
import {BackupServiceError,type BackupServiceOwner} from './backupServiceSupport.ts';
export interface WriterFenceProof {format:'honeybee.writer-fence.v1';jobId:string;machine:string;unit:string;writer:'stopped'|'running';activeState:string;subState:string;backend:RuntimeProcessIdentity|null;fenced:boolean;inventoryBytes?:number|null;inventoryComplete?:boolean}
export async function writerFence(command:string[],action:'stop'|'status'|'start',machine:string,jobId:string,backend:RuntimeProcessIdentity|null,owner:BackupServiceOwner):Promise<WriterFenceProof>{
 try{
  if(!command.length||!command[0]!.startsWith('/')||command.some(a=>typeof a!=='string'||!a||/[\x00-\x1f]/.test(a))||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(machine)||!/^[a-f0-9]{64}$/.test(jobId))throw 0;
  const value=await new Promise<string>((accept,reject)=>{const child=execFile(command[0]!,[...command.slice(1),action,machine],{encoding:'utf8',timeout:30000,maxBuffer:8192,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin'}},(error,stdout)=>error?reject(0):accept(stdout));child.stdin?.end(JSON.stringify({format:'honeybee.writer-fence.v1',jobId,backend}));});
  const p=JSON.parse(value)as WriterFenceProof;if(p.format!=='honeybee.writer-fence.v1'||p.jobId!==jobId||p.machine!==machine||p.unit!=='fleet-backup@'+machine+'.service'||!(p.backend===null||processIdentityValue(p.backend))||typeof p.fenced!=='boolean')throw 0;
  if(action==='start'){if(p.writer!=='running'||p.activeState!=='active'||p.subState!=='running'||p.fenced||typeof p.inventoryComplete!=='boolean'||p.inventoryComplete&&(!Number.isSafeInteger(p.inventoryBytes)||p.inventoryBytes!<0))throw 0;}
  else if(!(p.writer==='stopped'&&p.activeState==='inactive'&&p.subState==='dead'&&p.fenced)&&!(action==='status'&&backend===null&&p.writer==='running'&&p.activeState==='active'&&p.subState==='running'))throw 0;
  if(backend&&(!p.backend||p.backend.pid!==backend.pid||p.backend.birth!==backend.birth||p.backend.bootId!==backend.bootId))throw 0;
  owner.trace?.('writer.fence '+action+' '+p.writer);return p;
 }catch{throw new BackupServiceError('writer_fence_failed');}
}

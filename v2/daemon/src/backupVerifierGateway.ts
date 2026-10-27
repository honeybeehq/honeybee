/** Narrow verification delivery: a source can submit only its configured repository, never mutate a remote daemon. */
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {disposeVerifiedCapture,verifyAndCatalogue,type BackupRepositoryAccess,type BackupVerificationOwner,type BackupVerifierAuthority} from './backupVerification.ts';
import {resolveBackupSecret,type BackupRecord} from './backupCapture.ts';
export interface VerifierGatewayConfig {tokenRef:string;access:BackupRepositoryAccess;catalogueAccess:BackupRepositoryAccess;authority:BackupVerifierAuthority}
export function createBackupVerifierGateway(config:VerifierGatewayConfig,owner:BackupVerificationOwner){
 let busy=false;return createServer(async(req,res)=>{try{
  if(req.method!=='POST'||req.url!=='/v1/verify'||busy)throw 0;
  const token=await resolveBackupSecret({tools:owner.tools,signal:owner.signal,resolveSecret:owner.resolveSecret,child:()=>undefined},config.tokenRef,'token'),actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw 0;
  const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)throw 0;chunks.push(Buffer.from(chunk));}
  const {record}=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {record:BackupRecord};if(record.repository!==config.access.repository||record.machine!==config.access.machine)throw 0;
  if(busy)throw 0;busy=true;
  try{const result=await verifyAndCatalogue(record,config.access,config.catalogueAccess,config.authority,owner);try{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({receipt:result.receipt,publication:result.publication}));}finally{await disposeVerifiedCapture(result.stage);}}finally{busy=false;}
 }catch{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({status:'refused',reason:'verification_failed'}));}});
}

/** Thin authenticated gateway. Production binds loopback behind a tailnet-only TLS terminator. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';
import {BackupAuthority,type BackupPrincipal} from './backupAuthority.ts';
import {BackupServiceError,insist,serviceSecret} from './backupServiceSupport.ts';
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
async function json(req:IncomingMessage):Promise<any>{const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;insist(size<=8*1024*1024,'scope_refused');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
export function createBackupAuthorityGateway(authority:BackupAuthority){
 let tokenHashes:{principal:BackupPrincipal;hash:string}[]=[],refreshAt=-1,refreshing:Promise<void>|null=null;
 async function refresh(){if(authority.owner.now()<refreshAt)return;if(refreshing)return refreshing;const work=(async()=>{const next=[];for(const p of authority.config.principals){const token=await serviceSecret(authority.owner,p.tokenRef,'token');insist(token.length>=1,'secret_unavailable');next.push({principal:{id:p.id,role:p.role,repository:p.repository},hash:createHash('sha256').update(token).digest('hex')});}tokenHashes=next;refreshAt=authority.owner.now()+30000;})();refreshing=work;try{await work;}finally{refreshing=null;}}
 const server=createServer(async(req,res)=>{try{
  const url=new URL(req.url??'','http://127.0.0.1');insist(!url.hash,'scope_refused');
  if(url.pathname.startsWith('/maintenance/')){await proxy(req,res,url);return;}
  insist(req.method==='POST','scope_refused');const authorization=req.headers.authorization??'';insist(authorization.startsWith('Bearer '),'scope_refused');let principal:BackupPrincipal|undefined;
  await refresh();const supplied=createHash('sha256').update(authorization.slice(7)).digest('hex');for(const entry of tokenHashes)if(equal(supplied,entry.hash)){insist(!principal,'scope_refused');principal=entry.principal;}
  insist(principal,'scope_refused');const body=await json(req);let result:unknown;
  switch(url.pathname){
   case '/v1/status':insist(body.repository===principal.repository,'scope_refused');{const status=authority.status();result={lease:status.lease?.repository===principal.repository?status.lease:null,observations:status.observations.filter(o=>o.repository===principal.repository),watches:status.watches.filter(w=>w.repository===principal.repository)};}break;
   case '/v1/upload':result=await authority.acquireUpload(principal,body);break;
   case '/v1/heartbeat':result=authority.heartbeat(principal,body);break;
   case '/v1/release':insist(principal.role==='machine','scope_refused');result=authority.release(principal,body);break;
   case '/v1/report':result=await authority.report(principal,body);break;
   case '/v1/pin':result=authority.pin(principal,body);break;
   case '/v1/maintenance/claim':result=await authority.claimMaintenance(principal);break;
   case '/v1/maintenance/finish':result=await authority.finishMaintenance(principal,body);break;
   default:throw new BackupServiceError('scope_refused');
  }
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch(error){authority.owner.trace?.('gateway.refused '+(error instanceof BackupServiceError?error.reason:'scope_refused'));if(!res.headersSent)res.writeHead(error instanceof BackupServiceError&&error.reason==='busy'?409:403,{'content-type':'application/json'});res.end(JSON.stringify({status:'refused',reason:error instanceof BackupServiceError?error.reason:'scope_refused'}));}});
 async function proxy(req:IncomingMessage,res:ServerResponse,url:URL){
  const match=/^\/maintenance\/([^/]+)\/(.*)$/.exec(url.pathname);insist(match,'scope_refused');
  const auth=req.headers.authorization??'';insist(auth.startsWith('Basic '),'grant_invalid');const decoded=Buffer.from(auth.slice(6),'base64').toString('utf8'),colon=decoded.indexOf(':');insist(colon>0,'grant_invalid');
  const bytes=Number(req.headers['content-length']??0);insist(!req.headers['transfer-encoding']&&Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=authority.config.maintenance.maxRepackBytes+16*1024*1024,'scope_refused');
  const admitted=await authority.admitMaintenanceRequest({username:decoded.slice(0,colon),password:decoded.slice(colon+1),machine:decodeURIComponent(match[1]!),method:req.method??'',path:decodeURIComponent(match[2]!),bytes,range:req.headers.range});
  const lease=authority.status().lease;insist(lease?.role==='maintenance','grant_invalid');const backendAuth=await authority.backend.authorization(lease.id,lease.counter);
  const headers:Record<string,string>={authorization:backendAuth};for(const key of['content-type','accept','content-length','range'])if(typeof req.headers[key]==='string')headers[key]=req.headers[key]!;
  const abort=new AbortController();req.once('aborted',()=>abort.abort());const body=req.method==='POST'?req:undefined;
  const response=await fetch(admitted.backendUrl,{method:req.method,headers,body:body as never,duplex:'half',redirect:'error',signal:abort.signal} as RequestInit);
  if(req.method==='POST'&&response.ok&&match[2]!.startsWith('index/'))authority.noteIndexPublished();
  if(req.method==='DELETE'&&response.ok&&match[2]!.startsWith('snapshots/'))authority.noteSnapshotDeleted(admitted.repository,match[2]!.split('/').at(-1)!);
  const outgoing:Record<string,string>={};for(const key of['content-type','content-length','content-range','accept-ranges'])if(response.headers.has(key))outgoing[key]=response.headers.get(key)!;
  authority.owner.trace?.('proxy '+req.method+' '+match[2]!.split('/')[0]+' '+response.status);res.writeHead(response.status,outgoing);if(response.body)for await(const chunk of response.body){if(!res.write(chunk))await new Promise<void>(r=>res.once('drain',r));}res.end();
 }
 return server;
}

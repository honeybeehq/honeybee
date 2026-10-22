if (!process.env.HOME || process.env.HOME !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(process.env.HOME)) throw new Error("Run with an isolated HOME and TMPDIR under /var/tmp");
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeDaemonDir, startDaemon, waitFor } from '../../v2/daemon/tests/helpers.ts';

const good = JSON.stringify({claudeAiOauth:{accessToken:'LAB-FAKE',refreshToken:'LAB-FAKE-REFRESH',expiresAt:4102444800000}});
const stub = JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}});
const fake = resolve('v2/driver-hsr/test-agent/fake-claude.mjs');
const {dir} = makeDaemonDir({agents:{claude:{command:process.execPath,args:[fake,'-p','--input-format','stream-json','--output-format','stream-json','--verbose'],adapter:'claude'}}});
const vault = join(dir,'vault','claude','claude-lab');
const home = join(dir,'homes','claude-lab');
for (const path of [vault,home]) { mkdirSync(path,{recursive:true}); writeFileSync(join(path,'.credentials.json'),good); }
const daemon = await startDaemon(dir);
const client = await daemon.client();
let attentionDelta=false;
client.onEvent=(frame)=>{if(JSON.stringify(frame).includes('account_credentials_unusable:')) attentionDelta=true;};
await client.request('watch',{});
try {
  await client.request('account.add',{harness:'claude',label:'lab',importExisting:true});
  const bee:any = await client.request('spawn',{name:'h4-wake',agent:'claude',cwd:dir,account:'claude-lab'});
  const first:any = await client.request('send',{beeId:bee.beeId,body:'first'});
  await waitFor(async()=>((await client.request<any>('mailbox',{beeId:bee.beeId})).messages.find((m:any)=>m.id===first.messageId)?.deliveredAt!=null),'initial delivery');
  await client.request('stop',{beeId:bee.beeId});
  await waitFor(async()=>((await client.request<any>('view',{beeId:bee.beeId})).view.runtimeState==='stopped'),'stopped');
  for (const path of [vault,home]) writeFileSync(join(path,'.credentials.json'),stub);
  const mail:any = await client.request('send',{beeId:bee.beeId,body:'held without subsequent mail'});
  await waitFor(()=>readFileSync(join(dir,'hived.log'),'utf8').includes('runtime.start.held'),'held');
  const account:any = await client.request('account.get',{id:'claude-lab'});
  assert.equal(account.account.attention.code,'credential_file_damaged');
  console.log(JSON.stringify({case:'held',commandId:mail.commandId,attention:account.account.attention}));
  console.log('Waiting for the real 60-second attention bound. No new mail will be sent.');
  const flagged:any = await waitFor(async()=>{
    const view:any=await client.request('view',{beeId:bee.beeId});
    return view.view.flags.includes('auth_needed') ? view : null;
  },'bounded auth attention',65000,200);
  const audit:any = await client.request('audit.tail',{beeId:bee.beeId,limit:1000});
  const flag:any = audit.rows.filter((r:any)=>r.kind==='flag.set').map((r:any)=>r.payload.flag).findLast((f:any)=>f.flag==='auth_needed');
  console.log(JSON.stringify({case:'stuck',view:flagged.view,detail:flag.detail}));
  assert.ok(flag.detail.includes('account_credentials_unusable:'));
  assert.equal(flagged.view.waitingForYou,true);
  await waitFor(()=>attentionDelta,'attention watch delta');
  console.log(JSON.stringify({case:'watch-attention',received:attentionDelta}));
  for (const path of [vault,home]) writeFileSync(join(path,'.credentials.json'),good);
  const delivered:any=await waitFor(async()=>{
    const msg=(await client.request<any>('mailbox',{beeId:bee.beeId})).messages.find((m:any)=>m.id===mail.messageId);
    return msg?.deliveredAt!=null ? msg : null;
  },'same wake retries after readiness flip',12000);
  const after:any=await client.request('view',{beeId:bee.beeId});
  assert.ok(!after.view.flags.includes('auth_needed'));
  const commands:any=await client.request('commands',{beeId:bee.beeId});
  const wake=commands.commands.find((c:any)=>c.id===mail.commandId);
  assert.equal(wake.status,'done');
  console.log(JSON.stringify({case:'recovered-without-mail',messageId:delivered.id,generation:delivered.deliveredGeneration,wakeStatus:wake.status,attempts:wake.attempts}));
} finally { client.close(); await daemon.stop(); }

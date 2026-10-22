if (!process.env.HOME || process.env.HOME !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(process.env.HOME)) throw new Error("Run with an isolated HOME and TMPDIR under /var/tmp");
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeDaemonDir } from '../../v2/daemon/tests/helpers.ts';
import { HiveDaemon } from '../../v2/daemon/src/daemon.ts';
import { loadNodeConfig } from '../../v2/daemon/src/config.ts';
import { RpcClient } from '../../v2/cli/src/client.ts';
import { openCoreStore } from '../../v2/core/src/index.ts';
const stub=JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}});
const good=JSON.stringify({claudeAiOauth:{accessToken:'LAB-FAKE',refreshToken:'LAB-FAKE-REFRESH',expiresAt:4102444800000}});
for(const source of ['keychain','vault','none']) {
  const {dir}=makeDaemonDir();
  const home=join(dir,'homes','claude-lab');
  const vault=join(dir,'vault','claude','claude-lab');
  for(const path of [home,vault]) mkdirSync(path,{recursive:true});
  writeFileSync(join(home,'.credentials.json'),stub);
  writeFileSync(join(vault,'.credentials.json'),source==='vault'?good:stub);
  const cfg=loadNodeConfig(dir);
  const daemon=new HiveDaemon(cfg,{keychainReader:async()=>source==='keychain'?good:null,keychainWriter:async()=>false,gatewayMcpSeeder:async()=>({status:'seeded',written:[]}),fetchers:{claudeIdentity:async()=>({accountUuid:"lab-account",organizationUuid:"lab-org"}),claudeUsage:async()=>({five_hour:{utilization:1,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:1,resets_at:'2099-01-01T00:00:00Z'}})}});
  await daemon.start();
  const client=await RpcClient.connect(cfg.socketPath);
  try {
    await client.request('account.add',{harness:'claude',label:'lab',importExisting:true});
    writeFileSync(join(home,'.credentials.json'),stub);
    writeFileSync(join(vault,'.credentials.json'),source==='vault'?good:stub);
    writeFileSync(join(home,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"lab-account",organizationUuid:"lab-org"}}));
    const result:any=await client.request('account.verify',{id:'claude-lab'});
    const after:any=await client.request('account.get',{id:'claude-lab'});
    console.log(JSON.stringify({case:'disposable-daemon-verify',source,outcome:result.outcome,attention:after.account.attention}));
    if(source!=='none') {assert.equal(result.outcome,'verified');assert.equal(after.account.attention,null);}
    else assert.equal(after.account.attention.code,'credential_file_damaged');
  } finally {client.close();await daemon.shutdown({preserveRuntimes:false});}
}

const {dir:bootDir}=makeDaemonDir();
const bootCfg=loadNodeConfig(bootDir);
const seed=openCoreStore(bootCfg.storePath,{ephemeral:true});
const ids:string[]=[];
for(const owned of [true,false]) {
  const {bee}=seed.createBee({name:owned?'orphan-held':'runtime-auth',agent:'stub',substrate:'hsr',cwd:bootDir});
  seed.updateRuntimeState(bee.id,1,'stopped',{exitCause:'stopped_by_user'});
  seed.setFlag(bee.id,'auth_needed',owned?'account_credentials_unusable: lab orphan':'runtime authentication failed');
  ids.push(bee.id);
}
seed.close();
const bootDaemon=new HiveDaemon(bootCfg,{keychainReader:async()=>null,keychainWriter:async()=>false});
await bootDaemon.start();
const bootClient=await RpcClient.connect(bootCfg.socketPath);
try {
  const orphan:any=await bootClient.request('view',{beeId:ids[0]});
  const runtime:any=await bootClient.request('view',{beeId:ids[1]});
  assert.ok(!orphan.view.flags.includes('auth_needed'));
  assert.ok(runtime.view.flags.includes('auth_needed'));
  console.log(JSON.stringify({case:'boot-attention-cleanup',ownedOrphanCleared:true,runtimeAuthPreserved:true}));
} finally {bootClient.close();await bootDaemon.shutdown({preserveRuntimes:false});}

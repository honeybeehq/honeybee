if (!process.env.HOME || process.env.HOME !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(process.env.HOME)) throw new Error("Run with an isolated HOME and TMPDIR under /var/tmp");
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountsService } from '../../v2/daemon/src/accountsService.ts';
import { openCoreStore } from '../../v2/core/src/index.ts';
import { loadNodeConfig } from '../../v2/daemon/src/config.ts';

const root = process.env.HOME!;
const stub = JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'',expiresAt:0}});
const good = JSON.stringify({claudeAiOauth:{accessToken:'LAB-FAKE',refreshToken:'LAB-FAKE-REFRESH',expiresAt:4102444800000}});
for (const source of ['keychain', 'live-keychain', 'vault', 'refresh', 'live-refresh', 'none']) {
  const dir = join(root, `readiness-${source}-${Date.now()}`);
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, 'config.json'), JSON.stringify({accounts:{homesDir:join(dir,'homes'),vaultDir:join(dir,'vault'),limitsRefreshMs:0}}));
  const cfg = loadNodeConfig(dir);
  const store = openCoreStore(join(dir,'core.sqlite3'), {ephemeral:true});
  try {
    const home = join(dir,'homes','claude-lab');
    mkdirSync(home,{recursive:true});
    writeFileSync(join(home,'.credentials.json'),source.includes('refresh')?JSON.stringify({claudeAiOauth:{accessToken:'',refreshToken:'LAB-FAKE-REFRESH',expiresAt:4102444800000}}):stub);
    if (source === 'vault') {
      const vault = join(dir,'vault','claude','claude-lab');
      mkdirSync(vault,{recursive:true});
      writeFileSync(join(vault,'.credentials.json'),good);
    }
    writeFileSync(join(home,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"lab-account",organizationUuid:"lab-org"}}));
    const account = store.createAccount({id:'claude-lab',harness:'claude',label:'lab',homePath:home,status:'ok'});
    if(source.startsWith('live-')) {
      const {bee}=store.createBee({name:'live-sibling',agent:'claude',substrate:'hsr',cwd:dir,account:account.id});
      store.updateRuntimeState(bee.id,1,'running',{pid:101,pidStartedAt:1});
    }
    let refreshCalls=0;
    const service = new AccountsService({store,cfg,platform:source.includes('keychain')?'darwin':'linux',keychainReader:async()=>source.includes('keychain')?good:null,keychainWriter:async()=>false,log:()=>{},fetchers:{claudeIdentity:async()=>({accountUuid:"lab-account",organizationUuid:"lab-org"}),claudeRefresh:async()=>{refreshCalls++;return {kind:'success',token:{accessToken:'LAB-FAKE-ROTATED',refreshToken:'LAB-FAKE-ROTATED-REFRESH',expiresAt:4102444800000}};},claudeUsage:async(token)=>{assert.ok(token.length>0);return {five_hour:{utilization:1,resets_at:'2099-01-01T00:00:00Z'},seven_day:{utilization:1,resets_at:'2099-01-01T00:00:00Z'}};}}});
    const result = await service.verifyCredentials(account);
    if(source.includes('refresh')) assert.equal(refreshCalls,1);
    const readiness = service.credentialReadiness(store.getAccount(account.id)!);
    console.log(JSON.stringify({source,verify:result.outcome,readiness}));
    if (source !== 'none') {
      assert.equal(result.outcome,'verified');
      assert.equal(readiness.ready,true,`${source} verified login must be startable`);
    } else {
      assert.equal(readiness.ready,false);
      assert.equal(readiness.ready ? null : readiness.code,'credential_file_damaged');
    }
  } finally { store.close(); }
}

const projectionDir = join(root, `projection-${Date.now()}`);
mkdirSync(projectionDir,{recursive:true});
const projectionStore = openCoreStore(join(projectionDir,'core.sqlite3'),{ephemeral:true});
try {
  const {bee}=projectionStore.createBee({name:'projection',agent:'stub',substrate:'hsr',cwd:projectionDir});
  projectionStore.updateRuntimeState(bee.id,1,'stopped',{exitCause:'stopped_by_user'});
  projectionStore.setFlag(bee.id,'auth_needed','account_credentials_unusable: lab');
  assert.equal(projectionStore.view(bee.id).waitingForYou,true);
  assert.equal(projectionStore.listBeeViewRows()[0].view.waitingForYou,true);
  projectionStore.clearFlag(bee.id,'auth_needed');
  assert.equal(projectionStore.view(bee.id).waitingForYou,false);
  const runtime=projectionStore.reviveBee(bee.id);
  projectionStore.updateRuntimeState(bee.id,runtime.generation,'running',{pid:101,pidStartedAt:1});
  projectionStore.setFlag(bee.id,'auth_needed','runtime automatic recovery');
  assert.equal(projectionStore.view(bee.id).waitingForYou,false);
  console.log(JSON.stringify({case:'projection',heldNeedsYou:true,clearedNeedsYou:false,runningRecoveryNeedsYou:false}));
} finally {projectionStore.close();}

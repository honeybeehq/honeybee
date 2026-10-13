import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("handoff scrub: darwin security shim preserves default item and scrubs only a private per-home item", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-handoff-security-"));
  try {
    const bin = join(root, "bin"), secretStore = join(root, "vault", "keychain-shim");
    mkdirSync(bin, { recursive: true }); mkdirSync(secretStore, { recursive: true, mode: 0o700 });
    writeFileSync(join(bin, "security"), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const args=process.argv.slice(2),store=process.env.HANDOFF_SHIM_STORE;
function location(service){return path.join(store,crypto.createHash('sha256').update(service).digest('hex'));}
function note(service){fs.appendFileSync(path.join(store,'calls'),service+'\\n');}
if(args[0]==='-i'){let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const tokens=(input.trim().match(/"(?:\\\\.|[^"])*"|[^\\s]+/g)||[]).map(t=>t.startsWith('"')?JSON.parse(t):t);
const service=tokens[tokens.indexOf('-s')+1],raw=tokens[tokens.indexOf('-w')+1];note(service);fs.writeFileSync(location(service),raw,{mode:0o600});
});}else{const service=args[args.indexOf('-s')+1];note(service);if(fs.existsSync(location(service)))process.stdout.write(fs.readFileSync(location(service)));else{process.stderr.write('The specified item could not be found in the keychain');process.exitCode=44;}}
`, { mode: 0o755 });
    const imports = {
      store: fileURLToPath(new URL("../../core/src/index.ts", import.meta.url)),
      accounts: fileURLToPath(new URL("../src/accountsService.ts", import.meta.url)),
      config: fileURLToPath(new URL("../src/config.ts", import.meta.url)),
      keychain: fileURLToPath(new URL("../src/keychain.ts", import.meta.url)),
      protocol: fileURLToPath(new URL("../src/protocol.ts", import.meta.url)),
    };
    const script = `
import assert from 'node:assert/strict';import fs from 'node:fs';import{join}from'node:path';import{createHash,randomUUID}from'node:crypto';
import{openCoreStore}from ${JSON.stringify(imports.store)};import{AccountsService}from ${JSON.stringify(imports.accounts)};import{loadNodeConfig}from ${JSON.stringify(imports.config)};import{claudeKeychainService}from ${JSON.stringify(imports.keychain)};import{RpcError}from ${JSON.stringify(imports.protocol)};
assert.equal(process.platform,'darwin');
const root=process.env.HANDOFF_SHIM_ROOT, vault=join(root,'vault'),homes=join(root,'homes'),keychainStore=process.env.HANDOFF_SHIM_STORE;
fs.writeFileSync(join(root,'config.json'),JSON.stringify({accounts:{vaultDir:vault,homesDir:homes,limitsRefreshMs:0}}));
const store=openCoreStore(join(root,'core.sqlite3'));const svc=new AccountsService({store,cfg:loadNodeConfig(root),now:()=>Date.now(),log:()=>{}});
const raw=JSON.stringify({claudeAiOauth:{accessToken:randomUUID(),refreshToken:randomUUID(),expiresAt:Date.now()+3600000}});
const item=home=>join(keychainStore,createHash('sha256').update(claudeKeychainService(home)).digest('hex'));
const defaultHome=join(process.env.HOME,'.claude');fs.mkdirSync(defaultHome,{recursive:true});fs.writeFileSync(join(defaultHome,'.credentials.json'),raw);fs.writeFileSync(item(defaultHome),raw);
const defaultRow=store.createAccount({id:'claude-default-example.com',harness:'claude',label:'default',homePath:defaultHome,penalty:0,status:'ok'});
await assert.rejects(svc.scrubHandoff(defaultRow),e=>e instanceof RpcError&&e.code==='account_lease_conflict');
assert.ok(fs.readFileSync(item(defaultHome),'utf8')===raw);assert.ok(!fs.existsSync(join(keychainStore,'calls')));
const alias=join(root,'default-alias');fs.symlinkSync(defaultHome,alias);
await assert.rejects(svc.scrubHandoff({...defaultRow,homePath:alias}),e=>e instanceof RpcError&&e.code==='account_lease_conflict');
const privateHome=join(homes,'claude-private-example.com');fs.mkdirSync(privateHome,{recursive:true});fs.writeFileSync(join(privateHome,'.credentials.json'),raw);fs.writeFileSync(item(privateHome),raw);
const privateRow=store.createAccount({id:'claude-private-example.com',harness:'claude',label:'private',homePath:privateHome,penalty:0,status:'ok'});
await svc.scrubHandoff(privateRow);
assert.ok(JSON.parse(fs.readFileSync(item(privateHome),'utf8')).claudeAiOauth.refreshToken==='');
assert.ok(JSON.parse(fs.readFileSync(join(privateHome,'.credentials.json'),'utf8')).claudeAiOauth.refreshToken==='');
assert.ok(fs.readFileSync(item(defaultHome),'utf8')===raw);
assert.ok(fs.readFileSync(join(keychainStore,'calls'),'utf8').split('\\n').every(s=>!s||s!=='Claude Code-credentials'));
store.close();console.log('darwin security shim: default and symlink guards before security; per-home Keychain/file refresh blank; default unchanged; no provider');
`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: join(root, "user"), PATH: `${bin}:${process.env.PATH}`, HIVE_NO_KEYCHAIN: "", HIVE_TEST_PLATFORM: "darwin",
        NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/force-platform.mjs", import.meta.url))}`,
        HANDOFF_SHIM_ROOT: root, HANDOFF_SHIM_STORE: secretStore },
      timeout: 30_000,
    });
    assert.match(stdout, /default unchanged/);
    console.log(stdout.trim());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

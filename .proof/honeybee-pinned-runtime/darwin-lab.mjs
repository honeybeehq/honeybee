import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const { probeNativeNode, resolveNodePin, persistNodePin, nodePinEnv, nativeNodeEnv } = await import(pathToFileURL(join(repo, 'dist/nodeRuntime.js')));
const { restartDeployedDaemon } = await import(pathToFileURL(join(repo, 'dist/commands/deploy.js')));
const { LaunchdServiceManager } = await import(pathToFileURL(join(repo, 'v2/daemon/src/service.ts')));
const root = mkdtempSync(join(process.env.HOME, 'pinned-'));
const data = join(root, 'v2'), label = `dev.honeybee.lab.pinned.${process.pid}`;
const env = nativeNodeEnv();
const ctl = (...args) => execFileSync('launchctl', args, { env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const pin = probeNativeNode(process.execPath);
const worker = join(root, 'worker.mjs');
const output = join(root, 'child.json');
let linked = false;
let manager;
try {
  mkdirSync(data, { recursive: true });
  assert.throws(() => resolveNodePin(data, {}), /HIVE_NODE_PATH required/);
  assert.throws(() => probeNativeNode('/Applications/Apiary.app/Contents/MacOS/Apiary'), /never Electron/);
  persistNodePin(data, pin);
  writeFileSync(worker, `import {spawn} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {HsrDriver} from ${JSON.stringify(pathToFileURL(join(repo,'v2/driver-hsr/src/driver.ts')).href)};
import {stubAdapter} from ${JSON.stringify(pathToFileURL(join(repo,'v2/adapters/src/stub.ts')).href)};
import {holdMirrorLock} from ${JSON.stringify(pathToFileURL(join(repo,'v2/driver-cell/src/upstream.ts')).href)};
import {childNodePath,nativeNodeEnv} from ${JSON.stringify(pathToFileURL(join(repo,'dist/nodeRuntime.js')).href)};
const lock=${JSON.stringify(join(root,'mirror.lock'))};mkdirSync(lock);
const heartbeat=holdMirrorLock(lock,1000);
const driver=new HsrDriver({sessionLogDir:${JSON.stringify(join(root,'logs'))},resolve:()=>({command:process.execPath,args:[${JSON.stringify(join(repo,'v2/driver-hsr/test-agent/agent.mjs'))}],adapter:stubAdapter})});
driver.start('bee-lab',1);
const child=spawn(childNodePath(),['-e', 'setInterval(()=>{},1000)', 'honeybee-pinned-child'],{env:nativeNodeEnv(),stdio:'ignore'});
writeFileSync(${JSON.stringify(output)},JSON.stringify({pid:process.pid,child:child.pid,host:driver.liveProcesses()[0].pid}));
process.on('SIGTERM',()=>{child.kill();heartbeat.release();driver.disposeAll();process.exit(0)});
setInterval(()=>{},1000);
`);
  const exec = async (cmd, args) => {
    try { return { code: 0, stdout: execFileSync(cmd,args,{env,encoding:'utf8'}), stderr:'' }; }
    catch(e) { return {code:e.status ?? 1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')}; }
  };
  const spec = { label, execArgs:[pin.path,worker], logPath:join(root,'daemon.log'), env:{ ...nodePinEnv(pin), HOME:process.env.HOME, HIVE_V2_DATA_DIR:data, PATH:process.env.PATH } };
  manager = new LaunchdServiceManager(spec,{exec,agentsDir:join(root,'agents'),uid:process.getuid()});
  assert.ok(manager.servicePath.startsWith(resolve(process.env.HOME)+"/"));
  assert.ok(label.startsWith("dev.honeybee.lab.pinned."));
  await manager.install();
  const unit = readFileSync(manager.servicePath,'utf8');
  assert.ok(unit.includes(`<string>${pin.path}</string>`));
  console.log(unit);
  await manager.start(); linked=true;
  for(let i=0;i<100;i++){if((await import('node:fs')).existsSync(output))break;await new Promise(r=>setTimeout(r,50));}
  const before = JSON.parse(readFileSync(output,'utf8'));
  await new Promise(r=>setTimeout(r,800));
  const children=execFileSync('pgrep',['-P',String(before.pid)],{encoding:'utf8'}).trim().split(/\s+/);
  const hostChildren=execFileSync('pgrep',['-P',String(before.host)],{encoding:'utf8'}).trim().split(/\s+/);
  const childArgv=execFileSync('ps',['-p',[...children,...hostChildren].join(','),'-o','pid=,ppid=,args='],{encoding:'utf8'});
  console.log('HSR HOST / HEARTBEAT / LAB CHILD PS\n'+childArgv);
  assert.ok(childArgv.includes('runner-host-main.ts'));
  assert.ok(childArgv.includes('agent.mjs'));
  for(const line of childArgv.trim().split('\n')) assert.ok(line.includes(pin.path));
  console.log('LAB PS BEFORE\n'+execFileSync('ps',['-p',`${before.pid},${before.child}`,'-o','pid=,ppid=,args='],{encoding:'utf8'}));
  assert.equal(JSON.parse(execFileSync('plutil',['-extract','ProgramArguments','json','-o','-',manager.servicePath],{encoding:'utf8'}))[0],pin.path);
  const oldPath=process.env.HIVE_NODE_PATH;
  process.env.HIVE_NODE_PATH='/Applications/Apiary.app/Contents/MacOS/Apiary';
  await assert.rejects(restartDeployedDaemon({root:join(root,'runtime'),installedDir:root,sha:'a'.repeat(40),runtime:'v2',log:console.log}),/never Electron/);
  if(oldPath===undefined)delete process.env.HIVE_NODE_PATH;else process.env.HIVE_NODE_PATH=oldPath;
  const after = JSON.parse(readFileSync(output,'utf8')).pid;
  assert.equal(after,before.pid);
  process.kill(before.pid,0);
  console.log(`BAD PIN REJECTED: old scratch daemon pid ${before.pid} unchanged`);
  const replay = resolveNodePin(data,{});
  assert.deepEqual(replay,pin);
  assert.ok(manager.servicePath.startsWith(resolve(process.env.HOME)+"/"));
  assert.ok(label.startsWith("dev.honeybee.lab.pinned."));
  await manager.install();
  assert.ok(readFileSync(manager.servicePath,'utf8').includes(`<string>${pin.path}</string>`));
  console.log('REINSTALL PRESERVES PIN '+JSON.stringify(replay));
  persistNodePin(data,{...pin,version:'0.0.0'});
  assert.throws(()=>resolveNodePin(data,{}),/identity drift/);
  persistNodePin(data,pin);
  console.log('PASS missing/Electron/version-drift rejection; installed ExecStart; pinned child argv; reinstall pin; bad deploy preserves pid');
} finally {
  try { if(linked) await manager.stop(); } finally { rmSync(root,{recursive:true,force:true}); }
  console.log('CLEANUP disposable unit and scratch files removed '+label);
}

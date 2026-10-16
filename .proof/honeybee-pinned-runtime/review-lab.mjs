import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,writeFileSync,symlinkSync,readlinkSync,rmSync,statSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
const repo=process.cwd(), home=resolve(process.env.HOME);
assert.ok(process.env.XDG_CONFIG_HOME?.startsWith(home+'/'),'scratch XDG_CONFIG_HOME required');
assert.ok(process.env.REAL_SERVICE_HOME&&resolve(process.env.REAL_SERVICE_HOME)!==home,'scratch HOME required');
const root=mkdtempSync(join(home,'pinned-review-')),runtime=join(root,'runtime'),data=join(root,'v2');
const label=`dev.honeybee.lab.pinned.review.${process.pid}`,unitDir=join(root,'units');
const contained=relative(home,unitDir);
assert.ok(contained&&!contained.startsWith('..')&&!isAbsolute(contained)&&label.startsWith('dev.honeybee.lab.pinned.'));
console.log('ISOLATION ASSERTION PASSED '+JSON.stringify({home,unitDir,label}));
const mod=p=>import(pathToFileURL(join(repo,p)));
const {probeNativeNode,persistNodePin,nodePinEnv,nodeRepairFile,nativeNodeEnv}=await mod('dist/nodeRuntime.js');
const {deployVersion}=await mod('dist/deployRuntime.js');
const {restartDeployedDaemon}=await mod('dist/commands/deploy.js');
const {createServiceManager}=await mod('v2/daemon/src/service.ts');
const pin=probeNativeNode(process.execPath),pidFile=join(root,'pid.json'),attempts=join(root,'starts.log');
const env={...nativeNodeEnv(),...nodePinEnv(pin),HOME:home,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,HIVE_V2_SERVICE_DIR:unitDir,HIVE_V2_SERVICE_LABEL:label,HIVE_STORE_ROOT:root,HIVE_V2_DATA_DIR:data};
Object.assign(process.env,env);
const managerExec=async(cmd,args)=>{assert.ok(unitDir.startsWith(home+'/')&&label.startsWith('dev.honeybee.lab.pinned.'));try{return{code:0,stdout:execFileSync(cmd,args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''};}catch(e){return{code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}};
const manager=createServiceManager(process.platform,{label,execArgs:[pin.path,join(runtime,'current','dist','cli.js'),'v2','daemon','run'],logPath:join(root,'daemon.log'),env}, {exec:managerExec,dir:unitDir,uid:process.getuid()});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,description,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await sleep(100);}throw Error('timed out '+description);}
function git(...args){return execFileSync('git',args,{cwd:join(root,'git'),encoding:'utf8',env:nativeNodeEnv()}).trim();}
function cli(version,bad){return `import {appendFileSync,writeFileSync} from 'node:fs';
import {createServiceManager} from ${JSON.stringify(pathToFileURL(join(repo,'v2/daemon/src/service.ts')).href)};
import {probeNativeNode,nodePinEnv,persistNodePin,resolveNodePin,validateDaemonNode,nativeNodeEnv,readNodeRepair} from ${JSON.stringify(pathToFileURL(join(repo,'dist/nodeRuntime.js')).href)};
import {execFileSync} from 'node:child_process';
const root=${JSON.stringify(root)},data=${JSON.stringify(data)},unitDir=${JSON.stringify(unitDir)},home=${JSON.stringify(home)},label=${JSON.stringify(label)},version=${JSON.stringify(version)};
if(!unitDir.startsWith(home+'/')||!label.startsWith('dev.honeybee.lab.pinned.'))throw Error('unsafe lab service path');
const env={...nativeNodeEnv(),...nodePinEnv(probeNativeNode(process.execPath)),HOME:home,XDG_CONFIG_HOME:home+'/.config'};
const exec=async(cmd,args)=>{try{return{code:0,stdout:execFileSync(cmd,args,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''};}catch(e){return{code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}};
const manager=createServiceManager(process.platform,{label,execArgs:[process.execPath,${JSON.stringify(join(runtime,'current','dist','cli.js'))},'v2','daemon','run'],logPath:root+'/daemon.log',env:{...env,HIVE_V2_DATA_DIR:data,LAB_VERSION:version}},{exec,dir:unitDir,uid:process.getuid()});
const verb=process.argv[4];
if(verb==='run'){
 try{resolveNodePin(data);}catch{const {runDaemon}=await import(${JSON.stringify(pathToFileURL(join(repo,'v2/daemon/src/main.ts')).href)});process.exit(await runDaemon(['--data-dir',data]));}
 const held=validateDaemonNode(data,true);if(held){console.error('held needs repair '+held);process.exit(0);}
 appendFileSync(${JSON.stringify(attempts)},version+'\\n');writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({pid:process.pid,version}));
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
}else if(verb==='install'){await manager.install();persistNodePin(data,probeNativeNode(process.execPath));}
else if(verb==='stop')await manager.stop();
else if(verb==='start'){if(${JSON.stringify(bad)}){console.error('forced post-stop start failure');process.exit(17);}await manager.start();}
else if(verb==='status'){const state=await manager.status();console.log(JSON.stringify({running:state.running,service:state,repair:readNodeRepair(data)}));}
`;}
let loaded=false,linked=false;
try{
 mkdirSync(runtime,{recursive:true});mkdirSync(data,{recursive:true});mkdirSync(join(root,'git'));
 git('init','-q');git('config','user.name','Pinned Lab');git('config','user.email','lab@example.invalid');
 writeFileSync(join(root,'git','version'),'old');git('add','.');git('commit','-qm','old fixture');const oldSha=git('rev-parse','HEAD');
 writeFileSync(join(root,'git','version'),'new');git('commit','-qam','new fixture');const newSha=git('rev-parse','HEAD');
 const oldDir=join(runtime,oldSha);mkdirSync(join(oldDir,'dist'),{recursive:true});writeFileSync(join(oldDir,'dist','cli.js'),cli('old',false));writeFileSync(join(oldDir,'package.json'),JSON.stringify({type:'module'}));
 symlinkSync(oldSha,join(runtime,'current'));
 writeFileSync(join(runtime,'runtime-mode.json'),JSON.stringify({schemaVersion:1,runtime:'v2'}));
 writeFileSync(join(runtime,'deploys.json'),JSON.stringify({schemaVersion:1,entries:[{sha:oldSha,at:new Date().toISOString(),artifactHash:'fixture-old',by:'lab'}]}));
 persistNodePin(data,pin);await manager.install();
 const beforeUnit=readFileSync(manager.servicePath),beforeMode=statSync(manager.servicePath).mode&0o777;
 console.log('UNIT POLICY\n'+beforeUnit.toString());
 if(process.platform==='linux'){await managerExec('systemctl',['--user','--runtime','link',manager.servicePath]).then(r=>assert.equal(r.code,0,r.stderr));linked=true;}
 loaded=true;await manager.start();
 const before=await until(()=>{try{const p=JSON.parse(readFileSync(pidFile));process.kill(p.pid,0);return p;}catch{return null;}},'initial daemon');
 process.kill(before.pid,'SIGKILL');
 const respawn=await until(()=>{try{const p=JSON.parse(readFileSync(pidFile));if(p.pid===before.pid)return null;process.kill(p.pid,0);return p;}catch{return null;}},'crash respawn');
 console.log(`CRASH RESPAWN PASS old=${before.pid} new=${respawn.pid}`);
 await assert.rejects(deployVersion({repoRoot:join(root,'git'),root:runtime,ref:newSha,hooks:{
  buildArtifact:async({workDir})=>{const artifactDir=join(workDir,'fixture');mkdirSync(join(artifactDir,'dist'),{recursive:true});writeFileSync(join(artifactDir,'dist','cli.js'),cli('new',true));writeFileSync(join(artifactDir,'package.json'),JSON.stringify({type:'module'}));return{artifactDir};},
  restartDaemon:restartDeployedDaemon},log:console.log}),/exited with 17/);
 const recovered=await until(()=>{try{const p=JSON.parse(readFileSync(pidFile));if(p.pid===respawn.pid||p.version!=='old')return null;process.kill(p.pid,0);return p;}catch{return null;}},'old daemon recovery');
 assert.equal(readlinkSync(join(runtime,'current')),oldSha);
 assert.deepEqual(readFileSync(manager.servicePath),beforeUnit);
 assert.equal(statSync(manager.servicePath).mode&0o777,beforeMode);
 console.log(`FULL DEPLOY RECOVERY PASS stopped=${respawn.pid} recovered=${recovered.pid} runtime=${oldSha} exact-service-bytes-and-mode-restored`);
 await manager.stop();loaded=false;
 persistNodePin(data,{...pin,version:'0.0.0'});
 loaded=true;await manager.start();
 await until(()=>{try{return JSON.parse(readFileSync(nodeRepairFile(data),'utf8')).state==='held';}catch{return false;}},'held record');
 await until(async()=>!(await manager.status()).running,'held daemon down');
 const held=readFileSync(nodeRepairFile(data),'utf8'),count=readFileSync(attempts,'utf8');
 const start=Date.now();
 for(let n=0;n<12;n++){await sleep(5000);assert.equal((await manager.status()).running,false);assert.equal(readFileSync(nodeRepairFile(data),'utf8'),held);assert.equal(readFileSync(attempts,'utf8'),count);}
 assert.equal(existsSync(join(data,'core.sqlite3')),false);assert.equal(existsSync(join(data,'hived.sock')),false);
 console.log(`DRIFT HOLD PASS elapsedMs=${Date.now()-start} real-runDaemon-entry exit=0 no-store-or-socket no-respawn held=${held.trim()}`);
 persistNodePin(data,pin);
}finally{
 if(loaded)await manager.stop();
 if(linked)await manager.uninstall();
 rmSync(root,{recursive:true,force:true});
 console.log('CLEANUP PASS disposable service removed '+label);
}

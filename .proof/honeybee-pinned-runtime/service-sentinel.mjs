import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readdirSync,readFileSync,readlinkSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
const realHome=process.env.REAL_SERVICE_HOME;
assert.ok(realHome&&isAbsolute(realHome)&&realHome!==process.env.HOME,'explicit real-home sentinel must differ from scratch HOME');
const metadata=path=>{const s=lstatSync(path,{bigint:true});return {mode:(s.mode&0o777n).toString(8),mtimeNs:s.mtimeNs.toString(),ino:s.ino.toString(),size:s.size.toString()};};
function tree(path){if(!existsSync(path))return {absent:true};const rows=[];function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){const full=join(dir,name),key=prefix+name,s=lstatSync(full);const row={name:key,...metadata(full)};if(s.isSymbolicLink())row.link=readlinkSync(full);else if(s.isDirectory()){rows.push(row);walk(full,key+'/');continue;}else row.sha256=createHash('sha256').update(readFileSync(full)).digest('hex');rows.push(row);}}walk(path);return {count:rows.length,hash:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};}
const systemd=join(realHome,'.config','systemd','user'),launchd=join(realHome,'Library','LaunchAgents');
const current=process.platform==='darwin'?launchd:systemd;
const realUnit=join(current,process.platform==='darwin'?'dev.honeybee.hive.v2.plist':'dev.honeybee.hive.v2.service');
const snapshot={systemd:tree(systemd),launchd:tree(launchd),realUnit:{path:realUnit,...metadata(realUnit),sha256:createHash('sha256').update(readFileSync(realUnit)).digest('hex')}};
const active=process.platform==='darwin'?snapshot.launchd:snapshot.systemd;
assert.ok(active.count>0,'real service directory must be non-empty with real unit present');
const [mode,file]=process.argv.slice(2);
if(mode==='before')writeFileSync(file,JSON.stringify(snapshot));
else assert.deepEqual(snapshot,JSON.parse(readFileSync(file,'utf8')),'real service directories/unit changed during lab');
console.log('REAL SERVICE SENTINEL '+mode+' '+JSON.stringify(snapshot));

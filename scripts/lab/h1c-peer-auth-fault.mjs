import Module from 'node:module';
import {existsSync} from 'node:fs';
import assert from 'node:assert/strict';
const marker=process.env.H1C_AUTH_FAULT;
assert(marker?.startsWith('/var/tmp/'));
const load=Module._load;
Module._load=function(name,...args){
 const bridge=load.call(this,name,...args);
 if(typeof name==='string'&&name.endsWith('peercred.node'))return {...Object.fromEntries(Object.getOwnPropertyNames(bridge).map(key=>[key,bridge[key]])),inspect:fd=>existsSync(marker)?null:bridge.inspect(fd)};
 return bridge;
};

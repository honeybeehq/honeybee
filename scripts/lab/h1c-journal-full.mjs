import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const append=fs.appendFileSync;
fs.appendFileSync=function(path,data,...args){
 if(String(path).endsWith('.observations.jsonl')){
  let value;try{value=JSON.parse(String(data));}catch{}
  if(Number.isSafeInteger(value?.id)&&value.id>=1000&&('result' in value||'error' in value)){
   throw Object.assign(new Error('owned H1c fault-injected observation write failure'),{code:'ENOSPC'});
  }
 }
 return append.call(this,path,data,...args);
};
syncBuiltinESMExports();

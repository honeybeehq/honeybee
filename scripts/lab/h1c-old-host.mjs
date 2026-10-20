import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFileSync;
fs.writeFileSync=function(path,data,...args){
 if(String(path).endsWith('.status.json')){
  const status=JSON.parse(String(data));delete status.capabilities;data=JSON.stringify(status);
 }
 return write.call(this,path,data,...args);
};
syncBuiltinESMExports();

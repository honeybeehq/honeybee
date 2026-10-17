import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const [root,npmCli]=process.argv.slice(2);
const require=createRequire(npmCli),cacache=require('cacache'),ssri=require('ssri');
const lock=JSON.parse(await fs.readFile(path.join(root,'src/package-lock.json'),'utf8'));
const accepts=(v,t)=>!v?.length||(!v.includes('!'+t)&&(!v.some(x=>!x.startsWith('!'))||v.includes(t)||v.includes('any')));
const rows=[];
await fs.mkdir(path.join(root,'verified-tarballs'));
for(const [name,pkg] of Object.entries(lock.packages)){
 if(!name||!accepts(pkg.os,'darwin')||!accepts(pkg.cpu,'arm64'))continue;
 const url=new URL(pkg.resolved);
 if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password||url.port||url.search||url.hash||!pkg.resolved.startsWith('https://registry.npmjs.org/')||/[\x00-\x20\x7f-\uffff%?#\\]/.test(pkg.resolved)||!/^\/(?:@[a-z0-9._~-]+\/)?[a-z0-9._~+-]+\/-\/[a-zA-Z0-9._~+-]+[.]tgz$/.test(url.pathname)||!pkg.integrity||pkg.link)throw Error('registry provenance refused: '+name);
 const data=await cacache.get.byDigest(path.join(root,'npm/_cacache'),pkg.integrity);
 if(!ssri.checkData(data,pkg.integrity))throw Error('lock integrity refused: '+name);
 const file=String(rows.length).padStart(4,'0')+'.tgz';
 await fs.writeFile(path.join(root,'verified-tarballs',file),data);
 rows.push({path:name,version:pkg.version,resolved:pkg.resolved,integrity:pkg.integrity,sha256:crypto.createHash('sha256').update(data).digest('hex'),file});
}
if(!rows.length)throw Error('empty Darwin inventory');
await fs.writeFile(path.join(root,'integrity.json'),JSON.stringify(rows,null,2)+'\n');


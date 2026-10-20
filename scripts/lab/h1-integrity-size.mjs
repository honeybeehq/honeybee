import {openCoreStore} from '../../v2/core/src/index.ts';
import {join} from 'node:path';
import {mkdtempSync,statSync} from 'node:fs';
const root=mkdtempSync(join(process.cwd(),'.audit/h1/integrity-size-'));
const store=openCoreStore(join(root,'core.sqlite3'));
store.db.exec('CREATE TABLE h1_lab_payload (payload BLOB)');
const insert=store.db.prepare('INSERT INTO h1_lab_payload VALUES (zeroblob(?))');
for(let i=0;i<256;i++)insert.run(1024*1024);
store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
for(let run=0;run<3;run++){const start=performance.now();const check=store.quickCheck();console.log(JSON.stringify({case:'normal-durability-sized-sqlite-quick-check',run,bytes:statSync(store.path).size,durationMs:performance.now()-start,check,exclusiveWriter:true}));if(!check.ok)throw Error('bad integrity');}
store.close();

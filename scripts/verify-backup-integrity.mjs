#!/usr/bin/env node
/** Fresh disposable fixture workdir in this Cell; no checkout, service or real repository changes. */
import {mkdirSync,mkdtempSync,symlinkSync,unlinkSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),evidence=join(root,'.audit/backup-b9');mkdirSync(evidence,{recursive:true});
const fresh=mkdtempSync(join(evidence,'fresh-')),alias=join('/tmp','hb-b9-'+randomBytes(6).toString('hex'));
symlinkSync(fresh,alias);mkdirSync(join(fresh,'tmp'));
for(const name of['scripts','v2','deploy','dist','package.json'])symlinkSync(join(root,name),join(fresh,name));
const restic=process.env.HIVE_TEST_RESTIC??join(root,'.audit/backup-b2/tools/restic'),server=process.env.HIVE_TEST_REST_SERVER??join(root,'.audit/backup-b2/tools/rest-server_0.14.0_linux_amd64/rest-server');
let result;try{
 if(existsSync(join(fresh,'.audit/backup-b6')))throw Error('fixture must start without backup-b6');
 result=spawnSync(process.execPath,[join(root,'scripts/verify-backup-service.mjs')],{cwd:fresh,stdio:'inherit',env:{...process.env,HIVE_TEST_B9:'1',HIVE_TEST_RESTIC:restic,HIVE_TEST_REST_SERVER:server,TMPDIR:join(alias,'tmp')}});
 if(result.status===0){copyFileSync(join(fresh,'.audit/backup-b9/holds.json'),join(evidence,'holds.json'));copyFileSync(join(fresh,'.audit/backup-b6/loopback-summary.json'),join(evidence,'loopback-summary.json'));}
}finally{unlinkSync(alias);for(const name of['scripts','v2','deploy','dist','package.json'])unlinkSync(join(fresh,name));}
if(result?.error||result?.status!==0)process.exit(result?.status??2);
const unit=spawnSync(process.execPath,['--test','v2/daemon/tests/backup-integrity.test.ts'],{stdio:'inherit'});if(unit.error||unit.status!==0)process.exit(unit.status??2);
process.stdout.write('PASS: fresh runner, scope-matched integrity holds, failed-drill email and disposable eviction/recovery.\n');

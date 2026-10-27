#!/usr/bin/env node
/** B8: disposable loopback only. Does not install, contact real hosts or restore real data. */
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const evidence=resolve('.audit/backup-b8');mkdirSync(evidence,{recursive:true});
const restic=process.env.HIVE_TEST_RESTIC??(existsSync('.audit/backup-b2/tools/restic')?resolve('.audit/backup-b2/tools/restic'):'restic');
const server=process.env.HIVE_TEST_REST_SERVER??(existsSync('.audit/backup-b2/tools/rest-server_0.14.0_linux_amd64/rest-server')?resolve('.audit/backup-b2/tools/rest-server_0.14.0_linux_amd64/rest-server'):'rest-server');
for(const [command,args]of[[restic,['version']],[server,['--version']]]){const result=spawnSync(command,args,{stdio:'pipe'});if(result.error||result.status!==0){process.stderr.write('Local restic and rest-server are required; set HIVE_TEST_RESTIC and HIVE_TEST_REST_SERVER.\n');process.exit(2);}}
const env={...process.env,HIVE_TEST_RESTIC:restic,HIVE_TEST_REST_SERVER:server,HIVE_TEST_B8:'1',HIVE_TEST_BACKUP_EVIDENCE:evidence};
for(const args of[['scripts/verify-backup-service.mjs'],['--test','v2/daemon/tests/backup-client.test.ts','v2/daemon/tests/backup-verification.test.ts']]){const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});if(result.error||result.status!==0)process.exit(result.status??2);}
process.stdout.write('PASS: authenticated capacity, durable signed drills and owner-mediated staged restore; disposable fixtures only.\n');

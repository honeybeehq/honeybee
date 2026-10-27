import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
for(const name of ['HIVE_TEST_RESTIC','HIVE_TEST_REST_SERVER'])if(!process.env[name]||!existsSync(process.env[name]))throw Error(name+' must point to a disposable loopback test binary');
const helper=spawnSync('/usr/bin/python3',['scripts/verify-writer-fence.py'],{stdio:'inherit',env:process.env});if(helper.status!==0)process.exit(helper.status??1);
const result=spawnSync(process.execPath,['--test','v2/daemon/tests/backup-service.test.ts','v2/daemon/tests/backup-authority.test.ts','v2/daemon/tests/backup-service-loopback.test.ts','v2/daemon/tests/backup-writer-quota.test.ts'],{stdio:'inherit',env:process.env});process.exitCode=result.status??1;

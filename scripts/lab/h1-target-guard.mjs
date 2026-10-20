import assert from 'node:assert/strict';
import {mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=mkdtempSync(join(process.env.TMPDIR,'h1-target-'));
const result=spawnSync(process.execPath,['--experimental-strip-types','--import','./scripts/lab/h1-target-spoof.mjs','v2/daemon/src/bin.ts','--data-dir',root],{encoding:'utf8',env:{...process.env,HIVE_NODE_PATH:process.execPath,HIVE_V2_DATA_DIR:root},timeout:15000});
const output=result.stdout+result.stderr;assert.notEqual(result.status,0);assert.match(output,/build target h1-wrong-target differs from runtime target/);assert.equal(existsSync(join(root,'core.sqlite3')),false);
console.log(JSON.stringify({case:'cross-target-daemon-rejected-before-store',exit:result.status,storeCreated:false,diagnostic:output.split('\n').find(x=>x.includes('build target'))}));

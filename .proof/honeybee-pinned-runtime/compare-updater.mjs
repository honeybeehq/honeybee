import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { renderSystemdUnit } from '../../v2/daemon/src/service.ts';
const root = process.env.LAB_ROOT;
const old = await import(pathToFileURL(`${root}/old-service.ts`).href);
const spec = {label:'dev.honeybee.hive.v2',execArgs:['/managed/node/24.18.0/bin/node','/packages/old/dist/cli.js','v2','daemon','run','--data-dir','/scratch/.hive/v2'],logPath:'/scratch/.hive/logs/hived.log',env:{HOME:'/scratch',PATH:'/managed/node/24.18.0/bin:/usr/bin',HIVE_NODE_PATH:'/managed/node/24.18.0/bin/node',HIVE_NODE_VERSION:'24.18.0',HIVE_NODE_SHA256:'a'.repeat(64)}};
writeFileSync(`${root}/updater-old.service`,old.renderSystemdUnit(spec));
spec.execArgs[1]='/packages/new/dist/cli.js';
writeFileSync(`${root}/deploy-new.service`,renderSystemdUnit(spec));

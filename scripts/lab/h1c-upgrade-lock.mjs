import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {openCoreStore} from '../../v2/core/src/index.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'),'set an owned TMPDIR');
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-lock-'));const path=join(root,'core.sqlite');
const old=openCoreStore(path);
old.createBee({id:'bee',name:'old-writer',agent:'stub',substrate:'hsr',cwd:root});
old.db.exec("DELETE FROM meta WHERE key IN ('confirmation_legacy_max_message_id','confirmation_legacy_generations','confirmation_legacy_heads'); UPDATE meta SET value='46' WHERE key='schema_version'");
assert.throws(()=>openCoreStore(path),/locked/i);
assert.equal(old.db.prepare("SELECT value FROM meta WHERE key='confirmation_legacy_max_message_id'").get(),undefined);
const late=old.send('bee','accepted after attempted early opener').message;
old.close();
const successor=openCoreStore(path);
try{
 assert.equal(successor.db.prepare("SELECT value FROM meta WHERE key='confirmation_legacy_max_message_id'").get().value,String(late.id));
 assert.equal(successor.deliveryMayPredateConfirmation(late.id),true);
 console.log(JSON.stringify({case:'exclusive-writer-fences-upgrade-watermark',secondOpener:'database_locked',watermarkNotCapturedEarly:true,lateOldWriterMessageIncluded:true,watermark:late.id,integrity:successor.quickCheck().ok?'ok':'failed',root}));
}finally{successor.close();}

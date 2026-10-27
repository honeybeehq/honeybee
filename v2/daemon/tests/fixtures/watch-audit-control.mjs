import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { CoreStore } from '../../../core/src/store.ts';

const original = CoreStore.prototype.auditRows;
CoreStore.prototype.auditRows = function (fromSeq, limit, maxBytes) {
  const path = process.env.HIVE_TEST_WATCH_AUDIT_CONTROL;
  if (path && existsSync(path)) {
    const control = JSON.parse(readFileSync(path, 'utf8'));
    unlinkSync(path);
    if (control.kind === 'delete-first') this.db.prepare('DELETE FROM audit WHERE seq=(SELECT MIN(seq) FROM audit WHERE seq>?)').run(fromSeq);
    else if (control.kind === 'thread-operation') {
      this.db.prepare('INSERT INTO audit(ts,kind,bee_id,payload) VALUES(1,?,NULL,?)').run('thread_operation.put', JSON.stringify({ operation: { id: 'generated-operation', phase: 'done' }, row: { worker: 'private-worker', path: '/private-generated-path' } }));
    } else throw new Error('Unknown generated watch control');
  }
  return original.call(this, fromSeq, limit, maxBytes);
};

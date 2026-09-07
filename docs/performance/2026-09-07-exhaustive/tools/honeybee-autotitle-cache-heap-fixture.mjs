import assert from 'node:assert/strict';
import { writeHeapSnapshot } from 'node:v8';
import { setImmediate } from 'node:timers/promises';
assert.equal(typeof globalThis.gc,'function');
function buildFixture() {
  const quietBaselines = new Map();
  for (let i=0;i<3;i++) quietBaselines.set(`fixture-bee-${i}`, { membership: {kind:'committed',messageCount:i,maxMessageId:i||null},signature:`active\0${i}\0fixture-${i}` });
  return () => quietBaselines.size;
}
globalThis.heapFixtureDispatcher=buildFixture();
assert.equal(globalThis.heapFixtureDispatcher(),3);
writeHeapSnapshot('/tmp/honeybee-autotitle-cache-heap-fixture-warm.heapsnapshot');
globalThis.heapFixtureDispatcher=null;
await setImmediate();globalThis.gc();await setImmediate();
writeHeapSnapshot('/tmp/honeybee-autotitle-cache-heap-fixture-released.heapsnapshot');

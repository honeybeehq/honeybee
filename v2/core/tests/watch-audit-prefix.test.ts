import { test } from "node:test";
import assert from "node:assert/strict";
import { openCoreStore } from "../src/index.ts";
import { makeBee } from "./helpers.ts";

for (const size of [20000, 60000]) test(`watch audit prefix decodes each retained ${size}-byte payload once`, () => {
  const store = openCoreStore(":memory:");
  try {
    const bee = makeBee(store).bee;
    const start = store.lastAuditSeq();
    const body = "ø".repeat(size / 2);
    store.transact(() => {
      for (let i = 0; i < 512; i++) store.createSeal(bee.id, { id: `generated-${i}`, title: `Generated ${i}`, body });
    });
    let cursor = start, decodedRows = 0, batches = 0, sqliteReadMs = 0;
    while (cursor < store.lastAuditSeq()) {
      const readAt = performance.now();
      const rows = store.auditRows(cursor, 256, 128 * 1024);
      sqliteReadMs += performance.now() - readAt;
      assert.ok(rows.length > 0 && rows.length <= Math.floor(128 * 1024 / size));
      for (const row of rows) {
        assert.equal(row.seq, ++cursor);
        assert.equal((row.payload.seal as { body: string }).body, body);
      }
      decodedRows += rows.length; batches++;
    }
    assert.equal(decodedRows, 512);
    console.log(JSON.stringify({ watchAuditPrefix: { size, decodedRows, emittedRows: 512, batches, sqliteReadMs, scope: "native SQLite query plus mapAudit decode; shared-host recipe timing", amplification: decodedRows / 512 } }));
  } finally { store.close(); }
});

test("watch audit byte prefix preserves a large indivisible row and the following cursor", () => {
  const store = openCoreStore(":memory:");
  try {
    const bee = makeBee(store).bee;
    const start = store.lastAuditSeq();
    const body = "🦋".repeat(100000);
    store.createSeal(bee.id, { id: "large", title: "Generated large", body });
    store.createSeal(bee.id, { id: "small", title: "Generated small", body: "generated" });
    const large = store.auditRows(start, 256, 128 * 1024);
    assert.equal(large.length, 1);
    assert.equal((large[0]!.payload.seal as { body: string }).body, body);
    const small = store.auditRows(large[0]!.seq, 256, 128 * 1024);
    assert.equal(small.length, 1);
    assert.equal(small[0]!.seq, large[0]!.seq + 1);
    assert.deepEqual(store.auditRows(small[0]!.seq, 256, 128 * 1024), []);
    assert.equal(store.auditRows(start, 1, 128 * 1024).length, 1);
  } finally { store.close(); }
});

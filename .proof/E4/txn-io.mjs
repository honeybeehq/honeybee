import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
const transactions = new Set();
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function(sql) {
  const result = exec.call(this, sql);
  if (/^BEGIN(?:\s|;|$)/i.test(sql.trim())) transactions.add(this);
  if (/^(?:COMMIT|ROLLBACK)(?:\s|;|$)/i.test(sql.trim())) transactions.delete(this);
  return result;
};
for (const method of ["copyFileSync", "cpSync", "linkSync"]) {
  const original = fs[method];
  fs[method] = function(...args) {
    if (typeof args[0] === "string" && (args[0].endsWith(".jsonl") || args[0].includes("/projects/"))) {
      fs.appendFileSync(process.env.E4_IO_PROOF, JSON.stringify({ pid: process.pid, method, activeWriteTransactions: transactions.size }) + "\n");
      assert.equal(transactions.size, 0, "transcript IO must precede the SQLite/idempotency write transaction");
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

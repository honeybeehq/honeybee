import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDaemonDir, startDaemon } from "../../daemon/tests/helpers.ts";
import { runV2Cli } from "../src/main.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { StoreBackupError } from "../../core/src/storeBackup.ts";
import { toRpcError } from "../../daemon/src/rpc.ts";

const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
};

test("store maintenance CLI uses owner RPC; restore refuses live daemon and succeeds offline", async () => {
  const h = makeDaemonDir();
  const daemon = await startDaemon(h.dir);
  try {
    const backup = capture();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--json"], backup.io), 0, backup.err.join("\n"));
    const receipt = JSON.parse(backup.out[0]!);
    assert.equal(receipt.integrityCheck, "ok");
    assert.equal(JSON.parse(readFileSync(receipt.receiptPath, "utf8")).sha256, receipt.sha256);
    const denied = capture();
    assert.equal(await runV2Cli(["store", "restore", "--data-dir", h.dir, "--from", receipt.receiptPath, "--json"], denied.io), 1);
    assert.equal(JSON.parse(denied.out[0]!).error.code, "store_restore_refused");
    await daemon.stop();
    const restored = capture();
    assert.equal(await runV2Cli(["store", "restore", "--data-dir", h.dir, "--from", receipt.receiptPath, "--json"], restored.io), 0, restored.err.join("\n"));
    assert.match(JSON.parse(restored.out[0]!).lossWindow, /after the backup are discarded/);
    openCoreStore(receipt.storePath).close();
  } finally { await daemon.stop(); h.cleanup(); }
});

test("backup failures preserve their typed RPC error", () => {
  assert.equal(toRpcError(new StoreBackupError("disk full")).code, "store_backup_failed");
});

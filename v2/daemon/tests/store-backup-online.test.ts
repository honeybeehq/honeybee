import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INBOX_AGENT, openCoreStore } from "../../core/src/index.ts";
import type { StoreBackupReceipt } from "../../core/src/storeBackup.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import type { ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("store.backup copies and verifies off the loop: the daemon keeps answering while it runs", { timeout: 180_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  const clients: RpcClient[] = [];
  let daemon: DaemonHandle | null = null;
  try {
    const storePath = join(dir, "core.sqlite3");
    const store = openCoreStore(storePath, { ephemeral: true });
    store.createBee({ id: "inbox", name: "inbox", agent: INBOX_AGENT, substrate: "hsr", cwd: "" });
    const body = "x".repeat(60_000);
    while (statSync(storePath).size < 64 * 1024 * 1024) store.transact(() => { for (let i = 0; i < 50; i++) store.send("inbox", body, { sender: "operator" }); });
    const seeded = store.undeliveredMessages("inbox").length;
    store.close();

    daemon = await startDaemon(dir);
    const admin = await daemon.client(); clients.push(admin);
    const reader = await daemon.client(); clients.push(reader);
    const writer = await daemon.client(); clients.push(writer);

    let done = false;
    let answered = 0;
    let slowest = 0;
    const reading = (async () => {
      while (!done) {
        const started = performance.now();
        const view = await reader.request<ViewResult>("view", { beeId: "inbox" });
        assert.equal(view.bee?.id, "inbox");
        slowest = Math.max(slowest, performance.now() - started);
        if (!done) answered += 1;
        await new Promise((resume) => setTimeout(resume, 2));
      }
    })();
    const sent = writer.request<{ messageId: number }>("send", { beeId: "inbox", body: "during the backup", sender: "operator" });
    const receipt = await admin.request<StoreBackupReceipt>("store.backup", {}, 120_000);
    done = true;
    await reading;
    assert.equal(typeof (await sent).messageId, "number");

    assert.ok(answered >= 5, `${answered} reads were answered while the backup ran`);
    assert.equal(receipt.integrityCheck, "ok");
    const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("PRAGMA journal_mode").get()?.journal_mode, "delete");
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      const copied = Number(snapshot.prepare("SELECT COUNT(*) AS n FROM mailbox").get()?.n);
      assert.ok(copied === seeded || copied === seeded + 1, `${copied} of ${seeded} messages`);
      assert.equal(Number(snapshot.prepare("SELECT COUNT(*) AS n FROM mail_history_enqueues").get()?.n), copied);
    } finally { snapshot.close(); }
    assert.deepEqual(readdirSync(`${storePath}.backups`).filter((name) => !/\.(sqlite3|json)$/.test(name)), []);
    assert.doesNotMatch(readFileSync(join(dir, "hived.log"), "utf8"), /store\.backup\.blocking/);

    const [first, second] = await Promise.allSettled([admin.request<StoreBackupReceipt>("store.backup", {}, 120_000), writer.request<StoreBackupReceipt>("store.backup", {}, 120_000)]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.match(String((second as PromiseRejectedResult).reason?.message), /already running/);
    assert.ok(slowest < 2_000, `slowest read ${Math.round(slowest)} ms`);
  } finally { clients.forEach((client) => client.close()); await daemon?.stop(); cleanup(); }
});

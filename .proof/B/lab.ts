import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/B");
const repo = resolve(".");
const summaries: unknown[] = [];
for (const name of ["progress", "replay", "between", "restart", "stop"]) {
  const gate = join(process.env.TMPDIR!, `quota-gate-${name}`);
  if (name === "restart" || name === "stop") writeFileSync(gate, "pause continuation");
  const { dir } = makeDaemonDir({ accounts: { allocationMode: "shadow" }, agents: { claude: {
    command: process.execPath,
    args: [join(repo, name === "between" ? ".proof/B/between-harness.mjs" : "v2/driver-hsr/test-agent/fake-claude.mjs")],
    adapter: "claude", env: { FAKE_QUOTA_ONCE_PATH: join(process.env.TMPDIR!, `once-${name}`), FAKE_QUOTA_RESETS_AT: "2030-01-01T00:00:00.000Z" },
  } } });
  writeFileSync(join(proof, `${name}.root.log`), dir);
  for (const label of ["a", "b"]) {
    const vault = join(dir, "vault", "claude", `claude-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, ".credentials.json"), JSON.stringify({claudeAiOauth:{accessToken:`fixture-${label}`,expiresAt:4102444800000}}));
  }
  let daemon = await startDaemon(dir, { env: { B_QUOTA_PAUSE_PATH: gate } });
  let client = await daemon.client();
  const logs: string[] = [];
  try {
    for (const label of ["a", "b"]) await client.request("account.add", { harness: "claude", label, importExisting: true });
    const bee = await client.request<any>("spawn", { name: `lab-${name}`, agent: "claude", cwd: dir, account: "claude-a" });
    const body = name === "progress" || name === "restart" || name === "stop" ? "@quota:delayed preserve work" : name === "replay" ? "@quota:once exact original" : "between-turn warm up";
    const original = await client.request<any>("send", { beeId: bee.beeId, body });
    const getRecovery = async () => {
      const snapshot = await client.request<any>("snapshot", {});
      return snapshot.quotaRecoveries.find((row: any) => row.beeId === bee.beeId);
    };
    if (name === "restart" || name === "stop") {
      const rotating = await waitFor(async () => {
        const row = await getRecovery();
        const view = await client.request<any>("view", { beeId: bee.beeId });
        return row?.state === "rotating" && view.view.generation === 2 && view.view.runtimeState === "idle" ? row : null;
      }, `${name} rebound before enqueue`, 15000);
      assert.deepEqual(rotating.continuationMessageIds, []);
      writeFileSync(join(proof, `${name}.before.json`), JSON.stringify(rotating, null, 2));
      if (name === "restart") {
        client.close();
        await daemon.kill();
        logs.push(daemon.output());
        renameSync(gate, `${gate}.trashed`);
        daemon = await startDaemon(dir, { env: { B_QUOTA_PAUSE_PATH: gate } });
        client = await daemon.client();
      } else {
        await client.request("stop", { beeId: bee.beeId });
        renameSync(gate, `${gate}.trashed`);
      }
    }
    const settled = await waitFor(async () => {
      const row = await getRecovery();
      return row?.state === (name === "stop" ? "cancelled" : "resumed") ? row : null;
    }, `${name} settles`, 20000);
    if (name === "stop") assert.deepEqual(settled.continuationMessageIds, []);
    else if (name === "between") {
      assert.equal(settled.interrupted, false);
      assert.equal(settled.continuationKind, "none");
      assert.deepEqual(settled.continuationMessageIds, []);
    } else {
      assert.equal(settled.continuationMessageIds.length, 1);
      assert.equal(settled.continuationKind, name === "replay" ? "replay" : "continue");
      await waitFor(async () => {
        const inbox = await client.request<any>("mailbox", { beeId: bee.beeId });
        return inbox.messages.some((m: any) => m.id === settled.continuationMessageIds[0] && m.deliveredGeneration === 2) ? true : null;
      }, `${name} continuation delivered`, 15000);
    }
    const mail = await client.request<any>("mailbox", { beeId: bee.beeId });
    if (name === "replay") assert.equal(mail.messages.find((m: any) => m.id === settled.continuationMessageIds[0]).body, body);
    const audit = await client.request<any>("audit.tail", { beeId: bee.beeId, limit: 1000 });
    const resumed = audit.rows.filter((r: any) => r.kind === "quota.recovery" && r.payload.recovery.state === "resumed");
    assert.equal(resumed.length, name === "stop" ? 0 : 1);
    assert.equal(audit.rows.filter((r: any) => r.kind === "action.report").length, 0);
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify({ original, recovery: settled, mail, audit }, null, 2));
    const journal = join(dir, "session-logs", `${bee.beeId}.jsonl`);
    if (existsSync(journal)) writeFileSync(join(proof, `${name}.journal.jsonl`), readFileSync(journal));
    summaries.push({ name, passed: true, kind: settled.continuationKind, continuationIds: settled.continuationMessageIds, obligation: settled.id });
    console.log(JSON.stringify(summaries.at(-1)));
  } finally {
    client.close();
    await daemon.stop();
    logs.push(daemon.output());
    writeFileSync(join(proof, `${name}.daemon.log`), logs.join("\nRESTART\n"));
    writeFileSync(join(proof, "summary.json"), JSON.stringify(summaries, null, 2));
  }
}

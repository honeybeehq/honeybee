import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { createTranscriptProjector } from "../../v2/driver-tmux/src/transcripts.ts";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const proof = resolve(".proof/B");
const repo = resolve(".");
const summaries: unknown[] = [];
for (const name of ["progress", "replay", "between", "restart", "stop", "boot-retry", "queued", "queued-early", "manual-swap", "archive", "postenqueue-stop", "synthetic-retry", "synthetic-delivered-failure"]) {
  const gate = join(process.env.TMPDIR!, `quota-gate-${process.pid}-${name}`);
  const gated = ["restart", "stop", "boot-retry", "queued", "manual-swap", "archive", "postenqueue-stop"].includes(name);
  const cancelled = ["stop", "manual-swap", "archive", "postenqueue-stop"].includes(name);
  const deliveryGate = `${gate}-delivery`;
  if (gated) writeFileSync(gate, "pause continuation");
  const { dir } = makeDaemonDir({ accounts: { allocationMode: "shadow" }, agents: { claude: {
    command: process.execPath,
    args: [join(repo, name === "between" ? ".proof/B/between-harness.mjs" : ["boot-retry", "synthetic-retry", "synthetic-delivered-failure"].includes(name) ? ".proof/B/boot-fail-harness.mjs" : "v2/driver-hsr/test-agent/fake-claude.mjs")],
    adapter: "claude", env: { B_BOOT_FAIL_AFTER_INPUT: name === "synthetic-delivered-failure" ? "1" : "0", B_BOOT_INPUT_LOG: join(proof, "synthetic-delivered-failure.received.log"), B_BOOT_DELAY_MS: name === "synthetic-retry" ? "300" : "0", B_BOOT_ONCE_PATH: join(process.env.TMPDIR!, `boot-${process.pid}-${name}`), FAKE_QUOTA_ONCE_PATH: join(process.env.TMPDIR!, `once-${process.pid}-${name}`), FAKE_QUOTA_RESETS_AT: "2030-01-01T00:00:00.000Z" },
  } } });
  writeFileSync(join(proof, `${name}.root.log`), dir);
  for (const label of ["a", "b"]) {
    const vault = join(dir, "vault", "claude", `claude-${label}`);
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, ".credentials.json"), JSON.stringify({claudeAiOauth:{accessToken:`fixture-${label}`,expiresAt:4102444800000}}));
  }
  let daemon = await startDaemon(dir, { env: { B_QUOTA_PAUSE_PATH: gate, B_DELIVERY_PAUSE_PATH: deliveryGate, B_SKIP_GEN_TWO_DELIVERY: name === "synthetic-retry" ? "1" : "0" } });
  let client = await daemon.client();
  const logs: string[] = [];
  try {
    for (const label of ["a", "b"]) await client.request("account.add", { harness: "claude", label, importExisting: true });
    const bee = await client.request<any>("spawn", { name: `lab-${name}`, agent: "claude", cwd: dir, account: "claude-a" });
    const body = name !== "replay" && name !== "between" ? "@quota:delayed preserve work" : name === "replay" ? "@quota:once exact original" : "between-turn warm up";
    const original = await client.request<any>("send", { beeId: bee.beeId, body });
    if (name === "queued-early") {
      await waitFor(async () => {
        const mail = await client.request<any>("mailbox", { beeId: bee.beeId });
        return mail.messages.some((m: any) => m.id === original.messageId && m.deliveredAt !== null) ? true : null;
      }, "original delivered before early queued mail", 15000);
      await waitFor(async () => {
        const tail = await client.request<any>("audit.tail", { beeId: bee.beeId, limit: 1000 });
        return tail.rows.some((r: any) => r.kind === "runtime.updated" && r.payload.runtime.bootEvidence === "real") ? true : null;
      }, "real source boot before queued idle mail", 15000);
      await client.request("send", { beeId: bee.beeId, body: "newer queued instruction", urgency: "idle" });
    }
    const getRecovery = async () => {
      const snapshot = await client.request<any>("snapshot", {});
      return snapshot.quotaRecoveries.find((row: any) => row.beeId === bee.beeId);
    };
    if (gated) {
      const rotating = await waitFor(async () => {
        const row = await getRecovery();
        const view = await client.request<any>("view", { beeId: bee.beeId });
        return row?.state === "rotating" && view.view.generation >= (name === "boot-retry" ? 3 : 2) && view.view.runtimeState === "idle" ? row : null;
      }, `${name} rebound before enqueue`, 15000);
      assert.deepEqual(rotating.continuationMessageIds, []);
      writeFileSync(join(proof, `${name}.before.json`), JSON.stringify(rotating, null, 2));
      if (name === "restart") {
        client.close();
        await daemon.kill();
        logs.push(daemon.output());
        renameSync(gate, `${gate}.trashed`);
        daemon = await startDaemon(dir, { env: { B_QUOTA_PAUSE_PATH: gate, B_DELIVERY_PAUSE_PATH: deliveryGate, B_SKIP_GEN_TWO_DELIVERY: name === "synthetic-retry" ? "1" : "0" } });
        client = await daemon.client();
      } else if (name === "stop") {
        await client.request("stop", { beeId: bee.beeId });
        renameSync(gate, `${gate}.trashed`);
      } else if (name === "manual-swap" || name === "archive") {
        if (name === "manual-swap") await client.request("bee.swapAccount", { beeId: bee.beeId, account: "claude-a" });
        else await client.request("archive", { beeId: bee.beeId });
        renameSync(gate, `${gate}.trashed`);
      } else if (name === "postenqueue-stop") {
        writeFileSync(deliveryGate, "pause delivery after enqueue");
        renameSync(gate, `${gate}.trashed`);
        await waitFor(async () => {
          const row = await getRecovery();
          return row?.state === "rotating" && row.continuationMessageIds.length === 1 ? row : null;
        }, "continuation enqueued before real boot", 15000);
        await client.request("stop", { beeId: bee.beeId });
        renameSync(deliveryGate, `${deliveryGate}.trashed`);
      } else {
        if (name === "queued") await client.request("send", { beeId: bee.beeId, body: "newer queued instruction" });
        renameSync(gate, `${gate}.trashed`);
      }
    }
    const settled = await waitFor(async () => {
      const row = await getRecovery();
      return row?.state === (cancelled ? "cancelled" : "resumed") ? row : null;
    }, `${name} settles`, 20000);
    if (cancelled) {
      if (name === "postenqueue-stop") assert.equal(settled.continuationMessageIds.length, 1);
      else assert.deepEqual(settled.continuationMessageIds, []);
    }
    else if (name === "between") {
      assert.equal(settled.interrupted, false);
      assert.equal(settled.continuationKind, "none");
      assert.deepEqual(settled.continuationMessageIds, []);
    } else {
      assert.equal(settled.continuationMessageIds.length, 1);
      assert.equal(settled.continuationKind, name === "replay" ? "replay" : "continue");
      await waitFor(async () => {
        const inbox = await client.request<any>("mailbox", { beeId: bee.beeId });
        return inbox.messages.some((m: any) => m.id === settled.continuationMessageIds[0] && m.deliveredGeneration === settled.successorGeneration) ? true : null;
      }, `${name} continuation delivered`, 15000);
    }
    const mail = await client.request<any>("mailbox", { beeId: bee.beeId });
    if (name === "replay") assert.equal(mail.messages.find((m: any) => m.id === settled.continuationMessageIds[0]).body, body);
    if (name.startsWith("queued")) await waitFor(async () => {
      const inbox = await client.request<any>("mailbox", { beeId: bee.beeId });
      return inbox.messages.some((m: any) => m.body === "newer queued instruction" && m.deliveredAt !== null) ? true : null;
    }, "queued mail delivered after continuation", 15000);
    const audit = await client.request<any>("audit.tail", { beeId: bee.beeId, limit: 1000 });
    if (name.startsWith("queued")) {
      const deliveries = audit.rows.filter((r: any) => r.kind === "mail.delivered");
      const continued = deliveries.findIndex((r: any) => r.payload.messageId === settled.continuationMessageIds[0]);
      const queued = deliveries.findIndex((r: any) => r.payload.messageId !== original.messageId && r.payload.messageId !== settled.continuationMessageIds[0]);
      assert.ok(continued >= 0 && queued > continued, "recovery mail precedes already queued newer instruction");
    }
    if (name === "synthetic-delivered-failure") {
      assert.ok(settled.successorGeneration >= 3);
      assert.equal(settled.continuationHistory.length, 1);
      assert.equal(settled.continuationHistory[0].generation, 2);
      assert.ok(readFileSync(join(proof, "synthetic-delivered-failure.received.log"), "utf8").includes("Continue the interrupted turn"));
      assert.ok(mail.messages.find((m: any) => m.id === settled.continuationHistory[0].messageIds[0]).deliveredGeneration === 2);
    }
    if (name === "synthetic-retry") {
      assert.ok(settled.successorGeneration >= 3);
      assert.ok(audit.rows.some((r: any) => r.kind === "quota.recovery" && r.payload.recovery.state === "rotating" && r.payload.recovery.successorGeneration === 2 && r.payload.recovery.continuationMessageIds.length === 1));
    }
    const resumed = audit.rows.filter((r: any) => r.kind === "quota.recovery" && r.payload.recovery.state === "resumed");
    assert.equal(resumed.length, cancelled ? 0 : 1);
    assert.equal(audit.rows.filter((r: any) => r.kind === "action.report").length, 0);
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify({ original, recovery: settled, mail, audit }, null, 2));
    const journal = join(dir, "session-logs", `${bee.beeId}.jsonl`);
    if (existsSync(journal)) {
      const native = readFileSync(journal, "utf8");
      writeFileSync(join(proof, `${name}.journal.jsonl`), native);
      const projector = createTranscriptProjector("claude");
      const projected = native.split("\n").flatMap(line => projector.pushLine(line));
      assert.ok(projected.some(event => event.kind === "quota" && event.sourceId === settled.sourceId));
    }
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

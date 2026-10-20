import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { createTranscriptProjector } from "../../v2/driver-tmux/src/transcripts.ts";

const proof = resolve(".proof/A");
const repo = resolve(".");
const reset = "2030-01-01T00:00:00.000Z";
const { dir } = makeDaemonDir({ agents: {
  claude: { command: process.execPath, args: [join(repo, "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: "claude", env: { FAKE_QUOTA_RESETS_AT: reset, FAKE_QUOTA_ONCE_PATH: join(proof, `once-claude-${process.pid}`) } },
  codex: { command: process.execPath, args: [join(repo, "v2/driver-hsr/test-agent/fake-codex.mjs")], adapter: "codex", env: { FAKE_QUOTA_RESETS_AT_SECONDS: "1893456000", FAKE_QUOTA_ONCE_PATH: join(proof, `once-codex-${process.pid}`) } }
} });
writeFileSync(join(proof, "lab-root.log"), dir + "\n");
const fixtureVault = join(dir, "vault", "claude", "claude-quota-lab");
mkdirSync(fixtureVault, { recursive: true });
writeFileSync(join(fixtureVault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "non-secret-lab-fixture", expiresAt: 4102444800000 } }));
const daemon = await startDaemon(dir);
const client = await daemon.client();
await client.request("account.add", { harness: "claude", label: "quota-lab", importExisting: true });
const cases = [
  ["structured-weekly", "claude", "@quota:weekly_event", "weekly"],
  ["weekly-local", "claude", "@quota:weekly_local", "weekly"],
  ["backpressure", "claude", "@quota:backpressure", null],
  ["unknown-status", "claude", "@quota:unknown_status", null],
  ["codex-weekly", "codex", "@quota:weekly", "weekly"],
  ["codex-weekly-only", "codex", "@quota:weekly_only", "weekly"],
  ["weekly", "claude", "@quota:weekly", "weekly"],
  ["five-hour", "claude", "@quota:five_hour", "five_hour"],
  ["bare-result", "claude", "@quota:result_five_hour", "five_hour"],
  ["mid-turn", "claude", "@quota:delayed", "weekly"],
  ["quote", "claude", "@quota:quote", null],
  ["codex-native", "codex", "@quota:native", "five_hour"],
  ["codex-observed-native", "codex", "@usageLimit", "other"],
  ["codex-mid-turn", "codex", "@quota:delayed", "five_hour"],
  ["source-once", "claude", "@quota:once", "weekly"],
  ["destination-once", "claude", "@quota:once", null],
  ["source-once-codex", "codex", "@quota:once", "five_hour"],
  ["destination-once-codex", "codex", "@quota:once", null],
];
const summaries = [];
try {
  for (const [name, harness, body, expected] of cases) {
    const backpressure = name === "backpressure" || name === "unknown-status";
    const born = await client.request("spawn", { name: `lab-${name}`, agent: harness, cwd: dir, account: backpressure ? "claude-quota-lab" : null });
    const sent = await client.request("send", { beeId: born.beeId, body });
    const rows = await waitFor(async () => {
      const tail = await client.request("audit.tail", { beeId: born.beeId, limit: 1000 });
      const text = (() => { try { return readFileSync(join(dir, "session-logs", `${born.beeId}.jsonl`), "utf8"); } catch { return ""; } })();
      const view = await client.request("view", { beeId: born.beeId });
      const done = harness === "claude" ? text.includes('"type":"result"') : text.includes('"method":"turn/completed"');
      if (!done || view.view.runtimeState !== "idle") return null;
      const quota = tail.rows.filter(row => row.kind === "quota.observed");
      if (expected !== null && quota.length === 0) return null;
      if (harness === "codex" && expected !== null && !quota.some(row => row.payload.quota.providerCategory === "usageLimitExceeded")) return null;
      return { audit: tail.rows, text, view, quota };
    }, String(name), 20000);
    writeFileSync(join(proof, `${name}.rpc.json`), JSON.stringify({ born, sent, ...rows, text: undefined }, null, 2));
    writeFileSync(join(proof, `${name}.journal.jsonl`), rows.text);
    const outputJournal = readFileSync(join(dir, "runners", `${born.beeId}.1.observations.jsonl`), "utf8");
    writeFileSync(join(proof, `${name}.observations.jsonl`), outputJournal);
    for (const row of rows.quota) {
      const cursor = Number(row.payload.eventId.split(":").at(-1));
      const prefix = Buffer.from(outputJournal).subarray(0, cursor).toString("utf8").trimEnd();
      assert.ok(prefix.endsWith("}"));
      const native = JSON.parse(prefix.split("\n").at(-1));
      assert.ok(native.type === "assistant" || native.type === "result" || native.type === "rate_limit_event" || native.method === "account/rateLimits/updated" || native.method === "error" || native.method === "turn/completed");
    }
    const projector = createTranscriptProjector(String(harness));
    const projected = rows.text.split("\n").flatMap(line => projector.pushLine(line));
    projected.push(...projector.flush());
    writeFileSync(join(proof, `${name}.projection.json`), JSON.stringify(projected, null, 2));
    if (expected === null) {
      assert.equal(rows.quota.length, 0);
      if (backpressure) {
        assert.ok(rows.view.view.flags.includes("resource_blocked"));
        const account = await client.request("account.get", { id: "claude-quota-lab" });
        assert.equal(account.account.exhaustedAt, null);
        assert.equal(rows.view.view.generation, 1);
        writeFileSync(join(proof, `${name}.account.json`), JSON.stringify(account, null, 2));
      } else if (harness === "claude") assert.ok(projected.some(e => e.kind === "message" && e.role === "assistant"));
      else assert.ok(rows.text.includes('"status":"completed"'));
      assert.ok(!projected.some(e => e.kind === "quota"));
    } else {
      const expectedCount = name === "bare-result" ? 1 : harness === "codex" && name !== "codex-observed-native" ? 3 : 2;
      assert.equal(rows.quota.length, expectedCount);
      assert.equal(new Set(rows.quota.map(row => row.payload.eventId)).size, expectedCount);
      assert.ok(rows.quota.some(row => row.payload.quota.window === expected));
      if (name !== "codex-observed-native" && name !== "weekly-local") assert.ok(rows.quota.some(row => row.payload.quota.resetsAt === Date.parse(reset)));
      if (name === "structured-weekly") assert.ok(rows.quota.some(row => row.payload.quota.providerCategory === "rate_limit_event"));
      if (name === "weekly-local") assert.ok(rows.quota.every(row => row.payload.quota.resetsAt === null));
      if (harness === "codex") assert.ok(rows.quota.some(row => row.payload.quota.providerCategory === "usageLimitExceeded"));
      assert.ok(projected.some(e => e.kind === "quota"));
      assert.ok(!projected.some(e => e.kind === "message" && e.role === "assistant" && e.text.startsWith("You've hit")));
      assert.ok(!projected.some(e => e.kind === "interrupt"));
      if (String(name).includes("mid-turn")) assert.ok(rows.quota.some(row => row.payload.turn.progress === (harness === "claude" ? "some" : "unknown")));
      for (const row of rows.quota) assert.ok(row.payload.turn.messageIds.includes(sent.messageId));
    }
    summaries.push({ name, harness, evidence: rows.quota.map(row => row.payload), passed: true });
    console.log(JSON.stringify(summaries.at(-1)));
    await client.request("stop", { beeId: born.beeId });
  }
  const all = await client.request("audit.tail", { limit: 1000 });
  writeFileSync(join(proof, "audit-tail.json"), JSON.stringify(all, null, 2));
} finally {
  client.close();
  await daemon.stop();
  writeFileSync(join(proof, "daemon.log"), daemon.output());
  writeFileSync(join(proof, "summary.json"), JSON.stringify(summaries, null, 2));
}

const reopened = openCoreStore(daemon.storePath);
try {
  const event = summaries[0].evidence[0];
  const count = () => reopened.auditRows().filter(row => row.kind === "quota.observed").length;
  const before = count();
  reopened.recordQuotaEvidence(event);
  reopened.recordQuotaEvidence({ ...event, eventId: `${event.eventId}:stale`, generation: 0 });
  assert.equal(count(), before);
  writeFileSync(join(proof, "replay.log"), JSON.stringify({ before, after: count(), duplicateSuppressed: true, staleGenerationSuppressed: true }) + "\n");
} finally {
  reopened.close();
}

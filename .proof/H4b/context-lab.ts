import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeDaemonDir, startDaemon, waitFor } from "../../v2/daemon/tests/helpers.ts";

const root = process.env.HOME!;
if (!root || root !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(root)) throw new Error("Isolated HOME == TMPDIR under /var/tmp required");
const fake = resolve("v2/driver-hsr/test-agent/fake-claude.mjs");
const argvLog = join(root, `context-argv-${Date.now()}.jsonl`);
const { dir } = makeDaemonDir({ agents: { claude: { command: process.execPath, args: [fake, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], adapter: "claude", env: { FAKE_CLAUDE_ARGV_LOG: argvLog } } } });
for (const label of ["a", "b"]) {
  const vault = join(dir, "vault", "claude", `claude-${label}`);
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `FAKE-${label}`, expiresAt: 4102444800000 } }));
}
const daemon = await startDaemon(dir), client = await daemon.client();
try {
  const capability: any = await client.request("update.apiarySwap.status", {});
  assert.equal(capability.schemaVersion, 49);
  assert.equal(capability.storageSupported, true);
  for (const label of ["a", "b"]) await client.request("account.add", { harness: "claude", label, importExisting: true });
  const bee: any = await client.request("spawn", { name: "H4b-context", agent: "claude", cwd: dir, account: "claude-a" });
  const first: any = await client.request("send", { beeId: bee.beeId, body: "context fixture before rotation" });
  const sid = await waitFor(async () => {
    const mailbox: any = await client.request("mailbox", { beeId: bee.beeId });
    const view: any = await client.request("view", { beeId: bee.beeId });
    return mailbox.messages.some((m: any) => m.id === first.messageId && m.deliveredAt) && view.view.runtimeState === "idle" && view.bee.providerSessionId;
  }, "initial context");
  const swap: any = await client.request("bee.swapAccount", { beeId: bee.beeId, account: "claude-b", idempotencyKey: "H4b-context-swap" });
  assert.equal(swap.transcript, "copied");
  assert.equal(swap.action, "stop_then_revive");
  const next: any = await client.request("send", { beeId: bee.beeId, body: "continue context fixture" });
  const resumed: any = await waitFor(async () => {
    const mailbox: any = await client.request("mailbox", { beeId: bee.beeId });
    const view: any = await client.request("view", { beeId: bee.beeId });
    return mailbox.messages.some((m: any) => m.id === next.messageId && m.deliveredGeneration === 2) && view.view.runtimeState === "idle" && view.bee.providerSessionId !== sid ? view : null;
  }, "resumed generation 2");
  const boots = readFileSync(argvLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(boots.length, 2);
  assert.equal(boots[1].resumed, sid);
  assert.equal(boots[1].forked, true);
  assert.equal(resumed.bee.account, "claude-b");
  const key = dir.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
  const carried = join(dir, "homes", "claude-b", "projects", key, `${sid}.jsonl`);
  assert.equal(existsSync(carried), true);
  assert.ok(readFileSync(carried, "utf8").includes("context fixture before rotation"));
  console.log(JSON.stringify({ schemaVersion: capability.schemaVersion, storageSupported: capability.storageSupported, accountSwap: swap.action, transcript: swap.transcript, resumed: boots[1].resumed === sid, forked: boots[1].forked, contextSurvived: true, generation: resumed.view.generation }));
} finally { client.close(); await daemon.stop(); }

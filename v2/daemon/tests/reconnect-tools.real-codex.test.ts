import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import type { ReconnectToolsResult, SpawnResult, ViewResult } from "../src/protocol.ts";

// Real owner, detached runner host and installed Codex; only inference and the
// MCP server are fixtures. Never opens a production account, store or socket.
test("real Codex reconnect through Honeybee preserves the active conversation and refreshes model tools", {
  skip: process.env.HONEYBEE_REAL_CODEX_RECONNECT !== "1",
  timeout: 180_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "hb-reconnect-real-"));
  const home = join(root, "native"); mkdirSync(home);
  const generationFile = join(root, "generation"); writeFileSync(generationFile, "1");
  const fixture = fileURLToPath(new URL("../../driver-hsr/tests/harness/codex-mcp-reconnect.probe.mjs", import.meta.url));
  const requests: Array<{ tools?: unknown }> = [];
  let holdNext = false;
  let held: ServerResponse | null = null;
  function complete(res: ServerResponse): void {
    const id = requests.length;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  }
  const model = createServer((req, res) => {
    let body = "";
    req.on("data", data => body += data);
    req.on("end", () => {
      requests.push(JSON.parse(body));
      if (holdNext) { holdNext = false; held = res; } else complete(res);
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const address = model.address(); assert(address && typeof address !== "string");
  const shimArgs = [fixture, "--mcp", generationFile];
  writeFileSync(join(home, "config.toml"), `model_provider = "probe"
model = "probe"
[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[mcp_servers.apiary]
startup_timeout_sec = 60
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify(shimArgs)}
[mcp_servers.untouched]
enabled = false
command = "untouched-command"
[mcp_servers.untouched.env]
PRESERVED_SETTING = "untouched"
`);
  const gateways = join(root, "gateways"); mkdirSync(gateways);
  const registration = (args: string[]) => ({ name: "apiary", protocol: "mcp", gatewayRev: 1, startedAt: new Date().toISOString(), stateless: true, shim: { command: process.execPath, args }, env: {} });
  writeFileSync(join(gateways, "apiary.json"), JSON.stringify(registration(shimArgs)));
  const rig = makeDaemonDir({ agents: { codex: {
    command: process.env.CODEX_BIN ?? "codex", args: ["app-server"], adapter: "codex",
    env: { HOME: root, CODEX_HOME: home },
  } } });
  const daemon = await startDaemon(rig.dir, { env: { HOME: root, CODEX_HOME: home, HIVE_STORE_ROOT: root, HIVE_GATEWAYS_DISABLE: "0" } });
  const client = await daemon.client();
  t.after(async () => { client.close(); await daemon.stop(); rig.cleanup(); rmSync(root, { recursive: true, force: true }); });
  const bee = await client.request<SpawnResult>("spawn", { name: "reconnect-real-fixture", agent: "codex", cwd: root });
  async function idle(): Promise<ViewResult> {
    return waitFor(async () => {
      const view = await client.request<ViewResult>("view", { beeId: bee.beeId });
      return view.runtime?.state === "idle" && view.bee?.providerSessionId ? view : null;
    }, "real Codex idle", 60_000);
  }
  const original = await idle();
  const observationPath = join(rig.dir, "runners", `${bee.beeId}.${original.runtime!.generation}.observations.jsonl`);
  async function turn(): Promise<string> {
    const count = requests.length;
    await client.request("send", { beeId: bee.beeId, body: "Reply OK", urgency: "next" });
    await waitFor(() => requests.length > count, "real model request", 60_000);
    const view = await idle();
    assert.equal(view.runtime?.pid, original.runtime?.pid);
    assert.equal(view.runtime?.generation, original.runtime?.generation);
    assert.equal(view.bee?.providerSessionId, original.bee?.providerSessionId);
    return JSON.stringify(requests.at(-1)?.tools);
  }
  async function toolsAtGeneration(generation: number): Promise<string[]> {
    const observed = [await turn()];
    if (!observed[0]!.includes(`probe_generation_${generation}`)) {
      // Optional startup may miss the first model request. Wait for native
      // readiness only AFTER a normal turn has triggered the pending reload.
      await waitFor(() => {
        const statuses = readFileSync(observationPath, "utf8").split("\n")
          .filter(line => line.includes('"mcpServer/startupStatus/updated"'))
          .map(line => JSON.parse(line))
          .filter(event => event.params?.name === "apiary" && event.params?.threadId === original.bee?.providerSessionId);
        return statuses.at(-1)?.params?.status === "ready";
      }, `generation ${generation} native MCP ready`, 60_000, 100);
      observed.push(await turn());
    }
    assert(observed.at(-1)!.includes(`probe_generation_${generation}`), `No generation ${generation} tools after native readiness`);
    return observed;
  }
  const before = await toolsAtGeneration(1);
  holdNext = true;
  const activeTurn = turn();
  await waitFor(() => held !== null, "held active inference", 60_000);
  const newGenerationFile = join(root, "updated-artifact-generation");
  writeFileSync(newGenerationFile, "2");
  writeFileSync(join(gateways, "apiary.json"), JSON.stringify(registration([fixture, "--mcp", newGenerationFile])));
  const params = { beeId: bee.beeId, idempotencyKey: "real-reconnect-once" };
  const accepted = await client.request<ReconnectToolsResult>("bee.reconnectTools", params);
  assert.equal(accepted.state, "queued");
  assert.equal(accepted.receipt, null);
  assert.equal((await client.request<ReconnectToolsResult>("bee.reconnectTools", params)).commandId, accepted.commandId);
  complete(held!); held = null;
  await activeTurn;
  const receipt = await waitFor(async () => {
    const result = await client.request<ReconnectToolsResult>("bee.reconnectTools.get", { beeId: bee.beeId, commandId: accepted.commandId });
    return result.state === "done" || result.state === "failed" ? result : null;
  }, "real reconnect completion", 60_000);
  assert.equal(receipt.state, "done", JSON.stringify(receipt));
  assert.equal(receipt.receipt?.modelTools, "refresh_pending_next_turn");
  assert.equal(receipt.receipt?.threadId, original.bee?.providerSessionId);
  assert.deepEqual(receipt.receipt?.targets, ["apiary"]);
  const after = await toolsAtGeneration(2);
  assert.doesNotMatch(after.at(-1)!, /probe_generation_1/);
  assert.deepEqual(await client.request("bee.reconnectTools", params), receipt);
  writeFileSync(newGenerationFile, "3");
  const repeated = await client.request<ReconnectToolsResult>("bee.reconnectTools", { beeId: bee.beeId, idempotencyKey: "real-reconnect-twice" });
  const secondReceipt = await waitFor(async () => {
    const result = await client.request<ReconnectToolsResult>("bee.reconnectTools.get", { beeId: bee.beeId, commandId: repeated.commandId });
    return result.state === "done" || result.state === "failed" ? result : null;
  }, "second real reconnect completion", 60_000);
  assert.equal(secondReceipt.state, "done", JSON.stringify(secondReceipt));
  const unchangedRegistration = await toolsAtGeneration(3);
  const config = readFileSync(join(home, "config.toml"), "utf8");
  assert.match(config, /PRESERVED_SETTING = "untouched"/);
  assert.match(config, /HONEYBEE_MCP_RECONNECT_NONCE/);
  assert.match(config, /startup_timeout_sec = 60/);
  assert(config.includes(newGenerationFile), "native config API must preserve freshly seeded registration args");
  assert.doesNotMatch(config, /required = true/);
  const report = { ok: true, beeId: bee.beeId, pid: original.runtime?.pid, generation: original.runtime?.generation,
    threadId: original.bee?.providerSessionId, accepted, receipt, secondReceipt,
    before: before.map(value => [...value.matchAll(/probe_generation_\d+/g)].map(match => match[0])),
    after: after.map(value => [...value.matchAll(/probe_generation_\d+/g)].map(match => match[0])),
    unchangedRegistration: unchangedRegistration.map(value => [...value.matchAll(/probe_generation_\d+/g)].map(match => match[0])),
    unmodifiedOptionalPolicy: true, unrelatedConfigPreserved: true };
  if (process.env.HONEYBEE_RECONNECT_PROOF) writeFileSync(process.env.HONEYBEE_RECONNECT_PROOF, JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
});

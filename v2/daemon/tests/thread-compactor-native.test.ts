/** Opt-in real installed Codex, with a local scripted model endpoint and disposable home. No real credentials or model calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexAdapter } from "../../adapters/src/codex.ts";
import { compactThread } from "../src/threadCompactor.ts";
import { copyPinnedHistory, seedSuccessorHistory } from "../src/threadHistory.ts";
import { threadFixture } from "./thread-fixture.ts";

for (const mode of ["mock", "remote-mock", "remote-v1"] as const) test(`native Codex ${mode} compaction resumes deterministic copy and applies instruction`, { skip: !process.env.HIVE_TEST_NATIVE_CODEX, timeout: 60000 }, async t => {
  const f = threadFixture(t);
  const source = readFileSync(f.sourcePath, "utf8").split("\n");
  const meta = JSON.parse(source[0]!); meta.payload.model_provider = mode; source[0] = JSON.stringify(meta);
  writeFileSync(f.sourcePath, source.join("\n"));
  f.row.source.modelProvider = mode;
  f.row.source.bytes = Buffer.byteLength(source.join("\n"));
  await copyPinnedHistory(f.row); await seedSuccessorHistory(f.row);
  const before = readFileSync(f.sourcePath);
  const requests: any[] = [];
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body); paths.push(req.url ?? "");
    if (req.url?.includes("compact")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "cmp_test", object: "response.compaction", created_at: 1, output: [{ type: "message", role: "user", content: [{ type: "input_text", text: "SQLite chosen. Restart test remains." }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const item = mode === "remote-mock" ? { id: "cmp_test", type: "compaction", encrypted_content: "opaque-test-checkpoint", content: [] } : { id: "msg_summary", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SQLite was chosen. Continue with the restart test.", annotations: [] }] };
    for (const event of [
      { type: "response.created", response: { id: "resp_summary", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },

      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } } } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const home = join(f.root, "home"); mkdirSync(home);
  writeFileSync(join(home, "config.toml"), `model = "gpt-5.1-codex"\nmodel_provider = "${mode}"\nmodel_context_window = 128000\n[features]\nremote_compaction_v2 = ${mode !== "remote-v1"}\n[model_providers.${mode}]\nname = "${mode !== "mock" ? "OpenAI" : "mock"}"\nrequires_openai_auth = false\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`);
  let worker: unknown;
  await compactThread({ row: f.row, signal: new AbortController().signal, timeoutMs: 45000,
    recordWorker: value => { worker = value; },
    spec: { command: process.env.HIVE_TEST_NATIVE_CODEX === "1" ? "codex" : process.env.HIVE_TEST_NATIVE_CODEX!, args: ["app-server"], cwd: f.root,
      env: { ...process.env, CODEX_HOME: home }, adapter: codexAdapter({ cwd: f.root }) },
  });
  assert.ok(worker);
  if (mode === "remote-v1") assert.ok(paths.some(path => path.includes("compact")), JSON.stringify(paths));
  if (mode === "remote-mock") assert.match(JSON.stringify(requests), /compaction_trigger/);
  assert.ok(requests.length > 0, "real native compactor called the model endpoint");
  assert.match(JSON.stringify(requests), /Emphasize the restart test and the SQLite decision/);
  assert.match(JSON.stringify(requests), /You are a helpful coding assistant/);
  assert.deepEqual(readFileSync(f.sourcePath), before, "original remains byte-for-byte intact");
  const successor = readFileSync(f.row.sessionPath, "utf8");
  assert.match(successor, /"type":"compacted"/);
  assert.equal(JSON.parse(successor.split("\n")[0]!).payload.base_instructions.text, "You are a helpful coding assistant.");
  assert.equal(JSON.parse(successor.split("\n")[0]!).payload.id, f.row.successorProviderSessionId);
});

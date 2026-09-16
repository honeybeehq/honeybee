// Opt-in real Codex probe. All inference is served locally; no credentials required.
// Run: node codex-mcp-reconnect.probe.mjs [codex executable]
// Codex 0.154.0 schema gives reload no force parameter. Official API:
// https://learn.chatgpt.com/docs/app-server
// Native config/value/write is tested separately from raw-file edits.
// Refresh applies on the next active turn, not at reload acknowledgment.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

if (process.argv[2] === '--mcp') {
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result = {};
    if (message.method === 'initialize') result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'reconnect-fixture', version: '1' },
    };
    if (message.method === 'tools/list') result = { tools: [{
      name: `probe_generation_${readFileSync(process.argv[3], 'utf8').trim()}`,
      description: 'Deterministic reconnect fixture',
      inputSchema: { type: 'object', properties: {} },
    }] };
    if (message.method === 'resources/list') result = { resources: [] };
    if (message.method === 'resources/templates/list') result = { resourceTemplates: [] };
    const respond = () => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    if (message.method === 'initialize' && process.env.PROBE_GATE_STARTUP) {
      const gate = `${process.env.PROBE_GATE_STARTUP}-${readFileSync(process.argv[3], 'utf8').trim()}`;
      const timer = setInterval(() => { if (existsSync(gate)) { clearInterval(timer); respond(); } }, 10);
    } else respond();
  });
} else {
  await probe();
}

async function probe() {
  const exe = process.argv[2] || 'codex';
  const optional = process.argv[3] === '--optional';
  const home = mkdtempSync(join(tmpdir(), 'honeybee-codex-reconnect-'));
  const generationFile = join(home, 'generation');
  writeFileSync(generationFile, '1');
  const requests = [];
  const model = createServer((req, res) => {
    let body = '';
    req.on('data', data => body += data);
    req.on('end', () => {
      requests.push(JSON.parse(body));
      // Release optional startup only AFTER capturing the first model request.
      if (optional) writeFileSync(join(home, `release-${readFileSync(generationFile, 'utf8').trim()}`), 'ready');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
      for (const event of [
        { type: 'response.created', response: { id: `resp_${requests.length}`, status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const configPath = join(home, 'config.toml');
  writeFileSync(configPath, `model_provider = "probe"
model = "probe"
[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${model.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
[mcp_servers.reconnect_probe]
startup_timeout_sec = 60
required = ${!optional}
command = ${JSON.stringify(process.execPath)}
args = ${JSON.stringify([fileURLToPath(import.meta.url), '--mcp', generationFile])}
[mcp_servers.reconnect_probe.env]
PRESERVED_SETTING = "untouched"
${optional ? `PROBE_GATE_STARTUP = ${JSON.stringify(join(home, 'release'))}` : ''}
[mcp_servers.untouched]
enabled = false
command = "unused-fixture-command"
[mcp_servers.untouched.env]
PRESERVED_SETTING = "also-untouched"
`);
  const app = spawn(exe, ['app-server'], { env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pid = app.pid;
  const pending = new Map();
  const notifications = [];
  const protocol = [];
  let sequence = 0;
  let stderr = '';
  app.stderr.on('data', data => stderr += data);
  createInterface({ input: app.stdout }).on('line', line => {
    const message = JSON.parse(line);
    protocol.push({ direction: 'received', at: Date.now(), message });
    if (pending.has(message.id)) pending.get(message.id)(message);
    else notifications.push(message);
  });
  async function rpc(method, params) {
    const id = ++sequence;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 30000);
      pending.set(id, message => {
        clearTimeout(timer); pending.delete(id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
    });
    protocol.push({ direction: 'sent', at: Date.now(), id, method });
    app.stdin.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    return response;
  }
  async function wait(predicate) {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (app.exitCode !== null) throw new Error(`Codex exited: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`Turn timeout: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const report = { version: execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim(), home, pid };
  try {
    await rpc('initialize', { clientInfo: { name: 'reconnect-probe', version: '1' }, capabilities: { experimentalApi: true } });
    app.stdin.write('{"method":"initialized"}\n');
    const { thread } = await rpc('thread/start', { cwd: home, ephemeral: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
    report.threadId = thread.id;
    async function turn() {
      const start = notifications.length;
      const count = requests.length;
      const result = await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Reply OK', text_elements: [] }] });
      await wait(() => notifications.slice(start).some(n => n.method === 'turn/completed' && n.params.turn.id === result.turn.id));
      const completed = notifications.slice(start).find(n => n.method === 'turn/completed' && n.params.turn.id === result.turn.id);
      assert.equal(completed.params.threadId, thread.id);
      assert.equal(completed.params.turn.status, 'completed');
      assert.equal(requests.length, count + 1);
      assert.equal(app.pid, pid);
      assert.equal(app.exitCode, null);
      return JSON.stringify(requests.at(-1).tools);
    }
    const ready = start => wait(() => notifications.slice(start).some(n => n.method === 'mcpServer/startupStatus/updated' && n.params.threadId === thread.id && n.params.name === 'reconnect_probe' && n.params.status === 'ready'));
    if (optional) {
      report.initialPending = await turn();
      assert.doesNotMatch(report.initialPending, /probe_generation_/);
    }
    await ready(0);
    async function reload() {
      await rpc('config/mcpServer/reload');
      // Refresh is applied when the next turn starts; acknowledgment is not readiness.
    }
    report.before = await turn();
    assert.match(report.before, /probe_generation_1/);
    writeFileSync(generationFile, '2');
    await reload();
    report.unchangedReload = await turn();
    assert.match(report.unchangedReload, /probe_generation_1/);
    assert.doesNotMatch(report.unchangedReload, /probe_generation_2/);
    const original = (await rpc('config/read', { includeLayers: false })).config.mcp_servers;
    let refreshBoundary = notifications.length;
    report.write = await rpc('config/value/write', {
      keyPath: 'mcp_servers.reconnect_probe.env.HONEYBEE_MCP_RECONNECT_NONCE',
      value: 'reconnect-1', mergeStrategy: 'replace', filePath: configPath,
    });
    await reload();
    report.after = await turn();
    if (optional) {
      report.refreshPending = report.after;
      assert.doesNotMatch(report.refreshPending, /probe_generation_/);
      await ready(refreshBoundary);
      report.after = await turn();
    }
    assert.match(report.after, /probe_generation_2/);
    assert.doesNotMatch(report.after, /probe_generation_1/);
    const updated = (await rpc('config/read', { includeLayers: false })).config.mcp_servers;
    delete updated.reconnect_probe.env.HONEYBEE_MCP_RECONNECT_NONCE;
    assert.deepEqual(updated, original);
    // Reconnect again with the same registration and an existing nonce key.
    writeFileSync(generationFile, '3');
    refreshBoundary = notifications.length;
    await rpc('config/value/write', {
      keyPath: 'mcp_servers.reconnect_probe.env.HONEYBEE_MCP_RECONNECT_NONCE',
      value: 'reconnect-2', mergeStrategy: 'replace', filePath: configPath,
    });
    await reload();
    report.secondReconnect = await turn();
    if (optional) {
      await ready(refreshBoundary);
      report.secondReconnect = await turn();
    }
    assert.match(report.secondReconnect, /probe_generation_3/);
    assert.doesNotMatch(report.secondReconnect, /probe_generation_[12]/);
    // A raw on-disk nonce change is measured separately from the supported write API.
    writeFileSync(generationFile, '4');
    writeFileSync(configPath, readFileSync(configPath, 'utf8').replace('reconnect-2', 'reconnect-3'));
    await reload();
    report.diskReconnect = await turn();
    report.loaded = await rpc('thread/loaded/list', {});
    assert(report.loaded.data.includes(thread.id));
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = String(error);
    report.stderr = stderr.slice(-5000);
    process.exitCode = 1;
  } finally {
    app.stdin.end();
    app.kill('SIGTERM');
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
  }
  writeFileSync(join(home, 'protocol.json'), JSON.stringify(protocol, null, 2));
  writeFileSync(join(home, 'notifications.json'), JSON.stringify(notifications, null, 2));
  writeFileSync(join(home, 'model-requests.json'), JSON.stringify(requests, null, 2));
  for (const key of ['before', 'unchangedReload', 'after', 'secondReconnect', 'diskReconnect', 'initialPending', 'refreshPending']) {
    if (report[key]) report[key] = [...report[key].matchAll(/probe_generation_\d+/g)].map(match => match[0]);
  }
  console.log(JSON.stringify(report, null, 2));
}

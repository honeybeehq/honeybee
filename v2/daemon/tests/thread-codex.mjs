// Protocol-faithful disposable Codex peer. Every effect is confined to test paths.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const home = process.env.CODEX_HOME;
mkdirSync(home, { recursive: true });
const db = new DatabaseSync(join(home, 'state_5.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
const rl = createInterface({ input: process.stdin });
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (id, result) => emit({ jsonrpc: '2.0', id, result });
let threadId; let path;
const waitGate = async gate => { while (gate && !existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 15)); };
rl.on('close', () => process.exit(0));
rl.on('line', async line => {
  const m = JSON.parse(line);
  if (process.env.THREAD_RPC_LOG) appendFileSync(process.env.THREAD_RPC_LOG, JSON.stringify({ pid: process.pid, method: m.method, params: m.params }) + '\n');
  if (m.method === 'initialize') response(m.id, { userAgent: 'thread-test' });
  else if (m.method === 'thread/start') {
    threadId = randomUUID(); path = join(home, `${threadId}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id: threadId, model_provider: 'mock', base_instructions: { text: 'Source instructions' } } }) + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original history' }] } }) + '\n');
    db.prepare('INSERT INTO threads VALUES (?, ?)').run(threadId, path);
    response(m.id, { thread: { id: threadId, path } });
  } else if (m.method === 'thread/resume') {
    threadId = m.params.threadId; path = m.params.path ?? db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)?.rollout_path;
    if (JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).payload.id !== threadId) throw new Error('wrong successor identity');
    db.prepare('INSERT INTO threads VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET rollout_path = excluded.rollout_path').run(threadId, path);
    if (!m.params.config?.compact_prompt) await waitGate(process.env.THREAD_START_GATE);
    response(m.id, { thread: { id: threadId, path } });
  } else if (m.method === 'thread/compact/start') {
    if (process.env.THREAD_UNSUPPORTED_FILE && existsSync(process.env.THREAD_UNSUPPORTED_FILE)) {
      emit({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Native compaction is unavailable' } }); return;
    }
    response(m.id, {});
    emit({ method: 'turn/started', params: { threadId, turn: { id: 'compaction' } } });
    await waitGate(process.env.THREAD_COMPACT_GATE);
    if (process.env.THREAD_FAIL_FILE && existsSync(process.env.THREAD_FAIL_FILE)) {
      emit({ method: 'error', params: { threadId, error: { message: 'scripted compaction failure' } } }); return;
    }
    appendFileSync(path, JSON.stringify({ type: 'compacted', payload: { message: 'Compacted summary' } }) + '\n');
    emit({ method: 'item/completed', params: { threadId, item: { id: 'compact-item', type: 'contextCompaction' } } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id: 'compaction', status: 'completed', error: null } } });
  } else if (m.method === 'turn/start' || m.method === 'turn/steer') {
    const id = randomUUID();
    appendFileSync(path, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: m.params.input.map(x => ({ type: 'input_text', text: x.text })) } }) + '\n');
    response(m.id, { turn: { id } });
    emit({ method: 'turn/started', params: { threadId, turn: { id } } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', error: null } } });
  }
});

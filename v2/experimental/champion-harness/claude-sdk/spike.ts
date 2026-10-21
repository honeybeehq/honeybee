import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';

const cellRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const runtimeHome = join(cellRoot, '.audit/claude-sdk/home');
const runtimeTmp = join(cellRoot, '.audit/claude-sdk/tmp');
await mkdir(runtimeHome, { recursive: true });
await mkdir(runtimeTmp, { recursive: true });
if (hostname().split('.')[0] !== 'Tormods-Mac-Studio') throw new Error('STUDIO_ONLY');
const account = 'claude-claude-trmd-trmd.me';
const expectedEmail = 'claude-trmd@trmd.me';
const configDir = '/Users/trmd/.hive/homes/' + account;
const outputDir = resolve(process.argv[2] ?? 'evidence/' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(outputDir, { recursive: true });
const logPath = join(outputDir, 'run.jsonl');
const log = async (event: object) => appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const authenticated = deferred();
const finished = Array.from({ length: 3 }, deferred);
const starts: number[] = [];
const firstOutput: (number | null)[] = [null, null, null];
const compactions: object[][] = [[], [], []];
const measurements: object[] = [];
const memory = Array.from({ length: 120 }, (_, i) => `Memory record ${i}: Champion owns durable coordination, reports evidence, preserves accepted mail, and uses explicit session identifiers. This is synthetic non-secret fixture context.`).join('\n');
const prefix = [
  'Identity and role: You are Champion, an experimental Apiary coordination assistant. Acknowledge each mail in one short sentence. Never claim to be Claude Code.',
  'Tools: No tools are available in this measurement session. Do not call tools.',
  'Memory snapshot:\n' + memory,
  'Running summary: This session measures three sequential mail acknowledgements. Preserve the codeword ORCHARD across turns. Do not repeat the memory snapshot.',
].join('\n\n');
const mails = ['Mail 1: acknowledge startup and remember ORCHARD.', 'Mail 2: acknowledge new mail and repeat the codeword.', 'Mail 3: acknowledge after the pause and repeat the codeword.'];
async function* input(): AsyncGenerator<SDKUserMessage> {
  await authenticated.promise;
  for (let turn = 0; turn < 3; turn++) {
    if (turn === 2) await pause(15_000);
    starts[turn] = performance.now();
    await log({ event: 'mail_sent', turn: turn + 1, pauseBeforeMs: turn === 2 ? 15_000 : 0 });
    yield { type: 'user', message: { role: 'user', content: 'New mail:\n' + mails[turn] }, parent_tool_use_id: null };
    await finished[turn].promise;
  }
}
const session = query({ prompt: input(), options: {
  cwd: outputDir,
  pathToClaudeCodeExecutable: '/Users/trmd/.local/share/mise/installs/node/lts/bin/claude',
  systemPrompt: prefix,
  tools: [],
  allowedTools: [],
  disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent'],
  strictMcpConfig: true,
  mcpServers: {},
  settingSources: [],
  includePartialMessages: true,
  model: 'sonnet',
  thinking: { type: 'disabled' },
  env: {
    PATH: '/Users/trmd/.local/share/mise/installs/node/lts/bin:/usr/bin:/bin',
    HOME: '/Users/trmd',
    TMPDIR: runtimeTmp,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'apiary-champion-spike/0.1',
  },
} });
let turn = 0;
let sessionId: string | undefined;
try {
  await log({ event: 'launch_policy', envKeys: ['PATH', 'HOME', 'TMPDIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_AGENT_SDK_CLIENT_APP'], settingSources: [], allowedTools: [], strictMcpConfig: true, mcpServers: [] });
  try {
    await writeFile(join(cellRoot, '.audit/sandbox-denied-write-probe'), 'sandbox escape probe', { flag: 'wx' });
    throw new Error('SANDBOX_WRITE_ALLOWED');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['EPERM', 'EACCES'].includes(String(error.code))) throw error;
    await log({ event: 'sandbox_denied_write', target: '.audit/sandbox-denied-write-probe', code: error.code, passed: true });
  }
  const info = await session.accountInfo();
  if (info.email !== expectedEmail || info.apiProvider !== 'firstParty') {
    await log({ event: 'auth_blocked', account, reason: 'Pinned subscription identity not confirmed; no mail sent.' });
    throw new Error('AUTH_REQUIRED');
  }
  await log({ event: 'auth_confirmed', account, emailMatches: true, apiProvider: info.apiProvider, subscriptionType: info.subscriptionType });
  authenticated.resolve();
  for await (const message of session) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
      await log({ event: 'session_init', sessionId, model: message.model, tools: message.tools, mcpServers: message.mcp_servers, configuredSettingSources: [], loadedSkills: message.skills, loadedPlugins: message.plugins.map(plugin => plugin.name) });
      if (message.tools.length || message.mcp_servers.length || message.skills.length || message.plugins.length) throw new Error('UNEXPECTED_LOADED_CAPABILITY');
    }
    if (message.type === 'assistant' && message.error) {
      await log({ event: 'assistant_error', turn: turn + 1, error: message.error, text: message.message.content.filter(block => block.type === 'text').map(block => block.text).join('') });
      throw new Error('ASSISTANT_ERROR');
    }
    const textDelta = message.type === 'stream_event' && message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta';
    if (turn < 3 && firstOutput[turn] === null && (textDelta || message.type === 'assistant')) {
      firstOutput[turn] = performance.now() - starts[turn];
      await log({ event: 'first_assistant_output', turn: turn + 1, firstAckMs: firstOutput[turn], source: textDelta ? 'text_delta' : 'assistant_message' });
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      compactions[turn].push(message.compact_metadata);
      await log({ event: 'compaction', turn: turn + 1, metadata: message.compact_metadata });
    }
    if (message.type === 'assistant') {
      await log({ event: 'assistant', turn: turn + 1, text: message.message.content.filter(block => block.type === 'text').map(block => block.text).join('') });
    }
    if (message.type === 'result') {
      const usage = message.usage;
      const denominator = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
      const row = {
        turn: turn + 1, sessionId: message.session_id, firstAckMs: firstOutput[turn], finishMs: performance.now() - starts[turn],
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens, cacheReadTokens: usage.cache_read_input_tokens,
        cacheHitShare: denominator ? usage.cache_read_input_tokens / denominator : 0,
        compactions: compactions[turn], subtype: message.subtype,
      };
      measurements.push(row);
      await log({ event: 'result', ...row, sdkDurationMs: message.duration_ms, usage, cumulativeModelUsage: message.modelUsage });
      await writeFile(join(outputDir, 'measurements.json'), JSON.stringify({ account, sdk: '0.3.306', prefixOrder: ['identity and role', 'tools', 'memory snapshot', 'running summary', 'new mail'], turns: measurements }, null, 2) + '\n');
      if (message.is_error || message.session_id !== sessionId || firstOutput[turn] === null || denominator === 0) throw new Error('RUN_FAILED');
      finished[turn++].resolve();
    }
  }
  if (turn !== 3) throw new Error('INCOMPLETE_RUN');
  console.log(JSON.stringify({ outputDir, completedTurns: turn }));
} catch (error) {
  const knownErrors = ['AUTH_REQUIRED', 'ASSISTANT_ERROR', 'RUN_FAILED', 'INCOMPLETE_RUN', 'UNEXPECTED_LOADED_CAPABILITY', 'SANDBOX_WRITE_ALLOWED'];
  const errorCode = error instanceof Error && knownErrors.includes(error.message) ? error.message : 'SDK_OR_IO_FAILURE';
  await log({ event: 'stopped', errorCode, reason: turn === 0 ? 'Authentication or startup failed; human login may be required. No credential details recorded.' : 'SDK run failed; inspect sanitized result events.' });
  console.error('Spike stopped. See sanitized run.jsonl. If authentication is missing, sign in to the pinned config directory.');
  process.exitCode = 1;
} finally {
  session.close();
}

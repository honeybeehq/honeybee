export const secretSupervisorSource = String.raw`
const { spawn } = require('node:child_process');
const { writeSync } = require('node:fs');
const { Socket } = require('node:net');
const lease = new Socket({ fd: 3, readable: true, writable: true });
lease.setEncoding('utf8');
let child;
let finished = false;
let input = '';
const finish = (code, reason) => {
  if (finished) return;
  finished = true;
  if (reason) { try { writeSync(3, reason); } catch {} }
  if (child?.pid) {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
  }
  process.exit(code);
};
process.on('SIGTERM', () => finish(143));
process.on('SIGINT', () => finish(130));
lease.on('end', () => finish(125));
lease.on('error', () => finish(125));
lease.on('data', chunk => {
  if (child) return finish(125);
  input += chunk;
  if (!input.endsWith('\n')) return;
  try {
    const config = JSON.parse(input);
    input = '';
    const remaining = config.timeoutMs;
    if (remaining <= 0) return finish(124, 'timeout');
    setTimeout(() => finish(124, 'timeout'), remaining);
    child = spawn(config.command, config.args, {
      env: config.env, detached: false, stdio: ['ignore', 1, 2]
    });
    for (const key of Object.keys(config.env)) delete config.env[key];
    child.on('error', () => finish(125, 'spawn_error'));
    child.on('exit', code => finish(code === null ? 1 : code, 'exit:' + JSON.stringify(code)));
  } catch { finish(125); }
});
`;

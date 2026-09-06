import assert from 'node:assert/strict';

export function parseProcessTable(text) {
  if (!text.trim()) return [];
  return text.trim().split('\n').map(line => {
    const [id, parent, rss, time, ...start] = line.trim().split(/\s+/);
    assert.match(time ?? '', /^(?:\d+-)?\d+(?::\d+){1,2}(?:\.\d+)?$/, 'invalid ps CPU time');
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
    const seconds = clock.split(':').reduce((n, part) => n * 60 + Number(part), 0) + Number(days) * 86400;
    const row = { pid: Number(id), ppid: Number(parent), rssBytes: Number(rss) * 1024, cpuSeconds: seconds, birth: start.join(' ') };
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && Number.isFinite(row.rssBytes) && row.rssBytes >= 0 && start.length === 5, 'invalid ps process row');
    return row;
  });
}

export function processTree(rows, pid) {
  const owned = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  return rows.filter(row => owned.has(row.pid));
}

export function cpuPercentBetween(before, after) {
  const elapsedMs = after.elapsedMs - before.elapsedMs;
  assert.ok(elapsedMs > 0, 'samples must advance time');
  const identities = new Map(before.processes.map(p => [`${p.pid}:${p.birth}`, p.cpuSeconds]));
  let cpu = 0;
  for (const p of after.processes) {
    const prior = identities.get(`${p.pid}:${p.birth}`);
    if (prior !== undefined) cpu += Math.max(0, p.cpuSeconds - prior);
  }
  return cpu * 100000 / elapsedMs;
}

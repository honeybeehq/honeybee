import assert from 'node:assert/strict';

// Git Trace2 nests child session IDs under the parent's ID. Summing both
// durations double-counts work such as clone's upload-pack child.
export function summarizeGitTrace(events) {
  const roots = events.filter(e => e.event === 'start' && typeof e.sid === 'string' && !e.sid.includes('/'));
  const exits = new Map(events.filter(e => e.event === 'exit').map(e => [e.sid, e]));
  let wallMs = 0;
  for (const start of roots) {
    const end = exits.get(start.sid);
    assert.ok(end && Number.isFinite(end.t_abs) && end.t_abs >= 0, 'incomplete Git command trace');
    wallMs += end.t_abs * 1000;
  }
  return { commands: roots.map(e => e.argv), commandCount: roots.length, wallMs };
}

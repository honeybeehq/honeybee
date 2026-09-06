import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeGitTrace } from './git-trace.mjs';

test('Git command attribution excludes nested children without losing parent time', () => {
  const events = [
    { event: 'start', sid: 'clone', argv: ['git', 'clone'] },
    { event: 'start', sid: 'clone/upload', argv: ['git-upload-pack'] },
    { event: 'exit', sid: 'clone/upload', t_abs: 2 },
    { event: 'exit', sid: 'clone', t_abs: 3 },
    { event: 'atexit', sid: 'clone', t_abs: 3.1 },
    { event: 'start', sid: 'checkout', argv: ['git', 'checkout'] },
    { event: 'exit', sid: 'checkout', t_abs: 1 },
  ];
  assert.deepEqual(summarizeGitTrace(events), { commands: [['git', 'clone'], ['git', 'checkout']], commandCount: 2, wallMs: 4000 });
});

test('Git attribution refuses incomplete or invalid duration evidence', () => {
  const start = { event: 'start', sid: 'root', argv: ['git'] };
  assert.throws(() => summarizeGitTrace([start]), /incomplete/);
  for (const t_abs of [-1, NaN, Infinity]) assert.throws(() => summarizeGitTrace([start, { event: 'exit', sid: 'root', t_abs }]), /incomplete/);
});

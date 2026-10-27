import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inside, labHost, launchAgents, profile, writable, write } from './hardening.mjs';

test('exact lab hosts and inclusive quiet window fail closed', () => {
  for (const utc of ['0300', '0340', '0400', '0440', '', '9999', 'ab12']) assert.throws(() => labHost('trmd-hobbiton-mini04', utc), /REFUSED/);
  for (const utc of ['0259', '0441', '2359']) assert.doesNotThrow(() => labHost('trmd-hobbiton-mini04', utc));
  assert.doesNotThrow(() => labHost('trmd-fangorn-mini07', '0300'));
  for (const host of ['mini04', 'evil-mini04', 'elrond', 'fangorn']) assert.throws(() => labHost(host, '1200'), /REFUSED/);
  assert.equal(inside('/users/LAB/Library', '/Users/lab', 'darwin'), true);
  assert.equal(inside('/Users/laboratory', '/Users/lab', 'darwin'), false);
});

test('protected paths refuse before filesystem operations', () => {
  const originals = new Map(['lstatSync', 'statSync', 'realpathSync', 'openSync', 'readdirSync'].map(key => [key, fs[key]]));
  try {
    for (const key of originals.keys()) fs[key] = () => { throw new Error('filesystem accessed'); };
    for (const target of ['/Users/lab', '/Users/lab/Library/x', '/Users/lab/.hive/x', '/private/var/tmp/hb-gate.x/../../escape']) {
      assert.throws(() => write(target, 'bad', '/private/var/tmp/hb-gate.x', '/Users/lab'), /REFUSED: write outside/);
    }
  } finally { for (const [key, value] of originals) fs[key] = value; }
});

test('writes stay in root and refuse symlinks and overwrites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-guard-test.'));
  write(path.join(root, 'allowed'), 'allowed', root, '/Users/lab');
  assert.equal(fs.readFileSync(path.join(root, 'allowed'), 'utf8'), 'allowed');
  assert.throws(() => write(path.join(root, 'allowed'), 'bad', root, '/Users/lab'), /EEXIST/);
  fs.symlinkSync('/Users/lab', path.join(root, 'escape'));
  assert.throws(() => write(path.join(root, 'escape', 'bad'), 'bad', root, '/Users/lab'), /REFUSED/);
  assert.throws(() => writable(root, root, path.dirname(root)), /REFUSED/);
});

test('sentinel reads only LaunchAgents names and hashes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sentinel-test.'));
  fs.mkdirSync(path.join(root, 'Library', 'LaunchAgents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Library', 'LaunchAgents', 'fixture'), 'first');
  const before = launchAgents(root);
  assert.match(before.fixture, /^[a-f0-9]{64}$/);
  fs.writeFileSync(path.join(root, 'Library', 'unrelated'), 'ignored');
  assert.deepEqual(launchAgents(root), before);
  fs.writeFileSync(path.join(root, 'Library', 'LaunchAgents', 'fixture'), 'changed');
  assert.notDeepEqual(launchAgents(root), before);
  fs.symlinkSync('/Users/lab', path.join(root, 'Library', 'LaunchAgents', 'redirect'));
  assert.throws(() => launchAgents(root));
});

test('policy denies network, real home and Keychains', () => {
  const policy = profile('/private/var/tmp/hb-gate.x', '/Users/lab');
  for (const expected of ['(deny network*)', '(deny mach-lookup)', '(deny file-write*)', '(subpath "/Users/lab")', '(subpath "/Library/Keychains")', '(subpath "/private/var/db/Keychains")']) assert.ok(policy.includes(expected));
});

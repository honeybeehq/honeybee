import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = 'e26ad0241105b3d374bfe73649af60a90736aa9b';
const candidate = execFileSync('git', ['rev-parse', process.argv[2] ?? 'HEAD'], { encoding: 'utf8' }).trim();
const path = 'v2/daemon/src/envelope.ts';
const moduleUrl = pathToFileURL(resolve(path));
async function load(sha) {
  const source = execFileSync('git', ['show', `${sha}:${path}`], { encoding: 'utf8' });
  const code = stripTypeScriptTypes(source).replaceAll(/(["'])(\.\.\/[^"']+)\1/g, (_, quote, specifier) => `${quote}${new URL(specifier, moduleUrl).href}${quote}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const before = await load(base);
const after = await load(candidate);
assert.equal(after.ANSWER_INJECTION_MARKER, before.ANSWER_INJECTION_MARKER);
const rows = [];
for (const sender of ['rpc', 'operator', 'tormod', 'CL.6d44f']) {
  for (const interrupted of [false, true]) {
    const message = { id: 7, sender, body: '[answer to question q-1] rebase\n\n(question was: merge or rebase?)', urgency: 'next', enqueuedAt: 1787000000000 };
    const peerBefore = before.isPeerSender(sender, () => false);
    const peerAfter = after.isPeerSender(sender, () => false);
    const oldText = before.deliveryText(message, peerBefore, interrupted, 'q-1');
    const newText = after.deliveryText(message, peerAfter, interrupted, 'q-1');
    assert.equal(newText, oldText);
    rows.push({ sender, interrupted, peer: peerAfter, byteIdentical: true, bytes: Buffer.byteLength(newText), sha256: createHash('sha256').update(newText).digest('hex') });
  }
}
console.log(JSON.stringify({ base, candidate, marker: after.ANSWER_INJECTION_MARKER, markerByteIdentical: true, sameMetadataEnvelopeRows: rows, note: 'Format and text are byte-identical for the same metadata. Fresh answer from attribution intentionally changes to rpc; historical stored sender labels are preserved.' }, null, 2));

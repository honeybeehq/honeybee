import assert from 'node:assert/strict';
import { lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Rotate three ref counts through every position, then mirror the rotations.
 * Each flattened value is one measured captureWork call.
 */
export function balancedRefSchedule(refCounts, samplesPerRefCount) {
  assert.ok(Array.isArray(refCounts) && refCounts.length === 3,
    'packed-tag ruler requires exactly three ref counts');
  assert.equal(new Set(refCounts).size, refCounts.length, 'ref counts must be unique');
  assert.ok(refCounts.every(value => Number.isSafeInteger(value) && value >= 0),
    'ref counts must be non-negative safe integers');
  assert.ok(Number.isSafeInteger(samplesPerRefCount) && samplesPerRefCount >= 3,
    'samples per ref count must be at least three');
  const rows = [];
  for (let sample = 0; sample < samplesPerRefCount; sample++) {
    const cyclePosition = sample % (refCounts.length * 2);
    const reversed = cyclePosition >= refCounts.length;
    const rotation = cyclePosition % refCounts.length;
    const base = reversed ? [...refCounts].reverse() : [...refCounts];
    rows.push([...base.slice(rotation), ...base.slice(0, rotation)]);
  }
  return rows.flat();
}

function maintenanceKind(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const executable = basename(argv[0]);
  if (executable === 'git-maintenance') return 'maintenance';
  if (executable === 'git-gc') return 'gc';
  if (executable !== 'git') return null;
  const command = argv.slice(1).find(value => !value.startsWith('-'));
  if (command === 'maintenance') return 'maintenance';
  if (command === 'gc') return 'gc';
  return null;
}

/**
 * Keep maintenance outcomes, including failures, and associate each child
 * with the direct Git command whose rusage total includes its waited CPU.
 */
export function attributeMaintenanceDescendants(trace) {
  assert.ok(trace && typeof trace === 'object', 'Trace2 summary is required');
  assert.equal(trace.completeChildEvents, true, 'Trace2 child events are incomplete');
  assert.equal(trace.childEventIdentityMatched, true, 'Trace2 child event identities do not match');
  assert.ok(Array.isArray(trace.rootOutcomes), 'Trace2 root outcomes are required');
  assert.ok(Array.isArray(trace.childProcesses), 'Trace2 child processes are required');
  const observed = [];
  for (const child of trace.childProcesses) {
    const kind = maintenanceKind(child.argv);
    if (kind === null) continue;
    const roots = trace.rootOutcomes
      .filter(root => child.sid === root.sid || child.sid.startsWith(`${root.sid}/`))
      .sort((a, b) => b.sid.length - a.sid.length);
    assert.ok(roots.length > 0,
      `cannot attribute maintenance child ${child.sid}:${child.childId} to a direct Git command`);
    observed.push({
      kind,
      sid: child.sid,
      childId: child.childId,
      argv: child.argv,
      returncode: child.returncode,
      pid: child.pid,
      attributedRootSid: roots[0].sid,
      attributedRootArgv: roots[0].argv,
      attributedRootReturncode: roots[0].returncode,
    });
  }
  return {
    policy: 'retain-and-attribute',
    accounted: true,
    observed,
    nonzeroOutcomes: observed.filter(value => value.returncode !== 0).length,
    scope: 'Trace2 identifies maintenance descendants and their direct Git parent. Their CPU remains included in that parent rusage record and is not isolated as child CPU.',
  };
}

/** Count owned scratch entries without following symlinks. */
export function summarizeScratchTree(root) {
  const totals = {
    root,
    entriesIncludingRoot: 0,
    regularFiles: 0,
    directories: 0,
    symbolicLinks: 0,
    otherEntries: 0,
    logicalBytes: 0,
    allocatedBytes: 0,
    logicalByteScope: 'POSIX lstat st_size summed across all entries, including the root directory',
    allocationUnit: 'POSIX st_blocks * 512 bytes',
  };
  const visit = path => {
    const stat = lstatSync(path);
    totals.entriesIncludingRoot += 1;
    totals.logicalBytes += stat.size;
    totals.allocatedBytes += stat.blocks * 512;
    if (stat.isDirectory()) {
      totals.directories += 1;
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile()) totals.regularFiles += 1;
    else if (stat.isSymbolicLink()) totals.symbolicLinks += 1;
    else totals.otherEntries += 1;
  };
  visit(root);
  return totals;
}

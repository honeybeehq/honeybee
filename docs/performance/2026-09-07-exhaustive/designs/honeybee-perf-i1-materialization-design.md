# I1 pending metadata materialization prototype

## Boundary and recommendation

Prototype base is exact `cea08e4c65099210d9c2678a8798ed8d455dc6d2` in the isolated worktree
`/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-i1-allocation-prototype-2026-09-07`.
No benchmark or production branch was edited or committed.

Measure candidate B next. It includes candidate A's wrapper removal, then uses SQLite
positional result rows when the runtime supports them. Candidate A alone produced a
small structural allocation change; B changed the dominant materialization shape.
Neither Studio profile is an acceptance result or a timing claim.

Do not add a streaming candidate yet. `StatementSync.iterate()` would still create a
raw positional row for every message and the required final metadata object for every
message; it mainly removes the outer `.all()` holder and changes object lifetime. It
also conflicts with the current diagnostic contract in `scripts/perf/sql-trace.mjs`,
which deliberately rejects lazy iterators. The B profile is already sufficient to ask
the Mini ruler whether positional rows help the real workload.

## Frozen candidates

- A, base -> wrapper-free object rows:
  `/tmp/honeybee-perf-i1-candidate-a-no-wrapper.patch`
  - patch SHA-256: `7ba016bfa59a5058a4de6a79ac74f0fa125a9b1691bc1f0294c201b787333ea4`
  - resulting `v2/core/src/store.ts` SHA-256: `cccc7aae664b7a752bf0fcebda95d77af28a75bef16e994a95b8435c7f2b9f92`
- B, base -> wrapper-free positional rows with object fallback:
  `/tmp/honeybee-perf-i1-candidate-b-return-arrays.patch`
  - patch SHA-256: `62cb8e736ac604164fc5da51e5f9ff59d89e3aaecfe5d885d4cd253f087d7ec7`
  - resulting `v2/core/src/store.ts` SHA-256: `81653402bb5b0311611554199e0aa251669c9d00e4ac2cce77c684c0e696faa6`
- Base `v2/core/src/store.ts` SHA-256:
  `aac40750ff597cee8eb3d843721ed0f42b7277d0e69555b1235ca7a0912f22a4`

Both patches are standalone against `cea08e4c`; B already contains A. B was checked
byte-for-byte against `git diff --binary`, and `git apply --reverse --check` passes in
the prototype worktree.

## B mechanics and contracts

`mapDaemonPendingMessage` now returns only the public metadata object; callers retain
the validated Bee ID separately. On a runtime with `setReturnArrays`, the two existing
message statements keep their exact SQL and SELECT order:

`id, bee_id, urgency, enqueued_at`

The adapter localizes the Node typing mismatch: the container is trusted only because
the enabled API contract guarantees array rows, while each positional value remains
`unknown`. Validation remains in the old order and uses the same labels:

1. `pending bee_id`
2. `pending id`
3. `pending urgency`
4. `pending enqueued_at`
5. missing-group/runtime invariant after the projected fields

The object-row branch uses the same order and validators. SQL ordering, current-runtime
selection, archived Bee behavior, exact pending metadata, fresh acquisition behavior,
rollback behavior, and work/I1 array and message identity are unchanged. No result or
domain fact survives the store call or daemon phase.

The official Node API documents `setReturnArrays` as added in Node 24.0.0 and 22.16.0:
https://nodejs.org/api/sqlite.html#statementsetreturnarraysenabled. The root package
still declares Node `>=20`, while private `@honeybee/core-v2` declares `>=24`. B does
not rely on the latter to raise the effective floor: it checks the method and preserves
the existing object-row path when absent. Actual Node 22.13.0 (`node:sqlite` available,
method absent) passed the focused suite and proofs below. This does not resolve the
pre-existing root-engine/node:sqlite inconsistency.

The store caches statements by exact SQL text. Each of the two affected SQL strings has
one source occurrence and no object-mode consumer. B sets array mode before every
array-path `.all()` call, so cached statement mode cannot leak to another query. The
existing SQL tracer uses `Object.values(row)`; that works for both object and positional
rows. Exact diagnostic row/text/blob accounting was verified in both runtime paths.

## Structural allocation evidence

All three profiles used the unchanged `scripts/perf/quiet-tick.mjs`, exact Node 24.18.0,
one live Bee, 2,000 pending 64-byte messages, 32 profile ticks, and three warmups. These
are one-shot sampled-allocation profiles on a contended Studio, not canonical timings.

| Source | Sampled total bytes | Pending read/materialization self-attribution |
| --- | ---: | ---: |
| base | 35,805,064 | 30,187,720 in `readI1PendingSnapshotData` |
| A | 33,321,600 | 28,771,784 in `readI1PendingSnapshotData` |
| B | 18,224,360 | 9,138,632 in `daemonStatementArrayRows` + 2,679,648 in `readI1PendingSnapshotData` |

A's sampled total is 6.94% below base. B's is 49.10% below base and 45.31% below A;
the combined pending-read attribution is 60.85% below base. Treat the percentages only
as evidence that B is the candidate worth controlled Mini measurement.

Profile artifacts and SHA-256:

- base report: `/tmp/honeybee-perf-i1-materialization-baseline.json`
  `a7b43cec2f6808fd41817ea6ab2611a8205efc76a2a12786fb20fa43cbe54d28`
- base heap profile: `/tmp/honeybee-perf-i1-materialization-baseline.json.heapprofile`
  `f7a6643b9c6d2decb49b05b6aab838aac4d92ec39a02aeaf4e2e3271082a47ce`
- A report: `/tmp/honeybee-perf-i1-materialization-no-wrapper.json`
  `9a89748cdf7e340ee4bd16885109882c54e7b752bfa022616a08bb1f540621ce`
- A heap profile: `/tmp/honeybee-perf-i1-materialization-no-wrapper.json.heapprofile`
  `6c911191c6c7a0c0300af50a3fefcf2b4a8e3f6bc5dc8c35be1c490099cb3e99`
- B report: `/tmp/honeybee-perf-i1-materialization-return-arrays-final.json`
  `456e693b291699087d0d977120b9d70ddd9825238d307cc638722b70864dfde2`
- B heap profile: `/tmp/honeybee-perf-i1-materialization-return-arrays-final.json.heapprofile`
  `0efe50756e070ddc413385b6b7ea95af51508ee75372d26aad112d765dbb1998`

The reports themselves bind base revision, dirty diff SHA-256, store source SHA-256,
Node version, workload, and machine/boot metadata.

## Semantic and compatibility evidence

Focused existing tests, exact final B bytes:

- Node 24.18.0 array path: 9/9 pass.
- Node 22.13.0 method-absent object path: 9/9 pass.
- Tests: `v2/core/tests/daemon-work.test.ts` and
  `v2/core/tests/i1-pending-snapshot.test.ts`.
- Core TypeScript check: pass using the repository's installed TypeScript and type roots.

Frozen proof programs:

- `/tmp/honeybee-perf-i1-validation-proof.mjs`
  SHA-256 `3f09bcd629672e3f8b4b0045044cc73663e2a2da577a534a9e2d4da84e9c0a66`
  - Node 24 array path and Node 22 object path both produce exact `CoreError` text
    `daemon projection: malformed pending urgency` from both public reads.
- `/tmp/honeybee-perf-i1-trace-proof.mjs`
  SHA-256 `f83b7f3179fc66c35f625191b68eabc60ad2ab4c983c88fd87c6011888c2c19d`
  - both paths report exactly 2 rows, 81 text bytes, 0 blob bytes;
  - both preserve exact work/I1 pending-array and message-object identity.

Tool/runtime SHA-256:

- `scripts/perf/quiet-tick.mjs`:
  `92b955f0ca237ca146a6127f2b4047d380bba9d04a976ca50ab76c9cf706a178`
- `scripts/perf/sql-trace.mjs`:
  `e16ef5f0cc9c265482a7ac08cc331cecb97709be12f0df4f5f9f04dcd903a754`
- Node 24.18.0 executable:
  `ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a`
- Node 22.13.0 executable:
  `5c79f8e198fd2456ea6660aaa6be218f9f44747f2306c7d0f5f97b087b2f2dfc`

No broad suite, build, benchmark edit, production commit, or Mini action was performed.

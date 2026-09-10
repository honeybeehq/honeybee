# Art nightly Honeybee review, 2026-09-09

Reviewed all 15 frozen candidates at `b220bf315e3be696809ee5a27972daeef6e111b8`. Source fixes remain on an isolated local branch; root owns integration and publication. Full-diff SHA-256 digests below cover the exact Git objects. No deployment or live runtime change.

## Finding and repair

Pre-existing medium-severity defect: a Claude record with numeric timestamp `8640000000000001` throws `RangeError: Invalid time value` before projecting its message. The defect originates in `f7fc90542153ef1fecaf6218076e0e09c773f9eb` and survives in the touched checkpoint module. Repair `1c562950ef0506e35a24ea0aa106cbfe37b0fbba` checks Date validity and emits the event with `ts: null`; valid numeric boundaries, fractional timestamps and original valid strings stay unchanged. The fixture does not show that a real provider emitted an invalid timestamp. NaN/Infinity inputs in the test serialize to null.

Projection version changes from 2 to 3. The separate Grok simplification changes state version from 4 to 5 under the existing conservative digest rule. Consumers intentionally rebuild incompatible derived checkpoints.

## Simplification and preserved contracts

Separate commit `6d18ae72242fd0aa58143947a9d25b4cb48d699a` keeps Grok tool input local instead of temporarily writing and deleting it from retained tool state. Accepted restored input and call/result flags remain supported. Thirty checks pass both before and after; 1,200 varied input lines produce identical emitted batches and complete checkpoint states. Seven alternating fixture CPU rounds (24,000 calls each) have median paired ratio 0.8294; this is a shared-host fixture check, not a whole-app performance claim.

All 11 changed production modules received first and second passes. Retained: JSON descriptor/cycle/schema guards; detached snapshots; independent provider pairing/dedupe and usage states; observer/renderer/projector boundaries; public exports; root-parent and generation guards; branch artifact parsing, hashes and rollback checks. Each protects a distinct contract. Prior exact-SHA policy/manifest simplifications remain applicable and were not replayed into main. No further compatible candidate remains unresolved.

The 4 MiB inclusive UTF-8 limit, lone-surrogate serialization, exact version/harness fences, Agy FIFO eviction, no snapshot flush, and all supported event/ordering contracts remain covered. Native desktop/provider behavior is not claimed.

## Exact candidate outcomes

| SHA | Outcome | Full diff SHA-256 |
| --- | --- | --- |
| `0134753f61cc871d2484ef59a103686678c8addc` | Documentation-only Speedy report. Full diff reviewed; performance numbers remain author-attributed historical fixture measurements, not rerun proof. No main source change. | `d64f0f89b857271a7511b65b2258af4214b245c9dd2a65f4dbaaa4beef5ecf6f` |
| `b220bf315e3be696809ee5a27972daeef6e111b8` | All 16 first-parent changed blobs match second-parent tip; remerge diff empty. Prior main-only daemon, loop and tmux fixes retained by exact blob proof. Checkpoint integration reviewed. | `140b5e1fcc47f1cc13d989ef1ccf0140471d8af694c58710ec4d4986760da2e0` |
| `23d3e3830349938d0f760733129b4559a8e9c088` | Comment/import organization and stateVersion 3→4 fence are coherent; compatibility digest passes. Final branch blobs match merged main. | `291a16b078443004c2dcaaa8027bcea2ed2ac63a0930969d60608399a7e1efb4` |
| `55ae73cbc7c662be34030469ac8449d3011c359d` | All three Agy emitted sets bounded at 1024; duplicates do not refresh FIFO, result does not clear history, thread changes clear sets, flush obeys bound. Oversized restore rejects. Versions fence old schema/semantics. | `76fdd1c6d23ddfaab5598aee77867ad0c886fd15790f78e5968fcb501b477d56` |
| `a0cdcd8c2ec7e07a092427f5ae6635f704ba96ae` | Digest scopes stateful files plus marked shared regions; excluded Claude/renderer semantic changes require manual projectionVersion review. Repair follows that rule. | `c69ef851474e2e7208424ea56a9de2d1cbf4760b066980f61d0ac57f689be5f8` |
| `489a7ba89c619586d9470ca8eb8991f124534fc3` | Explicit Agy replay and Codex duplicate-open assertions complement paired push/flush round trips; no weakened assertions. | `bd9101126ddc684abb4aed43783eb0a065f3b6d2d5b237aedb4b504811ffb893` |
| `6069806e4816b2a221ebd372e9af2fb1eefbbc6e` | Documentation-only tmux process-boundary red/green receipts verified with exact SHA/blob identity; fresh 14-test process suite passes. | `0f28d933789c9695fc3968b5d7f330ede80f40be1e5add4319fef73ce66074c5` |
| `2e5e19de925a6c63fb57ae79d1d7b849a87df103` | Root process env -u removes stale tmux-server parent; child env stays explicit. Full driver/test blobs unchanged at frozen main; fresh private-socket process test passes. | `31d8a18fbad539d738e418cbd45785badab8d9139860853c08bba1d3ea03e5a7` |
| `a505879f86b314d499ac41c05ae3b706c432bc56` | Documentation/evidence-only sealed prior review. Portable verifier validates all 27 diff hashes, identity proofs, 1875 manifest entries and supply arithmetic. No historical artifacts modified. | `b8068d1a0bd2027161b598af69d0e797b75a11b0cd8ef3ef8cf41099f5f3352a` |
| `e7e500f254573652a01e1be8be52fb1cc3ec378a` | Branch-only exact-manifest comparison simplification. Full source patch inspected; exact commit and complete source/test blobs match sealed proof (15/15 before/after). No new branch edit or runtime claim. | `8d914e825c06080b8f34c8c44f65c11184f5b2242c3c100961e7c4391372b78b` |
| `f20bb16feb6afbc9c907f360997a74f9c0bf88a4` | Branch-only exact-manifest comparison simplification, same complete deployRuntime and test blobs as release branch. Sealed exact-SHA before/after proof reused; remains unmerged. | `148e613e480bf4bc45647ae23300269296604161afb04ef6e1595d65b75c5d2b` |
| `88c967839d90d3133c459c116fa25e2f12c42b69` | Daemon root identity absence remains authoritative over ambient/configured env in HSR and tmux assembly. Exact current blobs preserve prior HSR process proof; tmux server boundary handled by later 2e5e19de925a6c63fb57ae79d1d7b849a87df103. | `3fc18bdaa897d5dc8f5e591949c84269f1687e893e4960ae39cab74cfa822314` |
| `6600660bc4d549befb4d5e22d9ac0712468d0718` | Direct pending-stop store calls preserve receiver, generation, count and ordering; cell.exec values were already type-validated. Sealed before/after proof applies by exact current source/test identity. | `2e448273bae0018fc6d048336ae2f30da0747937a8039f56823e373c75390c5b` |
| `1b1dac9fa97c7bf1bf6e4cf5fac83f5320226b8e` | Grok emitted input discarded, pairing/dedupe retained; shared serialization preserves lone surrogates and inclusive byte limit. Later digest scoping supersedes whole-file policy. Further verified transient-state simplification supplied separately. | `90e7a8f68b81a3c15835fb358e1990a9e3aefc8eb977c623390d5ce9e793993b` |
| `2a64efbe9d42f86a2f45f4d919c7a7f9b004dcdf` | Full checkpoint implementation and all provider state owners reviewed. Detached opaque envelopes, exact schema/version checks, pending chunks, Codex starts/forks and Agy baselines preserved. Initial Grok retention/Agy unbounded state superseded by later fixes. Pre-existing Claude timestamp exception reproduced and repaired. | `ca7990fef5c1dc75416e75ddf11e0dc5251f239fe1dfb91d4db64f139ad6ba68` |

## Portable decisive receipts

Final-source checks cover `6d18ae72242fd0aa58143947a9d25b4cb48d699a`. Red runs use frozen `b220bf315e3be696809ee5a27972daeef6e111b8` plus the failing test; repair checks cover `1c562950ef0506e35a24ea0aa106cbfe37b0fbba`. Simplify-before uses that repair plus the new characterization test, and simplify-after uses the final source. The differential uses an exact repair-source copy and final source, comparing checkpoint state without the intentionally bumped version envelope. Raw logs remain outside Git. Node v25.8.0; no separate lint script or GitHub workflow files at the frozen commit.

### claude-timestamp-red

Command: `node --test --test-name-pattern=out-of-range v2/driver-tmux/tests/claude-projection.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 1. Raw log SHA-256 `722ff0a278fa972dc8de6aedf950350f797954782dac4302789705cb65836e1c`.

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
  RangeError: Invalid time value
```

### repair-projectors

Command: `node --test v2/driver-tmux/tests/checkpoint.test.ts v2/driver-tmux/tests/checkpoint-digest.test.ts v2/driver-tmux/tests/agy-projection.test.ts v2/driver-tmux/tests/claude-projection.test.ts v2/driver-tmux/tests/codex-projection.test.ts v2/driver-tmux/tests/grok-projection.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `b6a469142e6cacb88e48dba5b3ad87e97949ee3e76175c68e3e680e241e88cdd`.

```text
ℹ tests 65
ℹ pass 65
ℹ fail 0
```

### simplify-before

Command: `node --test v2/driver-tmux/tests/checkpoint.test.ts v2/driver-tmux/tests/grok-projection.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `69236db7416b261d5b77328d8f3d07e399eeca7fdbe2fbc9cf0c5444372dcb17`.

```text
ℹ tests 30
ℹ pass 30
ℹ fail 0
```

### simplify-after

Command: `node --test v2/driver-tmux/tests/checkpoint.test.ts v2/driver-tmux/tests/grok-projection.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `37b32599cc45c01117b59be7463c968c1a79c33ad17445be76c5fbe72400d599`.

```text
ℹ tests 30
ℹ pass 30
ℹ fail 0
```

### grok-differential

Command: `node reviews/2026-09-09/evidence/honeybee/grok-differential.mjs`. Cwd: `/Users/trmd/.hive/crew/art`. Exit 0. Raw log SHA-256 `acd0e14503402fb1ea7f0a03af3cd9b4d5428994174ba634bfd96e00a8a97ad7`.

```text
  "parityLines": 1200,
  "checkpointStatesEqual": true,
  "medianPairedRatio": 0.8293666530000471,
```

### final-projectors

Command: `node --test v2/driver-tmux/tests/checkpoint.test.ts v2/driver-tmux/tests/checkpoint-digest.test.ts v2/driver-tmux/tests/agy-projection.test.ts v2/driver-tmux/tests/claude-projection.test.ts v2/driver-tmux/tests/codex-projection.test.ts v2/driver-tmux/tests/grok-projection.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `4cfd55ae32ee855b1ca636dd636a05b8980e30126847d4cd9db795a5fd3adc86`.

```text
ℹ tests 66
ℹ pass 66
ℹ fail 0
```

### parsers-tail

Command: `node --test v2/driver-tmux/tests/parsers.test.ts v2/driver-tmux/tests/tail.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `9a9f50d5c8c3c5d9b1eb7d911acb95dfb64c5045956a56e69116899d9acec7ea`.

```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

### cli-transcripts

Command: `node --test --test-name-pattern=verbs.transcript v2/cli/tests/verbs-cli.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `b4628fdc4dfcecec593837c4b2e563df3be267ca545b97bc4c25b02206e7ad25`.

```text
ℹ tests 7
ℹ pass 7
ℹ fail 0
```

### tmux-integration

Command: `node --test --test-concurrency=1 v2/driver-tmux/tests/transcripts.test.ts v2/driver-tmux/tests/driver.test.ts v2/driver-tmux/tests/delivery.test.ts v2/driver-tmux/tests/eq-matrix.test.ts`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `a63e4f256b3f89367504d68d2df63dc5f76444f81557bb024cc298d57af286aa`.

```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

### final-check

Command: `npm run check`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `e146dfab880bfb630650e387ce1de917219b8c01b45ba7819105065c80603f52`.

```text
Command exited 0; see command and SHA-256 receipt.
```

### final-v2-check

Command: `npm run v2:check`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `8ea85cd14d8c59992466c4428264d5da033d1c833445705468a84a3d049e3aa3`.

```text
Command exited 0; see command and SHA-256 receipt.
```

### final-build

Command: `npm run build`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `9a76f7f8c4cf541e75c04faebac95b218cc33c53c671209987635c477f9f8ed6`.

```text
Command exited 0; see command and SHA-256 receipt.
```

### prior-portable-proof

Command: `python3 docs/review/art-nightly-2026-09-08-evidence/verify.py`. Cwd: `/Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-09`. Exit 0. Raw log SHA-256 `2be52b53b4931edfd153375d237eb2f55b40c2f8cf2663db5149db68d76d3423`.

```text
27 exact diffs, prior/legacy identities, 1875 manifest entries and supply evidence verified
```

## Identity, merge and integration

All 16 first-parent merge files are byte-identical to the reviewed second-parent tip; the remerge diff is empty. Prior daemon, loop, tmux-driver and relevant test blobs match the sealed September 8 baseline. Its portable verifier passed all 27 exact diff hashes and prior arithmetic/manifest proofs. Branch-only artifact simplifications retain exact complete source/test blob identity; their 15/15 before/after tests are historical proof.

All ten Apiary frozen vendor files match both Honeybee frozen source bytes and PINS hashes. Apiary at `2b97662aa070bacaa65ee7d3a91e749988ded086` wraps upstream first, so the Date exception also affects that source path. Retain its queued-command, answer-phase, sidechain and result compatibility wrapper. The Apiary lane must repin the final verified Honeybee source and check cache rebuild behavior.

The tmux command included an absent transcripts.test.ts path, ignored by Node; its actual 14 tests cover only driver/delivery/eq. Actual parser/tail and CLI transcript checks are separate receipts above. The broad legacy suite was not rerun and is not represented as green. The dependency install reported three existing audit advisories; no dependency change was made. Initial exploratory check/build ran across edits; final-* receipts are the final source verification.

Raw logs, full diffs, identity JSON, differential script and complete per-module/candidate ledgers remain in Art `reviews/2026-09-09/evidence/honeybee` and dated `honeybee-result.json` / `honeybee-simplification.json`. They are deliberately uncommitted; this report retains portable decisive excerpts and digests. Root owns fresh-main reconciliation, normal pushes and exact-SHA CI.

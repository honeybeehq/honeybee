# Art nightly Honeybee review — 2026-09-07

## Result

The candidate set is exhausted: **143/143 SHAs reviewed** against frozen main `98cc89c3180b25272c31f67e438adea1380921c2` (86 main-reachable, 57 branch-only). I found seven distinct regressions: five medium correctness/integrity defects and two low evidence-metadata defects. Every current-main defect has a verified local fix. The duplicated runtime-artifact defect has verified fixes on both owning branches. No review item remains blocked.

No push or deployment was performed in this lane. Art owns publication, integration, exact-SHA CI, and the two parent-authored evidence errata.

## Findings

### MEDIUM — same-millisecond Cell receipts could select an older move

Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4` ordered equal-`created_at` receipts by random UUID. A later failed UUID could therefore hide the active receipt from `latestMoveOf`, stale CLI views, and `placementInstructionMove`; the destination could launch without the active overlay and then record it as applied. A deterministic SQLite fixture proved the wrong receipt in all three projections. `0472a91c99d7a75c19429b6bffc9988e57c2a272` uses insertion `rowid` as the tie-breaker in live and read-only stores. Parent independently reproduced the defect and integrated the patch as `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`.

Evidence: `.audit/repro-cell-move-latest-tie-red.log`, `.audit/repro-cell-move-latest-tie-green.log`, and `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-cell-parent-result.json`.

### MEDIUM — retained Cell RPC optional arguments accepted wrong types

Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4` silently normalized a non-string `cwd`, non-number `timeoutMs`, and non-boolean `force`. That could bind an idempotency key to a request other than the caller supplied and, for `cell.exec`, run in the default directory or without the intended timeout. The CLI also converted `--timeout wat` to `NaN` and executed with the default timeout. `0472a91c99d7a75c19429b6bffc9988e57c2a272` rejects the values before hashing or persistence and validates the CLI number as finite. Parent verified all six invalid RPC cases and the Apiary/Waggle caller contract, then integrated it as `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`.

Evidence: `.audit/repro-cell-op-param-types-red.log`, `.audit/repro-cell-op-param-types-green.log`, `.audit/repro-cell-cli-timeout-red.log`, `.audit/repro-cell-cli-timeout-green.log`, and `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-cell-parent-result.json`.

### MEDIUM — external lineage ID collisions appeared as local children

Source `eb4a77c2a5356864bd9c495b3deb290ab04860e4` persisted external parent claims but `listChildren` and the stale read-only projection matched only `parent_id`. If an external identifier equaled a local bee ID, `bee.children` reported the unrelated external bee as a local child. `ac33d942ccd7f522092cd3e8f7d7029e53a0a46a` filters `parent_external = 0` in both projections. Core, live RPC, stale CLI, restart, deletion, and account-home sandbox coverage pass.

Evidence: `.audit/repro-external-parent-core-red.log`, `.audit/repro-external-parent-cli-red.log`, the corresponding green logs, `.audit/repro-external-parent-daemon-green.log`, and `.audit/evidence-external-parent-cell-sandbox.log`.

### MEDIUM — same-SHA artifact installation omitted manifest bytes from immutability

Branch-only sources `d7d7072477dfd03e77778d78625fceb42ee571bf` and `19572e1ee96412a8fd63dc02809328ea6f79bc5d` checked the installed payload and selected manifest fields but not the complete installed `manifest.json`. A changed manifest could therefore pass a same-version no-op and later supply altered rollback authority. Stable-patch-equivalent fixes `d20df402a62beea1e0f98354cf15bf641de5060d` and `29dce91870e0c5a4106d30db248dfea8d705226f` require exact installed/extracted manifest-byte equality. Parent independently reviewed `29dce918` and the deploy/rollback call sites. Both fixes remain local for their branch owners; no feature branch was mixed into frozen main.

Evidence: `.audit/repro-runtime-artifact-manifest-red.log`, `.audit/repro-runtime-artifact-manifest-green.log`, `.audit/evidence-runtime-artifact-blob-compare.tsv`, `.audit/evidence-runtime-artifact-tests-green.log`, `.audit/check-runtime-artifact.log`, `.audit/v2-check-runtime-artifact.log`, and `.audit/build-runtime-artifact.log`.

### MEDIUM — the first bounded dedup sweep could forget a reentrant live ID

Historical source `24a4604ba7d4e3c0965d67cc7dc3cf84b43ce98e` could delete a delivery-dedup ID that became live again while the sweep was in flight. That could allow a duplicate retry after the dedup record was forgotten. `1576571cd45dd5235bfc7ee8aedfd1702fd99bbd` rechecks candidates against committed pending state, and `b60e1310dc3da1da33dafed85653ba1b7c648b7f` retains the correction in the consolidated implementation. This defect was superseded before frozen main.

Evidence: `.audit/evidence-dedup-series-range-diff.log` and `.audit/evidence-quiet-daemon.log`.

### LOW — evidence manifest hashed CRLF bytes rather than the committed LF CSV

Source `487972cf1f6a7818766b422d116d6f997c0c8129` recorded 4,815 bytes and hash `ab1f…` for `mini-daemon-guard-scorecard.csv`, while Git stores a 4,775-byte LF file with hash `da75…`. Reintroducing 40 CR characters reproduces the original hash exactly, so no archived data was lost. Parent commit `30154e6a4ffb04a70aed4195813739fef511201f` corrects only the two manifest metadata fields; all 1,484 current entries pass.

Evidence: `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-manifest-fix-result.json`, `honeybee-manifest-red.log`, and `honeybee-manifest-green.log` in the same directory.

### LOW — archived dedup count field described only background rows

Source `6d2677b126ec9e8b11992954bb6bc3c27311bbf1` emitted `scenario.pendingSeeded` as the configured background count, although the wide fixture seeds background + 1 and the probe fixture seeds background + 256 total rows. The ambiguity affects metadata only; fixture hashes, raw samples, assertions, timings, and allocation conclusions are unchanged. A fresh original-v3 probe confirmed 20 background → 21 wide / 276 probe. Parent commit `cc30665984bdddf42a1f02e2ac2a835102745143` adds an immutable-archive erratum without changing archived scripts/results.

Evidence: `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-dedup-metadata-result.json` and `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-parent-evidence/tool-review-40-67.json`.

## Disproved Cell destination suspicion

Frozen main already rejects a retained/active Cell worktree used as a `local_checkout` destination before fencing. The exact Cell path, its canonical realpath, and a symlink alias all resolve to a Git common directory distinct from the registered origin and fail with `repo_mismatch`; the bee remains unfenced and on its original generation. I retained this as explicit contract coverage in `0472a91c`, with no production change. Genuine regular-checkout conversion remains covered.

Evidence: `.audit/evidence-cell-move-source-destination-aliases.log` and `.audit/probe-cell-move-source-destination-initial-green.log`.

## Review coverage and equivalence

Every candidate full diff was read with affected callers/tests. Merge commits were checked by first-parent production/test diffs and, where applicable, reconstructed merge trees. Clean merge trees exactly matched Git for `24058e1f`, `50315018`, `39bc9827`, `c027f347`, `988a75ab`, and `5c5bb8eb`; manual resolutions in `4d0f34dd`, `67fbf2eb`, and `da6843ea` were read in full and retain both parents' intended behavior. Duplicate/rebase families were consolidated only after stable patch IDs and resulting blobs were compared.

The exact five-SHA documentation ledger, twelve-SHA tooling ledger, and twenty-three-SHA evidence ledger were set-equal checked against their accepted handoffs before import. The evidence review covered 2,178 files, 1,302 JSON files, 33,900 JSONL records, 44 gzip archives, 776 links, all 69 tool/design bodies, 260 offline distribution/arithmetic checks, and 17 fresh commands (13 behavior + 4 heap/control). The two TypeScript design signature files that fail `node --check` have zero TypeScript parse diagnostics. Tools 40–67 add 12,425 exact source-fingerprint matches and 64 distributions recomputed from retained raw arrays; other summaries were limited to range/order validation.

Primary ledgers: `.audit/reviewed-outcomes.json`, `/Users/trmd/.hive/crew/art/reviews/2026-09-07/root-docs-reviewed.json`, `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-parent-tooling-reviewed.json`, and `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-parent-evidence-reviewed.json`.

## Verification

| Command / scope | Exit | Result | Evidence |
| --- | ---: | --- | --- |
| `pnpm check` | 0 | root TypeScript check passed | `.audit/check-cell-pnpm-check.log` |
| `pnpm v2:check` | 0 | all v2 packages passed | `.audit/check-cell-pnpm-v2-check.log` |
| `pnpm build` | 0 | root, runner-host, v2, and CLI artifacts built | `.audit/check-pnpm-build.log` |
| Cell core affected suite | 0 | 13/13 | `.audit/evidence-cell-core-suite.log` |
| Cell adapter affected suite | 0 | 27/27 | `.audit/evidence-cell-adapter-suite.log` |
| Cell daemon + CLI affected suites | 0 | 98/98 | `.audit/evidence-cell-daemon-cli-suite.log` |
| Cell driver affected suite | 0 | 17/17 | `.audit/evidence-cell-driver-suite.log` |
| Cell capture/ref rulers | 0 | 10/10 | `.audit/evidence-cell-rulers.log` |
| external-parent/account sandbox surface | 0 | 20 pass, 1 Linux-only skip | `.audit/evidence-external-parent-cell-sandbox.log` |
| `node --test scripts/perf/compare-quiet.test.mjs scripts/perf/sql-trace.test.mjs scripts/perf/quiet-tick.test.mjs` | 0 | 7/7 | `.audit/evidence-quiet-tooling.log` |
| runtime-artifact branch targeted suite | 0 | 52/52 | `.audit/evidence-runtime-artifact-tests-green.log` |
| runtime-artifact branch `pnpm check`, `pnpm v2:check`, `pnpm build` | 0 | all passed | `.audit/check-runtime-artifact.log`, `.audit/v2-check-runtime-artifact.log`, `.audit/build-runtime-artifact.log` |
| parent Cell probe + 21 affected tests + `check` + `v2:check` + `build` | 0 | independently green after integration | `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-cell-parent-result.json` |
| `pnpm test` after build | 1 | broad legacy suite: 32 failures | `.audit/check-pnpm-test-after-build.log` |
| frozen `98cc89c3`: `pnpm build` | 0 | exact-base build passed | `.audit/check-frozen-base-build.log` |
| frozen `98cc89c3`: `pnpm test` | 1 | 48 failures; 27 exact names overlap fixed head | `.audit/check-frozen-base-test.log` |
| both heads: `pnpm test -- tests/cli-flags.test.ts tests/poolSweep.test.ts` | 1 | same pool-sweeper test fails on both; CLI flag case passes both | `.audit/check-current-only-failures-isolated.log`, `.audit/check-frozen-only-failures-isolated.log` |

The broad compiled suite is not green and is not reported as green. Exact attribution found no credible daily causal match: 22/32 names have committed pre-window failures, 27/32 recur on exact frozen main, all 24 failing test blobs are unchanged from the pre-window control through frozen main, and the five fixed-head-only names are either in the older baseline, reproduced on both heads in isolation, or pass on both heads in isolation. See `.audit/full-test-comparison.json` and `/Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-full-suite-attribution.json`.

## Commits and handoff

Main-based lane commits: `ac33d942ccd7f522092cd3e8f7d7029e53a0a46a` and `0472a91c99d7a75c19429b6bffc9988e57c2a272`. Branch fixes: `d20df402a62beea1e0f98354cf15bf641de5060d` and `29dce91870e0c5a4106d30db248dfea8d705226f`. Parent publication equivalents/errata: `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`, `30154e6a4ffb04a70aed4195813739fef511201f`, and `cc30665984bdddf42a1f02e2ac2a835102745143`.

No live user Cell was changed. No UI claim was made. Archived measurement files were unchanged; fresh bounded verification probes are recorded separately. No push or deployment was performed.

## Exact candidate coverage

The rows below preserve the exact input order. The machine result contains each SHA's complete outcome and evidence string.

| SHA | Reachability | Disposition | Subject |
| --- | --- | --- | --- |
| `02aa424e486d36f2f828eb710ce217575e277e57` | branch | reviewed | Verify driver history backing tables on Mini baseline snapshots |
| `488710edf9cf62f9b6c4d747a4b9609d45fba7ae` | branch | reviewed | Normalize archived review whitespace while retaining original bytes |
| `4db80bcc68d0bedcca87e4f7baa47bf95283907c` | branch | reviewed | Select driver-history opt-out and record Mini control measurements |
| `c744057247490691ba6a96b243e623f4e933dbe6` | branch | reviewed | Record driver-history ownership and author verification lineage |
| `c6cf01f20a911ab6a0b424da7aa2bc7e5dd65f16` | branch | reviewed | Attribute stopped driver history to its heap backing table |
| `64561d612c91a97dd928ef67f5ba6e13e5a5e4c8` | branch | reviewed | Measure driver delivery history retained after runtime stop |
| `501710c18515c4ac077a643c50daba2ce9043958` | branch | reviewed | Record automatic-title tail latency tradeoffs |
| `92757d838b4bbac20a3e42dcffb03a65e68bd362` | branch | reviewed | Accept measured automatic-title quiet scan reuse |
| `8e57e74615801f6e294f209ac9f2cb29c2ce4f55` | branch | reviewed | test(core): cover unsafe membership transaction guard |
| `90515db221d5c31cc7878485f452e385d644862a` | branch | reviewed | test(core): harden mailbox membership contract |
| `e033a1b1d6eea1b4a07e6fb1e47fb23acdf744d5` | branch | reviewed | perf(daemon): reuse quiet auto-title membership |
| `1847b6e3b33a5358dff17d8792ae621149a912e3` | branch | reviewed | perf(core): add mailbox membership read |
| `a9e5ea91dcf55f207dc3398e3d671fa5b3f23476` | branch | reviewed | perf(daemon): reuse quiet auto-title membership |
| `92b21dd621db02fca8022ae34fbee68cd67719f6` | branch | reviewed | Establish changed-scan controls and offline cache inspection |
| `cb997d2037826af1d6ab25a4374798ff553851f7` | branch | reviewed | test(core): cover unsafe membership transaction guard |
| `29987287320743b45599c9c70637aa86e16a345a` | branch | reviewed | test(core): harden mailbox membership contract |
| `98cc89c3180b25272c31f67e438adea1380921c2` | main | reviewed | Verify title membership read and establish retained-memory controls |
| `bc6554b6c562019011fb9d3e23cb2e9013bc765f` | branch | reviewed | perf(core): add mailbox membership read |
| `dde1f6f350481f41c62418a57bd8d0426e4bf189` | main | reviewed | Select quiet title-read design and record controlled scan baselines |
| `322815d9dd0af4d63471c17dc27a9ab90cecca7a` | main | reviewed | Record title-cache design counterexamples and measured query costs |
| `ced4bf6707e979df37badaf00ccca0c685ee03fe` | main | reviewed | Record paired Cell tag-omission gains and combined verification |
| `47cd5d6b9d0b713616cecd79f16cdb34ea7542bf` | main | reviewed | test(cell): accept resolved git path in capture trace |
| `d58a2949627d9a6303833cd021bb4e75e29acbcc` | main | reviewed | perf(cell): omit tags from capture scratch clone |
| `c3e899861cf46a4b05a6d33df0ac9e7eafc251e8` | main | reviewed | perf: derive ref ruler clone policy from trace |
| `2932d099993f087824f0adf96939035e4b43cc87` | branch | reviewed | test(cell): accept resolved git path in capture trace |
| `604bf4046bfc5b57c67d5746e59405fd47409ec2` | main | reviewed | Record statement-cache CPU gains and title-scan correctness constraints |
| `d1d087443d652a2f876909a521bb2a2fb8ab5623` | branch | reviewed | perf(cell): omit tags from capture scratch clone |
| `ea50137f310260a3d83cec374a002872420bb65e` | branch | reviewed | perf: derive ref ruler clone policy from trace |
| `b14f8df4698c173ca4d28aa766640307792cedcc` | main | reviewed | perf(core): route listMessages through the prepared-statement cache |
| `b7a9f4bcafa70bf2c5cd09e9c6fb9ac6e99be4d1` | main | reviewed | Record mailbox history tradeoffs and Cell packed-tag baseline |
| `c01f7733e1d532987cfa8b45729666e84409a429` | main | reviewed | perf(tooling): add Cell ref fanout ruler |
| `5479ed6a2b0ad481b5470e4dc8f9b3412f7b76b3` | main | reviewed | test(mailbox): validate raw SQLite scalars and tighten the union rollback oracle |
| `ca7f498c1b2013dfb928ed6c0d53f894add9a248` | main | reviewed | test(mailbox): prove the listMessages union across states, plans, rollback, and migrations |
| `44ffbb525f42efb8202a1ed82d76adf1e8eeed92` | main | reviewed | perf(core): serve listMessages from two partial-index arms merged in id order |
| `c88907dcb7d821fca343aaab6ab9beb2f560fb96` | branch | reviewed | perf(tooling): add Cell ref fanout ruler |
| `64a14e542ecebd50742463d4410f3e39817d58d7` | main | reviewed | Record rejected mailbox index shapes and ordered-union candidate |
| `a67a48bba4460643ffbbe5bf36cc80b51108a9f2` | branch | reviewed | test(mailbox): validate raw SQLite scalars and tighten the union rollback oracle |
| `2512bd64e28d1376e4abf25b0ee64d53ceb3b64d` | branch | reviewed | test(mailbox): prove the listMessages union across states, plans, rollback, and migrations |
| `c25ee08a835b1dac8cc77e93d1e82d5a49c40e84` | branch | reviewed | perf(core): serve listMessages from two partial-index arms merged in id order |
| `f468aba8a1d2c6cc78848b688b70d54a088db7fb` | main | reviewed | Verify combined pending improvements and baseline compiled-test failures |
| `5eb66faddb2c1ad42c59f6b75e541fd601c7373b` | main | reviewed | Assert SQLite order key types in migration parity test |
| `6a58ca316cf07e69b0b36cc84fbf2364d3007a56` | main | reviewed | fix(test): limit import rewriting to emitted ts files |
| `34f259f3b77dd14165006dcacdf23fefbf4e0de3` | main | reviewed | fix(test): rewrite TypeScript import extensions in build |
| `70e11367a7b1220ee6834145237e3605c2404aaf` | branch | reviewed | fix(test): limit import rewriting to emitted ts files |
| `7bf65e1b11787f5a64f5d8f83661b8875bb1672a` | main | reviewed | test(mailbox): prove the index drop against a genuine old+covering baseline |
| `8bf1866c7367e2f76e82fcb22f7bf6cdeb52a15f` | main | reviewed | Record redundant pending index read, write, and page tradeoffs |
| `39631b5f9b95b02d56d4287897813ba6d0dd8e1a` | branch | reviewed | test(mailbox): prove the index drop against a genuine old+covering baseline |
| `d987cc5d7e3e83455364ff9bf26a4ec2eaacdde1` | branch | reviewed | fix(test): rewrite TypeScript import extensions in build |
| `10c25dfc1b14fdda2521d4b5a41f970e7700ee2d` | main | reviewed | perf(core): drop superseded mailbox_undelivered index |
| `d18d1d77f0bf30489278b6e215b0296dc0a1b090` | main | reviewed | Record pending metadata CPU, allocation, and index tradeoffs |
| `f91d4af8dc909fd2c16bf84df25d7d6e5519f57a` | main | reviewed | Merge main gateway admission work into performance round |
| `219b796955e44529abafa779665ea9281e68c790` | branch | reviewed | perf(core): drop superseded mailbox_undelivered index |
| `b74a32c7667fc243592e9a8fb18d9e7ec741686e` | main | reviewed | test(cli): compare ambiguous account matches independently of timestamp ties |
| `b89d628db6f22bbd6d80a7d0191e980be28012a0` | main | reviewed | perf(core): reduce pending-row allocation and avoid large-body table reads |
| `c89456a1cc373b67c1b5b9ec8a69e620e4481a1c` | main | reviewed | docs(perf): record recovery-index tradeoffs and Cell Git resources |
| `45b7579e81b2bb30a82277e362b18e3f27631f76` | branch | reviewed | test(core): adopt covering pending index in neighbor plan pins |
| `ce9558db60fba3a53cfdc375107682527b8a2e17` | main | reviewed | test(core): fidelity fixes for stop-recovery index proofs |
| `81ca68538aa3d03a3dc9927829777260f62d86df` | main | reviewed | perf(core): stop-recovery partial index for revive-intent probes |
| `2c3bdf6b2c69ad0aead62cb9bbd7eb513be11124` | main | reviewed | Fence retained exec identity persistence before daemon-loss test |
| `cfbe57817809d3b1d3032bf4c767ca631911e992` | branch | reviewed | test(core): pre-v8 migration regression for the pending index |
| `915572b066092cc55a59e960b8a42fcac3d99097` | main | reviewed | test(perf): exercise native Git rusage shim |
| `1ceae4ebc7387329f2679fc3a3a35e17ac707fca` | main | reviewed | perf: add optional Cell Git rusage diagnostics |
| `6764453a58cb587498b8ff822a608abd826935cc` | branch | reviewed | perf(core): covering index for body-free pending projections |
| `b26aab080a8287fa2c14116107bc08f3741c16a4` | main | reviewed | Prepare native gateway configuration before runtime command admission |
| `bac990b705aaf59be23436a3025e4c7631af9e1f` | branch | reviewed | perf(core): reduce pending snapshot row allocation |
| `dbfa09c98da69791b014b2435ddb33661078b305` | branch | reviewed | test(perf): exercise native Git rusage shim |
| `62cfe73c71b0bf7c15fbc00614b4291fcea4f9e7` | branch | reviewed | test(core): fidelity fixes for stop-recovery index proofs |
| `27150d703bf50c42e0bc8209eb3116af6f42b8a1` | branch | reviewed | perf(core): stop-recovery partial index for revive-intent probes |
| `9426b00c9f93abbe41f7e79f6262e2eb598caaa6` | branch | reviewed | perf: add optional Cell Git rusage diagnostics |
| `6d2677b126ec9e8b11992954bb6bc3c27311bbf1` | main | reviewed | perf: accept audit tails and bounded standing-mail dedup |
| `b60e1310dc3da1da33dafed85653ba1b7c648b7f` | main | reviewed | perf(daemon): prune obsolete dedup entries during standing mail |
| `e17374fc101d50d45ab4fe1108ac6282f49c21fd` | main | reviewed | perf(core): index per-bee audit tails |
| `cea08e4c65099210d9c2678a8798ed8d455dc6d2` | main | reviewed | perf: accept Cell discovery and held-fleet improvements |
| `485a6c3fe7d4076d67b831873d7ef82402fbfeb5` | branch | reviewed | perf(core): index per-bee audit tails |
| `4ebf43c97b9ec8a2c18332e35b04148c6b33c445` | main | reviewed | perf(daemon): defer Cell move lookup until mail is eligible |
| `d91ab30e2dd94054d246bf5899fc3f0eb02361e7` | main | reviewed | perf: retain active-move and standing dedup measurements |
| `dfecaeba868b47ff86dc3f179262bc969ef00501` | branch | reviewed | perf(core): sweep scratch scales with tracked dedup ids |
| `476559e5869aeb36aff325b78ca2426f6c449f73` | main | reviewed | perf(core): discover Cell moves from active pointers |
| `d7d7072477dfd03e77778d78625fceb42ee571bf` | branch | fixed on branch | feat: install verified managed runtime artifacts |
| `1576571cd45dd5235bfc7ee8aedfd1702fd99bbd` | branch | reviewed | fix(core): reverify sweep deletions against committed pending |
| `9b22be239979f804ac54ea1ca4e2c280eec9ae50` | main | reviewed | perf: accept measured Cell merges and retain native memory evidence |
| `24a4604ba7d4e3c0965d67cc7dc3cf84b43ce98e` | branch | superseded | perf(core): bounded sweep prunes terminal delivery dedup ids |
| `19572e1ee96412a8fd63dc02809328ea6f79bc5d` | branch | fixed on branch | feat: install verified runtime artifacts |
| `7eb8ecb7b28fa6e6ec3607deb41097a77f26caaa` | main | reviewed | test(cell): wait for the runner delivery accept point |
| `86ddf953fc85a9cfd937f5f87462173d22afdec9` | main | reviewed | perf(cell): avoid checkout for clean capture merges |
| `cbc46e49ffd928f4f0de84a6fc54290b3f59b44c` | main | reviewed | test(driver-cell): criss-cross ancestry parity for merge-tree prototype |
| `6021ca8a614b4cf4168c75a3fdde3acf6725cb2b` | main | reviewed | test(driver-cell): differential parity for merge-tree capture prototype |
| `4d0f34dd19798c9f86cc914f4c4f03030dc482c4` | main | fixed | Merge branch 'main' into perf/exhaustive-2026-09-07 |
| `e84dc89e1af778498d5d7067e7c82c662e6511ce` | main | reviewed | perf: record RPC retention and drained dedup tradeoffs |
| `6984a6a2fa5d80df159459831bce8e6baf604912` | branch | reviewed | perf(cell): avoid checkout for clean capture merges |
| `3584cd9ca7e51cca518388cfa95693c093622817` | branch | reviewed | test(driver-cell): criss-cross ancestry parity for merge-tree prototype |
| `6e4447d4dd1358fa2930c9b82f4a9cc11bc994f7` | main | reviewed | perf(core): clear delivery dedup on committed zero pending |
| `b383137d77368da1ff178eb536399a7c90bbf784` | branch | reviewed | test(driver-cell): differential parity for merge-tree capture prototype |
| `f5e4691733e0e3003eefe3b29589ba906a7c9a65` | main | reviewed | perf(core): index RPC result retention |
| `24058e1f3947513a7553ed576d7258590566432d` | main | reviewed; inherited defect fixed | Merge branch 'main' into integrate/cell-move-main-20260907 |
| `67fbf2ebeed2d9d15b826b43fa1489d12a8c09a2` | main | reviewed; inherited defect fixed | Merge sparse daemon work while retaining Cell move fences |
| `50315018c619966f42c287bd2cb28581be4b066c` | main | reviewed; inherited defect fixed | Merge branch 'main' into perf/exhaustive-2026-09-07 |
| `0320278f2c360f58832ff4f69eaf5a5d41aded1b` | branch | reviewed | perf(core): clear delivery dedup on committed zero pending |
| `3780919b80113a267a937f59f4f408cac9d964ef` | main | reviewed | fix(driver-cell): drop empty picks in rebase capture instead of stopping |
| `3a4509207ae06a1461590a7173ca226172a0e9cb` | main | reviewed | perf: disable background maintenance in Cell ruler shapers |
| `d5e062258487bd10a6794e81686f178d05ff798f` | main | reviewed | Merge detached runner service lifecycle repair |
| `b86921c696b1669efaedd09d33fb89d0825143e6` | main | reviewed | perf: accept sparse metadata gains with integration evidence |
| `39bc9827fc5b4478ec12c036af2a1f5fae2adca8` | main | reviewed; inherited defect fixed | Merge branch 'main' into integrate/cell-move-main-20260907 |
| `da6843ea0ccd05cc0d617b979f3115f64253c92b` | main | reviewed; inherited defect fixed | Merge local Cell moves with main, preserving schema v21 lineage |
| `86ccdf4852896dca54e0dd7a42eb95cf687f36dc` | main | reviewed | Preserve bee runners across systemd restarts |
| `4db1313319ef6679648d61daaffc1f570dfa2027` | main | reviewed | perf(core): share same-step pending metadata |
| `5ce1bf56e174a8b99d5f07679fdedaafe656a37c` | main | reviewed | perf(core): project sparse daemon work |
| `6aeb934fc7df16698bbed8e67b2803fc7f69ab05` | main | reviewed | perf(core): read linear I1 metadata |
| `824485f99a0e793601579011f3e16c66b64aaa4c` | branch | reviewed | perf(core): share same-step pending metadata |
| `5b071583d823161b127fb36e0ac9d90f6cec3053` | main | reviewed | perf: harden Cell capture ruler and retain RAM baseline |
| `c5d7986323607082874bdfd0c74fcbff234da496` | branch | reviewed | perf(core): index RPC result retention |
| `0e1de8058eee445b8e080501a6e8b10ff521d35c` | main | reviewed | perf(tooling): add paired cell-exit capture ruler |
| `9652fa61185c6a26c24ce707b58c8799e5f1475c` | branch | reviewed | perf(tooling): add paired cell-exit capture ruler |
| `e06c783edcd69d13eaa777ff77e004b5a0f25853` | main | reviewed | perf: validate flag and task-supply integrations |
| `c027f34727255d78d1ea2ed4d67f7ba42edbbb22` | main | reviewed; inherited defect fixed | Merge branch 'main' into perf/exhaustive-2026-09-07 |
| `7dfd8ca3e257f543f898b53151187b99b53bbffd` | main | reviewed | perf(core): short-circuit task supply gates |
| `e24c2501562f4ef96813479f4f239168ace3316c` | main | reviewed | perf(core): index provider flag deadlines after migration |
| `979d3129483e074250f7ff3b837dd86820db3dd7` | main | reviewed | perf: retain task-supply gains and rejected sparse regressions |
| `6cc402deedb2bd309e8ada42f95ea41e740b8f7e` | branch | reviewed | perf(core): short-circuit task supply gates |
| `c20f54081921c2f0f9a5ecc6f1399791b2ebcd2f` | main | reviewed | Merge model-change admission regression correction |
| `988a75abc4fcc8444238ff7b322926c697ab6c0b` | main | reviewed; inherited defect fixed | Merge branch 'main' into perf/exhaustive-2026-09-07 |
| `ca0bf9b24cacef58498fd175297e4c17dec4ab8c` | main | reviewed | test(daemon): await HSR admission before model deferral |
| `dfda3d291654d07c9263e2850806da2be681cfc1` | main | reviewed | perf: record command-query gains and sparse-work baselines |
| `1325e204f42392bfe4f7912ea140a8b96ba3180d` | branch | reviewed | perf(core): project sparse daemon work |
| `711399e165a0ac5fb8f09b303c394c49274b7153` | main | reviewed | Merge runner socket mail-delivery repair |
| `69689ff0733c572a52099fc048c1a0d80a8ab98d` | main | reviewed | fix(hsr): retain mail until runner socket connects |
| `9240cede319c62e48a716ffa2d36c02f0c19b7ef` | branch | reviewed | perf(core): read linear I1 metadata |
| `9651013f2111f6d5ee51d1a415d293f0d77ddfbf` | main | reviewed | perf(core): narrow daemon command probes |
| `f3ed9b7595cfcf51093af4e3700e04ae49198249` | branch | reviewed | perf(core): narrow daemon command probes |
| `5c5bb8eb7bac9d6148201f8e319092f45632cef2` | main | reviewed; inherited defect fixed | Merge branch 'main' into perf/exhaustive-2026-09-07 |
| `487972cf1f6a7818766b422d116d6f997c0c8129` | main | fixed | perf: record validated idle savings and broader baselines |
| `2cff56e0c8874e2eec07de71a3de45c339db384b` | branch | reviewed | perf(core): skip empty daemon snapshots |
| `871783a0acd20fd3bfd82707c99e12c92b2132d0` | main | reviewed | perf(tooling): add read hotspot measurement ruler |
| `9e0eb1941dffe565157c3cc5c2b4aafa93d44b12` | main | reviewed | perf(core): skip empty daemon snapshots |
| `7b5403a4d42f7cb48ea68e9235af29b90727f6e9` | branch | reviewed | perf(tooling): add read hotspot measurement ruler |
| `c731cdcc8614b62741c40079fec7ed275ae520f4` | main | reviewed; inherited defect fixed | Merge branch 'remote-rollout-hive' |
| `c4fdd729e3c8322873de455434b4ea2cbaba2366` | main | reviewed | test(core): cover v20 external-parent migration |
| `ff255ee5f24da92b1af9f3667fc30e8b9e6f2761` | main | reviewed | fix(cell): grant bound account home in sandbox |
| `eb4a77c2a5356864bd9c495b3deb290ab04860e4` | main | fixed | feat(v2): support external parent lineage |
| `bcd85a8c1f49982cdf88ae19e4f3cc9ef4211e38` | branch | reviewed | perf(core): skip empty daemon snapshots |
| `969faeee3642f0dce06cee66d07b4ce0e4652815` | main | reviewed | perf: map system costs and add verified quiet-tick profiling |
| `ac9aa76e23c0e487d8490af6f6397d65b631c7f8` | branch | reviewed | fix(codex): ignore callback URLs during browser sign-in |
| `343289fe0f939ad3028550af14b4c5c068ea739e` | main | reviewed | fix(naming): title bees before their first turn completes |

Portable [verification excerpts and original-log digests](art-nightly-2026-09-07-evidence.md) accompany this lane report.

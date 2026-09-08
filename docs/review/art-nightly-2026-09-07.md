# Art nightly honeybee regression review, 2026-09-07

All 143 candidate SHAs in the frozen daily inventory have exact review outcomes. The window is 2026-09-06 22:00 UTC through 2026-09-07 22:00 UTC, the Europe/Oslo calendar day. Frozen main was `98cc89c3180b25272c31f67e438adea1380921c2`. Later branch supersession and equivalent patches are recorded per SHA.

The [exact outcome ledger](art-nightly-2026-09-07-outcomes.json) preserves every candidate SHA and its evidence. [Portable verification excerpts and original-log digests](art-nightly-2026-09-07-evidence.md) make the test evidence readable from this repository. Original machine paths in lane details identify retained local logs; the portable evidence document supplies decisive excerpts and their digests.

## Findings and disposition

- Medium: Same-millisecond Cell receipts could select an older UUID instead of the latest insertion. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`. Repair `0472a91c99d7a75c19429b6bffc9988e57c2a272`. Included in this publication branch as `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`.
- Medium: Retained Cell RPC and CLI optional arguments silently accepted wrong types. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`. Repair `0472a91c99d7a75c19429b6bffc9988e57c2a272`. Included in this publication branch as `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`.
- Medium: External lineage ID collisions appeared as local children. Source `eb4a77c2a5356864bd9c495b3deb290ab04860e4`. Repair `ac33d942ccd7f522092cd3e8f7d7029e53a0a46a`. Included in this publication branch as `6e10b33b841965c8ad7bee41c081376fd3ec8864`.
- Medium: Managed runtime-artifact same-SHA verification omitted complete manifest bytes. Source `d7d7072477dfd03e77778d78625fceb42ee571bf`. Repair `d20df402a62beea1e0f98354cf15bf641de5060d`. fixed and verified on owning branch art/nightly-2026-09-07-runtime-artifact-fix; not pushed.
- Medium: Runtime-artifact release same-SHA verification omitted complete manifest bytes. Source `19572e1ee96412a8fd63dc02809328ea6f79bc5d`. Repair `29dce91870e0c5a4106d30db248dfea8d705226f`. fixed and verified on owning branch art/nightly-2026-09-07-runtime-release-fix; parent independently reviewed; not pushed.
- Medium: Initial bounded dedup sweep could forget a reentrantly-added live ID. Source `24a4604ba7d4e3c0965d67cc7dc3cf84b43ce98e`. Repair `1576571cd45dd5235bfc7ee8aedfd1702fd99bbd`. superseded before frozen main; correction retained in b60e1310dc3da1da33dafed85653ba1b7c648b7f.
- Low: Evidence manifest checksummed CRLF bytes instead of the committed LF CSV. Source `487972cf1f6a7818766b422d116d6f997c0c8129`. Repair `30154e6a4ffb04a70aed4195813739fef511201f`. Included in this publication; all 1,484 current manifest entries pass.
- Low: Archived dedup fixture count field excluded scenario-specific messages. Source `6d2677b126ec9e8b11992954bb6bc3c27311bbf1`. Repair `cc30665984bdddf42a1f02e2ac2a835102745143`. Included in this publication as an erratum; immutable archives preserved. A fresh original-v3 probe confirmed 20 background, 21 wide, and 276 probe rows.

## Publication and validation

This publication starts at freshly fetched origin/main `98cc89c3180b25272c31f67e438adea1380921c2`. It includes lineage repair `6e10b33b841965c8ad7bee41c081376fd3ec8864`, Cell repair `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`, manifest correction `30154e6a4ffb04a70aed4195813739fef511201f`, and fixture-count erratum `cc30665984bdddf42a1f02e2ac2a835102745143`. The two code integrations match their reviewed source commits by stable patch ID and complete changed-file before/after blobs. No unmerged feature branch was brought into main.

Independent reproductions failed before the fixes and passed afterward. Root verified lineage through the core, live RPC and stale CLI. The Cell proof checks actual SQLite receipt ordering and six invalid RPC argument cases; two parent probes and all 21 focused tests pass. `pnpm check`, `pnpm v2:check` and `pnpm build` pass on the integrated publication branch. Affected lane suites and their exact counts appear in the detailed review and portable evidence. There is no separate lint script; the required TypeScript checks and builds passed.

The broad `pnpm test` command is not green: 32 failures on the repaired lane, 48 on exact frozen main, with 27 exact names shared. Three of the remaining five already fail in an older repaired-main control; the pool-sweeper case fails in isolation on both heads; the SSH flag case passes in isolation on both. The [full-suite comparison](art-nightly-2026-09-07-full-test-comparison.json) records these names.

The [independent source-history attribution](art-nightly-2026-09-07-full-suite-attribution.json) found zero credible in-window regressions among those 32 failures. Twenty-two exact names already fail in committed pre-window evidence. The other ten have unchanged legacy test/call-site blobs without an exact pre-window failure record; their onset remains uncertain. All 24 failing test blobs are identical across the pre-window control, window predecessor and frozen main. The only two changed primary paths have no causal match. These facts qualify unrelated broad-suite failures; they do not claim that every test passed.

Useful focused reproduction commands, after installing dependencies with the repository's pinned Node environment, are `node --test --test-concurrency=1 v2/core/tests/external-parent.test.ts v2/daemon/tests/external-parent.test.ts` and `node --test --test-concurrency=1 v2/core/tests/cell-move.test.ts v2/daemon/tests/cell-move.test.ts v2/cli/tests/cell-move.test.ts`. Tests added by the fixes must also be present when reproducing against the source baseline. The retained red/green logs show the observed assertions and outcomes.

[Manifest reproduction](art-nightly-2026-09-07-manifest.md) and [archived fixture-count erratum](art-nightly-2026-09-07-evidence-errata.md) include their commands and decisive evidence. Current-main fixes and reports are published through a normal fast-forward push; exact remote confirmation and CI discovery are recorded in Art's nightly run record. No GitHub Actions workflows are configured at publication.

## Detailed review

- [art-nightly-2026-09-07-honeybee.md](art-nightly-2026-09-07-honeybee.md)

## Limits

Branch-only repairs are committed locally for their branch owners. Publication of this report does not merge unfinished feature branches. Complex desktop behavior and live model/provider runs are not claimed unless the linked evidence explicitly records them. No deployment or release was performed.

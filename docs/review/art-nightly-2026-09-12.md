# Honeybee nightly review — 2026-09-12

A concurrent SQLite writer could make stale CLI status derive its view from generation 1 while returning generation 2 as its runtime. The repair reads the runtime once and uses that row for both fields. The next status still reads fresh data. This fixes an inherited defect on main; it does not introduce a transaction snapshot across the other status tables.

## Reviewed scope

Frozen main: `dfced26f5545b17956d87ef4da133a4dd7121624`. The candidate `cb4992f4677d4ac1375435ae30f015574cf10e57` remains branch-only and is not imported onto main. Its bounded prepared-statement cache was reviewed against callers, row mapping, optional-schema handling and close behavior. Four original cache tests passed; adding the same runtime repair and regression test on its isolated branch passed all five tests.

| Candidate | Disposition | Raw diff SHA-256 |
| --- | --- | --- |
| `cb4992f4677d4ac1375435ae30f015574cf10e57` | Reviewed; statement cache retained on its owner branch; inherited runtime coherence defect repaired separately | `b479f1b742cb135feb9e5c126b823a480d2b035b25851bc90b234531b945e16b` |

Regenerate the raw diff with:

```sh
git show --format=fuller --binary --no-ext-diff --no-renames --full-index cb4992f4677d4ac1375435ae30f015574cf10e57
```

Main repair: `9a8a4c6d23cf76f90b853dc48f509160b558f6e9`. Corresponding cached-branch repair: `49de38660723062e3d6638799d01601696ce6f28`; the latter stays local to that owner branch.

## Reproduction and checks

The permanent test uses two real SQLite connections. After the first read, the writer commits generation 2. Before the repair, the equality assertion fails with `1 !== 2`; after it, the view and runtime agree, and the next call returns generation 2. Missing bees still return no runtime.

- Main focused CLI and regression tests: 20 passed, zero failed or skipped.
- Original branch cache tests: 4 passed. Repaired branch compatibility: 5 passed.
- `npm run v2:check`, `npm run check`, and `npm run build`: all exited 0 at source commit `9a8a4c6d23cf76f90b853dc48f509160b558f6e9`. Both changed source files were byte-identical before and after those checks. No project lint script is configured.

| Retained command output | SHA-256 |
| --- | --- |
| `generation-red.log` | `5c74e0c9a0d6729db8b5c4f3dbcdfadebfc63dcb170a168a7c87f5b34209ca75` |
| `generation-green.log` | `b3f84b26431296796455c2f96de78a6f1466ed07e94b6a3120d73919d7a11701` |
| `main-cli-check.log` | `15853d5ee5e36de34a29606cec865efe0dd1a9df35299d65d7ceea748a7c02a7` |
| `cache-compatibility-final.log` | `6c376343ee238df3ce4b180e108bfac1101638b809c1f3e610fd52e6c6fd2a83` |
| `readonly-status.log` | `49b7f640823a93cabc995d626abbafe23271e1c17d3da2dd44090fc2f2b6c375` |

`v2-typecheck` output SHA-256: `8ea85cd14d8c59992466c4428264d5da033d1c833445705468a84a3d049e3aa3`.

`project-typecheck` output SHA-256: `e146dfab880bfb630650e387ce1de917219b8c01b45ba7819105065c80603f52`.

`build` output SHA-256: `99b9ca0d014409d8cd84b41b28ba95e4e1ef8314dc3e8e24366f1ea5ab4f9440`.

Decisive excerpts:

```text
before: tests 1; pass 0; fail 1; AssertionError: 1 !== 2
main after: tests 20; pass 20; fail 0; skipped 0
cache compatibility after: tests 5; pass 5; fail 0; skipped 0
```

An earlier compatibility attempt used a wrong relative copy path, after which Node ran only the four existing cache tests. That attempt is retained separately; the five-test claim comes from the corrected final command.

## Required simplification pass

The second source pass covered the changed read-only store, its tests, public export, CLI fallback caller and core view derivation. Reusing one runtime observation is a correctness repair. Removing per-bee lookups could change concurrent visibility, so it was retained. Expanding prepared-statement state to other one-shot queries lacks proof of recurring benefit, so it was retained. No separate unproven simplification was shipped.

No installed daemon, live provider session, deployment or GUI verification is claimed. The tests use owned fixtures.

GitHub workflow discovery before publication returned zero workflows. No GitHub CI pass is claimed. Publication confirms the exact remote main and records workflow state separately.

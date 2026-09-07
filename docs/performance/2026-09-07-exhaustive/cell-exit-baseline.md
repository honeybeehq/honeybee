# Cell capture baseline

Two distinct identical checkouts at production `c027f347`, Apple Git 2.39.5, Node 24.18.0, M4 Mini. The hardened frozen ruler completed all eight cases with exact report, result SHA/tree/parent, HEAD, working-tree, and ref assertions. Smoke uses 3 ABBA rounds; canonical uses 15 rounds (30 samples per side), 2,000 tracked files, and 12 Cell commits. The first 10,000-file stress capture failed during shaper fixture teardown before recording any cases; its incomplete report and log are retained. A revised fixture disables automatic maintenance in both shaper clones as well as origin/Cell. The production scratch clone still keeps its defaults. The revised ruler passes 2/2 tests and the repository build; the stress rerun is separate.

| Case | A wall p50, ms | A control wall p50, ms |
| --- | ---: | ---: |
| merge-land | 401.29 | 399.57 |
| rebase-land | 662.39 | 739.33 |
| merge-conflict | 448.46 | 444.77 |
| rebase-conflict | 498.65 | 500.66 |
| fast-forward | 51.69 | 51.59 |
| branch-create | 40.93 | 40.73 |
| nothing | 38.76 | 38.87 |
| refused-checked-out | 9.78 | 9.79 |

These are unchanged-code controls, not optimization gains. Rebase landing differs by 11.6% despite identical source; retain that noise when assessing later rebase results. The merge control differs by 0.43%.

A separate merge diagnostic has 13 top-level Git commands (19 including nested commands). Checkout accounts for 184.756 ms and merge 57.244 ms of 278.427 ms summed top-level traced Git duration. This diagnostic is separate from uninstrumented wall samples and includes instrumentation; it identifies checkout as a target, not a speedup estimate. Parent CPU excludes Git child CPU.

Reports and hashed raw traces are `evidence/mini-cell-exit-aa-{smoke,canonical}.json` and adjacent sidecars. Fixture maintenance settings, same-module limitations, and review are in [the ruler review](reviews/cell-exit-ruler.md). No Cell production change is accepted from these controls alone.

# Omitting tags from Cell capture scratch clones

Accepted production `d1d08744` is integrated as `d58a2949`. The only production change adds --no-tags to captureWork's shared no-checkout scratch clone. The capture operation already uses object IDs, fully qualified origin branch refs and explicit no-tags fetches at both boundaries. The scratch clone no longer copies unrelated tag refs; tag-only objects remain accessible by ID through the shared alternate. Fast paths that do not clone are unchanged.

With 10,000 packed lightweight tags and the same 12 files and 14 input commits, capture p50 wall time fell from 163.663 to 97.631 ms, 40.35%. At 1,000 tags it fell 6.44%. The zero-tag case is effectively unchanged, with +0.36% in the combined p50 and overlapping independent-run values. The extra no-tags config line adds 20 logical bytes at zero tags without changing allocated blocks. This control and all adverse raw samples are retained.

## Paired wall measurements

Mini used M4, Node 24.18.0 and Apple Git 2.39.5 on one boot. Four independent processes ran baseline A1, candidate B1, candidate B2, baseline A2, serially. Each process has one warmup and six rotated/mirrored samples at each of 0, 1,000 and 10,000 tags. The combined distribution uses all twelve headline samples per side and ref count. The two runs per side expose repeat variation; this is not a separately randomized fleet or daemon benchmark.

| Tags | Before wall ms | After wall ms | Change | A1 / A2 p50 | B1 / B2 p50 |
|---:|---:|---:|---:|---:|---:|
| 0 | 91.090 | 91.422 | +0.36% | 90.659 / 91.839 | 90.897 / 91.473 |
| 1,000 | 97.794 | 91.495 | -6.44% | 97.468 / 97.972 | 91.046 / 91.738 |
| 10,000 | 163.663 | 97.631 | -40.35% | 163.120 / 163.888 | 97.631 / 97.616 |

The [comparison](evidence/mini-cell-no-tags-comparison.json) and [reducer](tools/honeybee-cell-no-tags-compare.mjs) check equal workload, boot, Git version and tool fingerprints, exactly one changed production source file, repeated-side source identity, identical landed SHA/tree/parents, and expected scratch tag counts. Full source reports are [A1](evidence/mini-cell-no-tags-a1.json), [B1](evidence/mini-cell-no-tags-b1.json), [B2](evidence/mini-cell-no-tags-b2.json) and [A2](evidence/mini-cell-no-tags-a2.json). Baseline source is c01f7733, treatment 2932d099. The test-only follow-up does not change production d1 bytes.

## Git CPU and process memory diagnostics

Each source run has a separate native resource capture per count. These are two diagnostic observations per side, not twelve-sample CPU/RSS distributions. Summed Git CPU includes direct commands and their terminated, waited descendants, excluding Python wrappers. Maximum individual RSS is the largest propagated per-process high-water mark, not summed process RSS or simultaneous whole-tree RAM. Parent CPU in the uninstrumented captures remains near five milliseconds and excludes Git children.

| Tags | Git CPU before ms | Git CPU after ms | Clone CPU before ms | Clone CPU after ms | Max individual RSS before bytes | Max individual RSS after bytes |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 85.811 / 85.365 | 85.353 / 86.185 | 13.889 / 13.914 | 13.649 / 14.167 | 6,012,928 / 5,668,864 | 5,685,248 / 5,668,864 |
| 1,000 | 90.608 / 89.871 | 83.776 / 84.513 | 20.394 / 20.155 | 13.857 / 13.582 | 6,766,592 / 7,094,272 | 5,816,320 / 6,291,456 |
| 10,000 | 157.012 / 157.889 | 90.031 / 88.898 | 80.897 / 81.897 | 13.946 / 13.584 | 16,220,160 / 16,547,840 | 8,093,696 / 7,880,704 |

At 10,000 tags, clone CPU drops from about 81 ms to about 14 ms in both runs. Maximum individual Git-process RSS drops from about 16.2–16.5 MB to 7.9–8.1 MB. These observations support the clone attribution; they are not a system-RAM saving. Thirteen direct Git commands remain. The separate traces observed no maintenance children in these captures; the tool retains and attributes any such children instead of rejecting samples because of them.

## Temporary storage

Storage is a separate diagnostic clone using the exact production flags derived from Trace2. The closed validator accepts only the original flag order plus an optional single --no-tags. It rejects unknown clone shapes. Scratch refs equal the source tag count before and zero after. The snapshot is after no-checkout clone and before merge objects, not full-capture peak disk usage.

| Tags | Logical bytes before | Logical bytes after | Allocated bytes before | Allocated bytes after |
|---:|---:|---:|---:|---:|
| 0 | 27,684 | 27,704 | 106,496 | 106,496 |
| 1,000 | 100,684 | 27,704 | 176,128 | 106,496 |
| 10,000 | 757,684 | 27,704 | 835,584 | 106,496 |

Logical bytes sum lstat sizes, including directories. Allocated bytes use st_blocks times 512; they do not establish unique physical APFS consumption. At 10,000 tags the observed clone snapshot drops from 757,684 to 27,704 logical bytes and from 835,584 to 106,496 allocated bytes. The source keeps its tags and objects. The remaining tag-dependent capture cost outside clone is not solved here. Packed branches, large commit histories, loose-ref fanout, end-to-end RPC blocking and provisioning remain separate measurement targets.

## Correctness and verification

The real-Git tests compare source-tagged and tagless fixtures with identical target and Cell commits across clean merge, checkout conflict fallback and rebase. They pin exact capture reports, result tree/parent/SHA parity, origin ref changes limited to the target, untouched Cell refs/HEAD/worktree, surviving packed source tags, and scratch/transient-ref cleanup. A separate shared-clone test proves packed lightweight and annotated tag-only objects remain accessible by ID without local object copies or tag refs. Live Trace2 pins the actual production clone flags and proves the intended capture engine ran.

The first Mini serial Cell run exposed a test portability defect: Apple Git reports an absolute executable path in argv[0]. The 71 other passes and one platform skip are retained with that failed new test. Tests-only 2932d099, integrated47cd5d6b, validates basename git separately and preserves exact subcommand/flags/order/length/origin/destination assertions. The corrected full Cell suite passed 72 tests with one platform skip. Production hashes did not change. Tooling ea50137f, integratedc3e89986, passed its build and seven tests, including real no-tags transfer behavior and the full native baseline smoke.

The final combined source at 47cd5d6b passed the repository build, all v2 typechecks, the full Cell suite with 72 passes and one platform skip, all seven ruler tests, and the daemon/CLI suites with 368 passes and one skip. The [source proof](verification/mini-cell-no-tags-integrated-source-proof.json) verifies the clean Mini checkout against all 106 local v2 source files. Its only production delta from measured 2932d099 is the separately accepted C03 statement-cache change; capture.ts is byte-identical. [Independent review](designs/honeybee-cell-no-tags-review.md) found no semantic blocker. Its broad minimum-version discussion is not a claim of tests on every historical Git; actual production parity evidence here covers Studio2.52.0 and Mini2.39.5. No push or deployment is included.

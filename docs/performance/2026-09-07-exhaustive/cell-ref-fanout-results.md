# Cell capture with many packed tags

The new ruler measures a remaining Cell exit cost on current captureWork. Six uninstrumented captures per count show p50 wall time rising from 90.704 ms with no extra tags to 162.514 ms with 10,000 tags. The separate Git resource diagnostic attributes 81.435 ms CPU to the scratch clone at 10,000 tags. A candidate to omit unneeded tags from that scratch clone is being tested separately; this report is a baseline, not an accepted production improvement.

| Packed tags | Capture wall ms | Parent CPU ms | Git-tree CPU ms | Clone Git-tree CPU ms | Maximum individual RSS bytes | Scratch logical bytes | Scratch allocated bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 90.704 | 5.188 | 86.524 | 13.838 | 5,685,248 | 27,684 | 106,496 |
| 1,000 | 97.645 | 5.214 | 90.627 | 19.921 | 6,881,280 | 100,684 | 176,128 |
| 10,000 | 162.514 | 5.277 | 157.409 | 81.435 | 16,547,840 | 757,684 | 835,584 |

[Raw report](evidence/mini-cell-ref-canonical.json) includes all samples and source/tool/environment hashes. Production source is `10c25dfc`; ruler `c88907dc` is integrated as `c01f7733`. Mini used Node 24.18.0, Apple Git 2.39.5, M4 and APFS. Build and all five ruler tests passed on Mini, including a real 0/7/13 native smoke and setup-failure cleanup. The unchanged Git rusage helper and native shim retain their earlier verification.

The fixtures have exactly 12 files, 14 input commits and 12 Cell commits. Only the packed lightweight-tag count differs. Fixed-width paths avoid length-dependent config and alternates storage. Rotated and mirrored count order supplies six samples per count after one warmup. Each landed report, tree, parent order and pinned commit SHA matches across counts. Ref and object digests, HEAD, clean worktrees and transient-ref absence are checked and restored between operations.

Parent CPU excludes Git. Git-tree CPU and maximum individual-process RSS come from one later resource diagnostic per count, not a six-sample distribution and not a whole-process-tree simultaneous RSS peak. Thirteen direct Git commands occur at every count. Separate Trace2 captures account for observed maintenance descendants without dropping adverse outcomes. The resource diagnostics retain waited child CPU in its direct parent's total; individual descendant CPU is not isolated.

Scratch storage is measured in separate matching no-checkout shared clones immediately after cloning, before merge objects are created. Logical bytes sum lstat sizes including directories; allocated bytes use st_blocks times 512. These are temporary clone snapshots, not full-capture peak disk usage or unique physical disk consumption. Cleanup is separately timed. Fixture repositories disable automatic maintenance for deterministic resets; production scratch clones retain defaults. All diagnostics and raw native records are retained under the report's filename prefix. Original absolute artifact paths refer to Mini; the same basenames are archived beside this document's raw report.

This experiment covers clean merge capture, not provisioning, provider startup, RPC queue delay, rebase or conflict cost. The tag omission candidate must prove those affected semantics independently before acceptance.

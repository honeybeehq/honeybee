# Spawn and Cell performance review

Base: `17ce2072`. Implementation authors: Codex GPT-5.6 Sol. Independent design
and evidence reviewer: Claude Fable 5. Parent review covers source, raw metrics,
fixture ownership, integration and retained evidence.

## Cell worker: reviewed and measured

`223f85a1` (integrated as `8a6475a3`) ends a fresh image worker after successful
placement. The reviewer checked seed ledgers, completed replay, interrupted
operations, fallback copies, failed image refresh and corrupt-ledger errors.
No lifecycle, replay or fallback regression was found.

The extra pre-call ledger read is necessary for the conservative policy:
`replayed` can remain false when an incomplete operation resumes. A prior ledger
operation therefore retains deferred maintenance even when the resumed placement
returns `image-cow`. Real Worker tests cover this case and a completed image
checkout whose cache was removed before replay. Driver exit bookkeeping was
reviewed for the ready/exit race.

The measurement review required three corrections before final attribution:

- Record the exact built-worker hash rather than only the checkout revision.
- Refuse a fallback copy when the requested scenario is an image or CoW hit.
- Measure warm files before stale-image updates so pack growth does not confound
  the warm-file comparison. The earlier exploratory table is labeled accordingly.

All were implemented. The individual-worker comparison was repeated after the
first two fixes; its hashes match the fresh-process cohort hashes on both sides.
The cohort already enforced the image-copy path. CSV distributions are checked
against raw samples, and incomplete or mismatched captures are rejected.

The exact eight-command assertion in the remote-less test fixture is retained as
a performance budget. It is paired with a semantic assertion that no Git work
occurs after readiness. It is not a promise that every real origin, including
origins with configured remotes, provisions in exactly eight Git calls.

Measured outcome: individual worker tail 2,421 → 2.61 ms; five-worker hold RSS
132.60 → 124.45 MB; cohort Git calls 60 → 40. The imposed two-second hold is
included in the baseline tail. Readiness timings remain inconclusive, and no
steady-idle CPU improvement is claimed. See the [scorecards and full caveats](../performance/2026-09-06-spawn-cells/README.md).

## Runner host: source and combined verification cleared

The independent design comparison selected entry resolution inside HsrDriver,
using the existing override, source entry or a required bundled sibling. It
rejected retaining daemon argv inference or adding a new daemon configuration
seam. Realpath pinning at module load covers Node's preserve-symlinks flags;
the build gates the host's two-file import graph and 32 KiB size limit.

Review found no production entry-selection or rollback issue. It
required correcting the new integration test's cleanup identity: `status.at`
changes on status updates and cannot identify process birth. Follow-up review
also requires proving ownership before accepting a birth time for a previously
unobserved PID from a status file. The final independent review confirmed the fix: entry and exact config path
are checked before first identity capture, exited status records are filtered,
and known birth identities remain immutable. A real unrelated-child regression
proves that a stale status PID cannot authorize killing another process. No
blocking source findings remain.

The official daemon test runner places the artifact integration test in its
serial group, after unit tests. Its production-build hook therefore does not race
another file under the supported runner. Package tests include all three v2
artifacts: CLI, provision worker and runner host. The combined branch passed its full build, daemon typecheck, six staged
HSR/Cell/ownership cases and five real Cell Worker cases. Native profiles and
the final alternating host comparison are captured separately.

## Existing host-resource finding

A read-only process inventory found 301 orphaned source runner hosts and 301
matching stub agents from old temporary test fixtures, totaling approximately
21.2 GB of summed RSS. Fixture prefixes were `wp6b-hive-` and `rn3-hive-`; ages
were approximately 13 hours to nearly four days. Most fixture directories had
already been removed. No process was signaled during this investigation.

This is evidence of old test cleanup failures, not proof that current tests leak.
The current daemon test helper already requests runtime reaping on graceful
shutdown. Interrupted tests and hard process exits remain worth investigating.
An instantaneous 0.0% CPU reading does not rule out timing effects from memory
pressure. Summed RSS includes shared pages and is not private memory.

Potential follow-up: a test-only stub lifetime bound or a run-owned cleanup
manifest, with exact identity verification. Neither is added to production as
part of these optimizations, and no old unowned process is silently cleaned up.

## Verification record

The host author reported root and v2 checks, build, 107 HSR/adapter tests, 47 Cell
tests (one additional Linux-only skip), 77 tmux tests, 175 core tests, 14 harness
tests and 21 package/runtime-artifact tests passing. Daemon units passed 146/146.
The broad daemon/CLI integration group passed 162/163 before the final cleanup
regression was added; the sole failure reproduced on unchanged baseline 17 when
`HIVE_PARENT` was inherited from the agent session. That focused case passed
with the ambient stamp removed. This is an existing environment collision, not
an unqualified all-green broad run. The final artifact suite passed 6/6 after
its cleanup fix, and the parent repeated it successfully on the combined branch.

The measurement tool tests passed, including real host exit/interrupt cleanup,
raw-distribution verification, incompatible-capture rejection and nested Git
Trace2 attribution. The parent build also confirmed that its worker and host
artifact hashes exactly match the independently verified implementation lanes.
The local branch has no GitHub Actions runs; no CI success is claimed.

## Final host and tooling evidence review

Claude Fable 5 independently recomputed the final host medians and checked the
entry/dependency hashes against disk. Host RSS fell 60.98 → 49.97 MB and startup
CPU 390 → 280 ms in the final 15-pair capture; every pair favored the candidate
on both resource metrics. Full-agent readiness remains inconclusive: its median
rose while mean and matched-pair timing favored the candidate. The report keeps
both views and makes no reliable end-to-end or idle-CPU win claim.

The reviewer also checked the profiling-only Cell wrapper, its completed indexes
and file hashes, and the per-run Trace2 reset. All native CPU/heap samples parse;
worker profiles independently reproduce 12 → 8 Git calls. The host-native index
requested in the last audit is retained with source spec, historical capture PIDs
and digests, alongside the compressed archive index. The tool tests passed 8/8,
including repeated-output captures that would fail if old Git traces accumulated.
No blocking review findings remain.

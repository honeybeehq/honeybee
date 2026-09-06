# Performance round review

Base revision is `8506467f`. Work is on `perf/system-round-2026-09-06`.
Claude Fable 5 independently reviewed the measurement tools and evidence.
The parent inspected the profiler implementation and core query changes.
No PR comments were sent.

## Measurement review

The first review found these issues at `df6ec811`:

| Finding | Resolution and evidence |
|---|---|
| Idle fixture disables naming, account refresh and scale-to-zero, unlike a default installation | Disclosed in `docs/performance/measure.md`. Idle numbers apply to the specified fixture. |
| Malformed metric values could produce NaN comparisons | Comparator validates finite nonnegative values, sample counts and percentile ordering. Matching partial captures are also refused. `scripts/perf/report.test.mjs`. |
| A fixed worker timeout could terminate a large workload without cleaning detached hosts | Timeout scales with workload. Worker handles SIGTERM/SIGINT and verifies host exit before cleanup. Real process tests exercise normal and interrupted cleanup in `scripts/perf/worker.test.mjs`. SIGKILL remains outside cleanup guarantees. |
| Installed CLI probe inherits Node compile cache | Explicitly disclosed as a warm compile-cache process launch. It is not a cold installed-launch baseline. |
| Core/daemon workloads execute source while production uses a bundle | Disclosed. The separate CLI probe executes the built artifact. |
| Process sampler CPU resolution differs across OSes | Documented quantization, process-entry/exit omissions and shared RSS accounting. Parser and identity tests added. |
| Missing option values had confusing errors | Added required-value checks. Invalid input still fails rather than guessing. |

The original CLI probe used `--help`, which the baseline CLI rejects during flag
parsing. The probe now uses `help`. The original failed capture is recorded in the
decision trail and is not used for speed claims.

The reviewer inspected source and saved evidence and ran cheap tests. The reviewer
did not run performance workloads or inspect a full transcript. Linux sampler
behavior is covered by parser fixtures, not a live Linux run.

## Parent code review

The latest-runtime query preserves the existing view mapping, row ordering and
lifecycle semantics. Its query plan seeks the maximum generation through the
existing primary key. Regression coverage compares bulk and per-bee views,
including long histories, flags, rollback and replay.

Operational profiling is process-local and opt-in. Event names and payloads are
closed; metrics do not change the core database. Disabled recording uses shared
no-op objects. Recording caps duration, event count and artifact bytes. Runtime
IO failures produce one generic diagnostic. Native CPU/allocation profiles remain
separate offline tools. Active profiling consumes CPU and memory; it is measured
separately and is not treated as a free default feature.

## Tracing review follow-up

The independent reviewer verified the committed headline scorecard byte for byte
against its two raw reports, and recomputed the headline distributions from raw
samples. The p95 improvements also hold in those captures.

The review identified missing response-serialization timing and missing failed
startup phase spans. Commit `54b9295f` adds `rpc.serialize` around JSON encoding and
socket queueing, plus error closure of the active startup phase. Eight profiler
tests pass, including both new cases. RPC latency still uses the external
round-trip measurement; socket queueing is not end-to-end delivery.

Auto-title timing measures synchronous kickoff only. The asynchronous generator
stays outside that tick span. Artifacts flush at clean shutdown, including after
a recording cap. These are explicit limitations, not completed live-streaming
or distributed tracing capabilities. An IO failure can leave a trace without its
summary; consumers must not assume the pair exists.

## Broader test findings

The parallel HSR run had one four-second self-wake timeout. The isolated case
passed, then all 105 adapter/HSR tests passed with file concurrency one.

The Cell/tmux group ran 125 tests, with 123 passing, one skipped and one failing.
The failing `spec05.deliver.honest-failure` assertion also fails in unchanged
`8506467f` when run with the same Node 25.8 executable. Its Node 24 baseline run
passed. No tmux driver or fixture code changed in this round. The failure remains
open as a pre-existing runtime-sensitive test/correctness issue.

## Final evidence audit

Claude Fable 5 regenerated all three final scorecards byte for byte and recomputed
144 metric distributions from raw samples (64 core, 78 daemon, two CLI), with no
mismatches. Source revisions and measured source hashes match the committed code.
The reviewer separately validated lifecycle-filter and synthetic-overhead captures.

The reviewer flagged the flat-history tradeoff and asked for matching daemon
wording. The report now includes the 1,000 × 1 list wall/CPU increases, the mixed
p95 directions, daemon list medians, and slower individual stub spawn observations.
An initial review statement that both wall and CPU p95 worsened was corrected:
CPU p95 improves in that row. Shared-host variation remains; no stable regression
size is inferred from one set of paired medians.

The first flat-history idle-CPU increase did not reproduce in three longer
10-second windows per side, run in reverse order: 10.27% baseline and 10.12%
candidate. Candidate RSS stayed higher. Neither RAM savings nor broad startup
improvement is claimed. These details remain in the committed reports.

## Legacy baseline comparison

The full legacy suite failed 26 cases/files under its default concurrent run.
The 21 affected files were rerun with one test file at a time, an empty disposable
`HIVE_STORE_ROOT`, and Apiary parent variables removed. That run passed 233 of
237 tests. It clears the ambient FROZEN-route failures and most timing failures;
it is not a full-suite green run.

The four remaining failures were checked against pristine `8506467f`, using the
same Node 25.8 executable and freshly compiled baseline tests. The two descendant
cleanup cases and the poolSweep ENOTEMPTY cleanup failure reproduce in that
baseline (50 of 53 tests pass across the four files). The gateway reconnect
assertion passed initially, then failed on the fifth isolated baseline repetition
with the same high-water assertion. All four remaining failures therefore occur
without this round's changes. No legacy source, legacy test or test-runner file
was changed to suppress them. They remain open issues.

The final daemon suite was repeated after the serialization/startup-span follow-up:
146 unit and 158 integration tests pass (304 total). The retained verification
index links this log and all residual baseline failure evidence. Reviewer model:
Claude Fable 5 (`claude-fable-5`). The final attention items are the measured
flat-history cost, higher candidate RSS and slower individual spawn observations,
shared-host and workload scope limits, clean-shutdown trace flushing, and the
baseline-reproduced failures. No blocking correctness defect was found in the
changed paths.

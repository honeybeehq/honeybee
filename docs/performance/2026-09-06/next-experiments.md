# Remaining performance experiments

These are candidates, not measured speedups. The system map identifies their
source paths. Use the committed measurement tools and capture a baseline before
changing each path. A result is inconclusive if host noise or workload differences
can explain the delta.

| Priority | Experiment | Measurement | Correctness conditions |
|---|---|---|---|
| 1 | Avoid rebuilding the retained roster on every quiet tick | 0/10/1,000/10,000 retained bees; stopped versus live ratios; CPU per quiet second; allocation rate; time until eligible mail is delivered | Cache invalidation must survive rollback and reused audit sequence numbers. Time-based expiry, boot bounds and idle eligibility still run on schedule. The store remains authoritative. |
| 2 | Narrow command-history scans at boot and during stop/revive handling | Fixed live fleet with 1,000/100,000/1,000,000 settled commands; startup-to-hello, command lookup CPU and query plans | Pending stop/wake intent, generation fencing, replay and idempotency retain their current behavior. Measure index storage/write cost too. |
| 3 | Separate the production runner-host entry from the complete v2 CLI bundle | Built-artifact host startup and per-host RSS at 1/10/100 hosts; compare source and packaged paths explicitly | Deploy manifests, rollback, host re-adoption and exact executable resolution must work from immutable runtime directories. |
| 4 | Reduce HSR idle polling and output write amplification | 1/10/100 live stub hosts; idle CPU, syscalls, output bytes/sec, output-to-observation latency, journal/transcript disk growth | Never delay cursor persistence past its crash-consistent state transaction or lose replayable output. Slow/no-newline producers need explicit memory bounds. |
| 5 | Reduce snapshot construction and response serialization | 1/10/100 clients, shared/divergent watch cursors, growing mirror tables; `rpc.serialize` versus dispatch time, bytes and retained heap | A cursor gap forces a snapshot. Cache invalidation also covers credential-health facts that do not follow audit sequence alone. Slow clients must not create unbounded buffers. |
| 6 | Bound per-bee history APIs and sparse audit reads | Long mailbox, command and audit histories; requested page sizes, p95 and output bytes | Preserve documented ordering, full-history compatibility where promised, and forensic/replay data. New pagination needs a protocol contract. |
| 7 | Reduce naming, account refresh and gateway filesystem scans | Naming disabled/enabled separately; account and gateway counts; cache hit/miss; CPU and filesystem calls | No stale credential binding, missed refresh, repeated generation rotation or provider-backed work hidden in a supposedly idle fixture. |
| 8 | Revisit tmux typed-input pacing | Short/long, ASCII/multiline messages with the existing real TUI fixtures; typed/paste latency and retry rate | Preserve echo verification and the no-blind-Enter rule. Resolve the existing Node 25 echo-fixture failure before using that suite as an optimization gate. |
| 9 | Improve Cell provisioning and warm-cache efficiency | Cold clone, image hit, CoW hit, contention, large working tree; ready latency and actual allocated disk blocks | Worker single-flight, cache-miss fallback, dirty checkout protection, capture and cleanup remain correct. APFS shared blocks cannot be counted as independent savings. |
| 10 | Bound operational logs and artifact retention | Bytes/day by daemon log, native logs, journals, transcripts, SQLite, account homes, Cells and immutable builds | Audit remains append-only. Deleting or compacting evidence is a separate retention decision, not an implicit performance fix. |
| 11 | Attribute remote-node costs | RTT, bandwidth, reconnect and journal replay on actual configured nodes | Keep local and legacy remote paths distinct. Do not infer node unreachability or runtime completion from silence. |

The live observation in this round found about 138 MB of `hived.log` versus
35 MB of core SQLite data. That is evidence to measure log growth and retention,
not permission to discard logs. The live daemon used about 244 MiB RSS and 7% of
one CPU core during an active-work observation with 526 retained bees. Its observed
process tree had 107 descendants/processes and roughly 7.4 GiB summed RSS; shared
pages are counted more than once and re-adopted hosts may sit outside the tree.
Those figures describe the running deployment, which this round does not change.

Before a broader fleet or retention change, capture cold and warm runs and a
recovery run, not just a steady-state microbenchmark. Include provider-native
smokes where the behavior depends on a real provider. This round's stub results
do not establish provider or remote-node performance.

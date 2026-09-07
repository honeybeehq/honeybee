# Sparse fleet and held-mail baseline

The extended `quiet-tick.mjs` measures unchanged core ticks with optional real-running runtime rows and held idle mail. It uses FakeDriver: these are seeded core facts, not real process-readiness measurements. `--live`, `--pending`, and `--body-bytes` describe the fixture. Pending bodies have a 128 MiB total fixture limit. State and audit hashes must remain unchanged, with no process starts, accepted deliveries, or interrupts.

These captures use source `bcd85a8c`, Node 24.18.0, Apple M4, 30 samples, one retained stopped generation, and three warmups. Timing and native profiling run separately. The exact extended ruler is frozen under `rulers-v3` in the parent's disposable remote directory; report hashes identify its bytes. Earlier guard reports keep their original ruler hashes and are not paired with this extension.

| Fixture | Median uninstrumented tick CPU | Sampled allocation traffic over 30 separate profiled ticks |
| --- | ---: | ---: |
| 1,000 stopped Bees, no mail | 0.021 ms | 312,144 B |
| 10,000 retained Bees, one live runtime, no mail | 43.459 ms | 1,085,260,264 B |
| 1,000 live runtimes, no mail | 3.259 ms | 112,321,616 B |
| One live runtime, 1,000 held 64-byte messages | 0.859 ms | 26,810,216 B |
| One live runtime, 10,000 held 64-byte messages | 8.517 ms | 262,963,280 B |
| One live runtime, 20,000 held 64-byte messages | 18.485 ms | 504,744,848 B |
| One live runtime, 100 held 1 MiB messages | 19.053 ms | 3,148,753,632 B |

Reports are `evidence/mini-work-<case>-<none|profile>-v3fixed-before.json` with hashed CPU and allocation sidecars. Sampled allocation includes collected objects; it is not retained memory or exact total allocation. RSS includes the SQLite connection and fixture setup, while `maxRSS` includes all earlier process work. Process RSS observations do not establish private memory or a leak. Earlier reports without `v3fixed` are retained exploratory captures: their active-lifecycle label was inaccurate for the all-live case. They are not paired with the corrected ruler.

The sparse runtime and body-free projection is still in implementation. Its I1 metadata commit is an enabling boundary, not a standalone performance claim. Only the combined implementation will be compared, including small empty ticks, all-live work, and queue scaling. These held-idle queues exercise traversal and body waste; overdue I1 emission, deduplication, and exact ranking also need their differential correctness cases and separate scaling evidence.

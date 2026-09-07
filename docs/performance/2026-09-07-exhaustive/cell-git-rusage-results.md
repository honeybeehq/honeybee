# Cell Git process resources

Accepted tooling `9426b00c` plus native proof `dbfa09c9`, integrated as `1ceae4eb` and `915572b0`. `cell-exit.mjs --git-rusage --git-rusage-python /absolute/direct/python` adds a separate macOS diagnostic capture. Normal timing remains uninstrumented and the option defaults off.

The wrapper measures CPU of each direct Git command and its waited descendants using a fresh Python process. It excludes Python wrapper CPU. Resource samples are separate from both the uninstrumented wall/parent-CPU samples and Trace2. The report proves identical capture outcomes, landed SHA and command argument/exit sequences across diagnostic modes. Raw resource files and their hashes are retained beside each report. Explicit locked sequence numbers avoid comparing Python 3.9 process-local monotonic clocks.

The retained 2,000-file captures compare the accepted clean-merge change at `b86921c6` versus `6984a6a2`. A/A uses distinct identical checkouts. Three A/B diagnostics include a reversed pair. CPU values below are milliseconds for Git and waited descendants only.

| Case | A/B 1 | Reversed pair, normalized before → after | A/B 2 |
|---|---:|---:|---:|
| Clean merge | 369.849 → 148.721 | 299.544 → 91.281 | 337.569 → 89.335 |
| Conflict fallback | 497.029 → 396.709 | 378.693 → 333.697 | 375.420 → 389.452 |
| Rebase | 679.183 → 662.567 | 680.055 → 681.746 | 681.004 → 680.042 |

Clean-merge Git CPU fell in all three diagnostic pairs. A/A clean CPU was 330.215 versus 330.845 ms. Conflict results vary, including a worse final pair, so no conflict improvement is claimed. Rebase remains a useful unchanged control. These are three diagnostic points, not a workload latency distribution. Do not add them to parent CPU from a different capture to invent total CPU.

Clean-merge maximum individual-process RSS fell from 8.34–8.47 MB to 6.18–7.42 MB across those pairs. This counter is the largest single-process high-water mark propagated through waited trees. It is neither summed RSS nor simultaneous whole-tree resident memory. It does not measure retained daemon memory or scratch storage.

[Distinct A/A](evidence/mini-cell-rusage-canonical-aa.json), [A/B 1](evidence/mini-cell-rusage-canonical-ab1.json), [reversed pair](evidence/mini-cell-rusage-canonical-ba.json), and [A/B 2](evidence/mini-cell-rusage-canonical-ab2.json) preserve every uninstrumented sample, Trace2 stream and resource record. All 458 resource sidecar files across these runs and the eight-case smoke were hash-verified after transfer.

Mini used Node 24.18, Apple Git 2.39.5 and direct CLT Python 3.9.6. Build passed; 17 ruler/aggregation tests and the separate native test passed. The compiled native fixture exercises the materialized production shim with exact argv, complete environment, PATH, CF variable present/absent, cwd, binary stdin/stdout/stderr, exit 23 and SIGTERM. Two actual waited grandchildren prove CPU inclusion and maximum-versus-sum RSS. The eight-case real captureWork smoke passed with exact report/ref/tree/parent assertions. Missing or inconsistent records fail the capture.

Whole-RPC blocking and temporary storage remain open. The earlier [clean-merge wall-time acceptance](cell-object-merge-results.md) remains the latency evidence. This tooling changes no deployed runtime.

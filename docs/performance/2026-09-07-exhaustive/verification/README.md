# Parent verification

These logs come from the integrated guard and performance tools on the Studio. The commands ran sequentially with `HIVE_PARENT` unset. Trailing whitespace and empty end lines were normalized for Git; `manifest.json` records the captured and normalized hashes.

Core tests: 182/182. Daemon unit tests: 153/154, with the unchanged Codex limits transport fixture timing out at 3,750 ms. Its isolated rerun passed 1/1. Daemon serial and integration tests: 164/164. Performance-tool tests: 32/32. Core and daemon TypeScript checks and repository build passed. The full unit-run failure remains in `guard-daemon.log`; the isolated pass does not replace it.

The author's earlier verification counts are attributed in the results writeup. These parent logs are independent runs, not reconstructed author logs.

After merging concurrent main changes into `5c5bb8eb`, the parent passed 185 core tests, 51 focused daemon tests, and 20 Cell tests with one platform skip, all v2 TypeScript checks, and the repository build (`merged-*.log`). Fresh same-machine guard captures on the concurrent source reproduced the quiet-tick CPU reduction: 3.334 to 0.023 ms.

After integrating command predicates as `9651013f`, the parent passed 55 focused core/loop tests, 17 live account-swap and argument tests, all v2 TypeScript checks, and the repository build (`d05-*.log`). The extended quiet profiler passed 2/2 tool tests (`quiet-v3-tools.log`). These are separate verification runs; earlier failures remain recorded.

Implemented and committed Design B as `3a885d3ee8b9295ed03e330fe85414ebe15bf161`.

Key outcomes:

- `HsrDriver` owns source/production/override selection and pins the physical module directory before symlink retargeting.
- Dedicated `dist/v2/runner-host.js` ships with import-graph and 32 KiB size gates; actual size is 4,106 bytes.
- Daemon `argv[1]` inference removed; hidden CLI verb retained.
- npm/runtime packaging covers CLI, provision worker, and runner host.
- Built HSR and Cell tests verify the exact host/config command, immutable process birth, safe cleanup, symlink swaps, embedding, and stale foreign-PID rejection.
- No rollback-path artifact requirement was added, preserving older releases.

Verification:

- Root checks and v2 typechecks: passed.
- Build: passed.
- Daemon typecheck after final test edits: passed.
- Daemon units: 146/146.
- Broad daemon/CLI integration before the final test-only ownership regression: 162/163; sole failure was the ambient parent stamp.
- Final affected artifact integration: 6/6.
- Sanitized `preflip-verbs`: 1/1 passed. `HIVE_PARENT_BEE_ID` was absent; removing the actual inherited `HIVE_PARENT` contamination fixed it.
- Baseline17 under inherited `HIVE_PARENT`: reproduced 0/1 with the same root-parent assertion.
- HSR/adapters: 107/107; focused source/override runner suite 11/11.
- Cell: 47 passed, 1 Linux-only skip.
- tmux: 77/77.
- Core: 175/175.
- Harness: 14/14.
- Packaging/runtime tests: 21/21.
- CLI compatibility test: 1/1.

Full command output, including baseline failure and sanitized pass, is retained in the [session verification log](/Users/trmd/.hive/v2/session-logs/a6bbabe5-45c3-47df-b813-b83c479681e3.jsonl:4630). Existing historical logs remain indexed at [verification/index.json](/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-host-2026-09-06/docs/performance/2026-09-06/evidence/verification/index.json).

Worktree is clean. No deploy, push, or live-runtime changes were made. Heavy checks are released; no commands remain running.

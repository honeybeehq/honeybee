Run from this Cell checkout after `npm ci --ignore-scripts` and `npm run build`, with a fake HOME and package caches inside this Cell or a private `/var/tmp` root.

`bash .proof/C/run.sh` runs seven real-daemon scenarios. Pass scenario names to select a subset: `claude-once`, `codex-once`, `source-reset`, `unknown-reset`, `autoswap-false`, `active-owner`, `restart-waiting`.

The launcher replaces the environment, creates a private `/var/tmp/hb-quota-C.*` run root, and prints its result directory. It retains RPC snapshots, raw session journals, usage requests, daemon logs, and `summary.json`. Nonzero exit means a scenario failed. Assertions continue across scenarios when daemon teardown succeeds. No cleanup deletes run roots; filesystem removal by the fixture is redirected into that root's trash. Runtime shutdown uses only handles owned by this process.

Both accounts use synthetic fixture credentials. The initial store fixture seeds target exhaustion for the capacity scenarios. A loopback usage endpoint reports both accounts exhausted, then restores source headroom at the declared reset. A warmup initializes the native conversation before the quota work request. No `send` follows that work request. Continuation must be durable, delivered once on generation 2, and followed by a served turn. This proves transport and daemon continuation behavior; the fake Codex accepts resume by identity and does not prove strict cross-home context recall.

Unknown reset, autoswap opt-out, and active allocation without an owner coordinator must remain waiting without continuation. Their default observation window is 1600ms; pass `C_HOLD_MS=32000` to the launcher for a longer soak. Active owner deferral is a boundary check, not proof of the separate Apiary owner coordinator.

`bash .proof/C/verify.sh` runs repository typechecks, build, and the existing accounts RPC, loops, and runner-host suites under a fresh sanitized root. It prints the directory containing gate logs. It adds no unit tests. The repository verification skill is unavailable. DEPLOY HOLD remains in effect.

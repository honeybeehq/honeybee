# H1b-1 — reconnect latch and artifact target

A latched socket failure clears only after reconnecting to the exact runner process: current process birth/liveness and authenticated socket peer must agree. Missing peer evidence keeps the latch closed. Pending acknowledgements are untouched.

The actual-runner lab shows 100 refusals with zero writes before the change; reconnecting does not help on the baseline. After the change, a wrong-process socket is rejected without a write, then reconnecting to the exact owning runner clears the flag and one delivery is accepted. The historical ef5e9e67 driver seam reproductions are in Project research/h1b-ef5e9e67.md; this is not proof of the actual production bee's private state.

The build target is a build-time artifact fact. The daemon now refuses a known cross-target build before opening its store, instead of reporting a Darwin artifact as though it were a Linux build. The release import path already checks target in src/deployArtifact.ts; this adds the guard to direct daemon startup, which also covers copied development artifacts. JavaScript may be portable, but bundled native helpers and the artifact identity contract are target-specific. The identity is never relabelled from the running OS. The lab injects a wrong identity into the real daemon entry and asserts exit1 and no SQLite store, then verifies normal startup through the guarded doctor RPC.

Run with a clean environment, owned fake HOME and short owned TMPDIR:

```
H1_EXPECT_RECOVERY=1 node --experimental-strip-types scripts/lab/h1-socket-reconnect.mjs
node --experimental-strip-types scripts/lab/h1-target-guard.mjs
```

The doctor remains synchronous on its exclusive SQLite writer connection. H1a's measured 83ms at269570048 bytes is not a bound on larger databases. Moving the same connection to a worker is not supported, and opening another read-only connection is prevented by exclusive locking; no new competing store copy or authority was introduced.

No live daemon, accounts, leases or real credentials were accessed; no deployment or restart was performed. Lost-ACK reconciliation and visible held state remain separate H1c work.

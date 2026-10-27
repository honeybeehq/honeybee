# T24 bounded runner exit drain

The ordinary and fenced HSR runner hosts previously settled only on the direct child's `close` event. Inherited descendant pipes delay that event even after the direct child has exited and been reaped. Both now use `observeRunnerExit` in `v2/driver-hsr/src/runner-exit.ts`.

The policy is a one-second post-agent-exit drain, with immediate completion when pipes close normally. The timer starts only at direct-child exit, so a running agent's silence or a daemon disconnect never starts teardown. At the deadline the host destroys only its stdin/stdout/stderr capture handles, writes an exit receipt with the actual code/signal and `outputDrainTimedOut: true`, then follows its existing socket/status teardown. It sends no signal to descendants. Output arriving more than one second after agent exit is intentionally outside this capture window. Existing handling of incomplete JSON lines is unchanged.

The one-second bound is an implementation drain policy, not a performance target or measured speed improvement. It removes an indefinite host wait. Process counts/ownership and installed revisions are still required before attributing the mini04/mini07 failures.

## Reproduce before and after

Run from this checkout on Linux with dependencies installed. All fixture state stays under `.audit/`. The fixture runs the actual ordinary and fenced source hosts, not a model of their teardown.

```
node scripts/build-peercred.mjs
node findings/t24-before-runner.mjs
node findings/t24-runner-drain.mjs --baseline
node findings/t24-runner-drain.mjs
```

The baseline builder bundles the two lifecycle files from this Cell's pre-fix commit d2f3d514; other imports use the same checkout. Six cases cover both host types with no holder, finite holder and indefinite holder. A fixture-owned descendant inherits the real agent pipes. The agent writes a complete 128 KiB JSON record and exits 23. The holder writes delayed stdout/stderr inside the drain window. Each sample checks full byte-equivalent session/journal records, final stderr, delayed output, exit status and the holder's exact native identity. It confirms the holder is still live after host completion, then terminates only that fixture-owned PID. Host cleanup is bounded in finally. No production descendants are discovered or signaled.

Before: the two no-holder cases exit normally; all four holder cases still have no host exit receipt at the observation point. After: all six hosts exit with code receipt 23; four holder cases record outputDrainTimedOut and leave the holder alive until fixture cleanup. All six retain full final output; all four holder cases retain the delayed output. Raw structured observations are in `findings/t24-runner-drain-receipt.json`.

## Validation

- `npm run check`: pass.
- `npm run v2:check`: pass.
- `npm run build`: pass, including the explicit runner artifact import/size gate (22,058-byte v2 runner).
- Existing `runner-host.test.ts` and `execution-handshake.test.ts`: 25/25 pass. Invoked with `TMPDIR=/proc/$$/cwd/.audit/tmp node --test ...` so all temporary fixtures stay in this Cell while short Unix socket paths remain usable.
- `node scripts/perf-map.mjs drift`: non-green (169 unaccounted entries, one dead entry, 45 stale owners), including changed runner-host ownership. Existing map coverage is not a release or performance proof for this fix; no receipts or baselines were rewritten. Full local output: `.audit/t24-perf-drift.json`.
- Initial existing-check run with `/proc/self/cwd` as TMPDIR failed 2/25 because child cwd changes reinterpreted those paths. Using the stable launching shell PID fixed both; no production change was needed for them.
- Source fixture: all six before cases and all six after cases pass their respective expected observations.

No new tests or code comments, deployment, setting changes or live-host reads. Dependencies/native build artifacts were installed only in this Cell. The native build enabled the authenticated fenced-host fixture. Missing repository verification skill and missing process-retention perf workload remain setup gaps, not claims of verification coverage.

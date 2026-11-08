# Loaded-host shutdown and driver observation repair

This is a continuation of proof-15025dfc0445af9a0ae978dce440d6d4, based on main 75dccd49943f9b1a2312bf03d3d1e221f87c4019. It addresses the later Studio LIVE runner timeout and the three driver failures reported on the Studio retry. Production daemon restart/deploy still calls detachAll and preserves bees.

## Two ordering defects

The quiet-RPC restart reassigns its daemon handle correctly. Its final stop does wait for successor ownership when live receipts exist. That ownership proof precedes shutdown, however: disposeAll attempted a single identity-fenced SIGKILL and never acknowledged exit. A later failed identity observation or signal attempt could leave an adopted detached host alive. Ephemeral shutdown now snapshots owned runtime records, attempts disposal, retries with the original birth fence, and waits for native gone/zombie/proven reuse. It fails with remaining identities and observations after a monotonic 15-second budget. Shutdown rejection explicitly propagates to the daemon's nonzero exit path, with a nonzero backstop for retained sockets. The helper's separate four-second postcondition now honors scaledMs; its default remains four seconds. This is not a larger default reap allowance.

The instant-death driver's zero-boot assertion revealed a second real ordering defect. A host exit callback can beat watcher/sweep status consumption. finishHost previously parsed the journal then deleted the runtime without reading the final agentPid status, permanently omitting synthetic startup evidence. It now consumes final status before journal/exit, with a flag that suppresses only recursive exit handling. Exact synthetic/real boot assertions remain.

## Test synchronization

The silent-turn adoption test read a journal append, slept 70ms, then assumed the driver had consumed it. It now waits for a recovery cursor covering the UTF-8 byte boundary through the native message81 start line's newline. Its 180ms negative silence assertion remains. The readyAtSpawn and late-init tests' explicit three-second bounds bypassed existing scaling; upper bounds are now scaled fifteen seconds. Exact boot counts/types, crash cause, one turn end and the late-init >=500ms lower guard are unchanged.

## Controlled comparisons

`shutdown-both-old-red-suite.log` holds the old one-shot disposal path through a guarded source loader. Both first-identity refusal and first-group-signal failure leave a LIVE adopted host reparented to PID1 with PGID=PID, and fail the strict helper postcondition. The retry implementation handles both. A permanently refused identity still fails stop, records a disposal timeout and exits1; the test shortens only that injected timeout to100ms and verifies emergency cleanup.

`status-exit-valid-old-red-suite.log` withholds both ordinary status drains and removes the new final drain. The existing instant-death test fails exactly with boot count0 instead of1. The same controlled schedule passes with final-status consumption. The first attempted wrapper inherited NODE_TEST_CONTEXT and produced empty child output; it was invalid, explicitly excluded, then corrected by unsetting that context and requesting TAP. `status-exit-old-red` and `status-and-driver-focused-green` in local audit are excluded intermediates, not startup ordering proof.

Independent worker aa1cb3d2 ran the unchanged75 baseline's four selected driver cases three times under20 owned CPU burners:12/12 passed. Those runs did not naturally reproduce the Studio failure. The source review and controlled schedule establish the ordering mechanism, not the historical trigger. Native Linux worker8155c7cd independently applied and tested the supplied patch; its original six-file19/19 result precedes the driver expansion and must not be substituted for final expanded verification.

## Evidence scope

The two `shutdown-frozen-focused-*` runs passed13/13 each in235.9/233.1s, each launching ten owned CPU burners (twenty during overlap). They cover the initial six-file disposal repair before the later driver expansion; the disposal code bytes are unchanged, but they are not final combined-source whole-suite runs. `driver-final-focused-green` covers all four requested driver cases plus the controlled regression under20 launched burners,5/5 in10.49s.

The earlier broader driver run (`shutdown-frozen-driver`) failed one unchanged three-second startup wait:280passed/1failed/4skipped. It is retained as red evidence, not called a pre-existing baseline failure. Final expanded-source runs and native Linux reports are listed separately in RESULTS.md. The burner's launcher records owned PIDs/configuration and reaps them; these new receipts do not continuously sample CPU/liveness. No continuous-stress or complete daemon/CLI gate claim is made.

The helper's emergency cleanup sends SIGKILL before rethrowing a failed postcondition. Therefore a PID disappearing after the failed Studio gate does not prove natural exit just beyond four seconds. No original daemon trace was retained, and the exact historical signal failure versus scheduler delay remains unknown. Original release-only driver2 failures are not cleared by this repair.

## Reproduce safely

Use pinned dependencies/native build. All commands below use the committed wrapper's isolated HOME/XDG/HIVE paths, short /tmp roots and fixture warden, never the live daemon. Run names must be fresh. The wrapper exits with the test child's status and stops only its own burner PIDs.

```sh
STRESS_WORKERS=20 python3 .proof/macos-runner-shutdown/run-stressed.py new-driver --npm-script v2:driver
STRESS_WORKERS=20 python3 .proof/macos-runner-shutdown/run-stressed.py new-daemon v2/daemon/tests/helpers-teardown.test.ts v2/daemon/tests/turn-quiet-rpc.test.ts
HIVE_TEST_OLD_DISPOSAL=1 STRESS_WORKERS=0 python3 .proof/macos-runner-shutdown/run-stressed.py old-disposal --test-name-pattern='test shutdown retries a transient' v2/daemon/tests/helpers-teardown.test.ts
HIVE_TEST_OLD_FINISH_HOST=1 STRESS_WORKERS=0 python3 .proof/macos-runner-shutdown/run-stressed.py old-status --driver-files v2/driver-hsr/tests/status-exit.test.ts
```

The two old commands are expected red. Remove each old-path variable for green. Source hooks are guarded test fixtures, not runtime configuration. No deployment was performed.

Confirmed path: upstream mirror heartbeat ownership

An isolated Node v24.18.0 process starts 50 short-lived Worker threads. Each imports actual holdMirrorLock from driver-cell/upstream.ts, starts the heartbeat and immediately releases it. Before: zero zombie children. Baseline after: 50. Remove child.unref(): after zero.

The async child is a process child of hived, but its libuv wait handle belongs to the worker thread. release() SIGKILLs the helper; unref() allows the worker loop to end before the child exits and is waited for. Once the worker closes its handle, the still-running daemon cannot reap it through that worker. Repeated mirror refresh/retention work accumulates zombies. Detached spawning and missing JS exit listeners alone do not cause this.

Read-only live mini03 ps confirmed 2021 defunct children under PID718. Names are all <defunct>; exact live zombie attribution is unavailable under permitted observations. No live database/environment access or signals.

The minimal retain-handle fix fails forced Worker.terminate (Darwin 0 -> 50). Final fix replaces the heartbeat OS process with an owned nested Worker timer. Both natural and forced teardown produce zero zombies, including forced teardown without release. Synchronous callers need no API change; heartbeat remains independent of their blocked loop. Darwin confirmed mtime updates while owner blocks and stops after owner termination.

Real isolated HiveDaemon differential: baseline 50 calls raises zombie count 0 -> 50; health warning reports 50 and built CLI doctor prints the warning and exits 1. Fixed daemon same loop stays 0 -> 0; health ok, doctor exits 0.

Self-check: async ps PPID/state-only census at startup and once per minute, 5s timeout, bounded output, single-flight. More than three zombie children emits daemon.children.zombies warning and sets health childHealth warning; doctor alerts and returns 1. Census failure reports unavailable rather than zero. No cleanup signals or waitpid(-1) that could steal another owner’s exit status.

Limits: permitted live ps cannot prove that every existing zombie originated from this path, and this change does not remove existing production zombies. No deploy/restart performed.

Setup: no general repository verification skill installed (only specialized lifecycle/lease skills); applicable diagnosis and core architecture contract used. Cell initially lacks node_modules; installing lockfile-pinned dependencies with lifecycle scripts disabled for check/build.

Validation commands (all passed):
- npm run check
- npm run build
- node scripts/with-fixture-warden.mjs node --test v2/daemon/tests/child-health.test.ts v2/daemon/tests/identity-recovery.test.ts v2/driver-cell/tests/heartbeat-reaping.test.ts v2/driver-cell/tests/upstream.test.ts (33 tests)
- node .proof/zombie/isolated-hived.mjs (50 heartbeat cycles inside actual isolated daemon; health RPC plus built doctor)

The baseline daemon evidence used the exact HEAD upstream.ts temporarily and restored the final source in a finally block. It ran the same isolated-hived script and exited 1 because it observed 50 zombies. No baseline copy remains in production source. Independent Darwin evidence is recorded in darwin-independent.json from authenticated child messages.

Permitted live observation repeated near completion: PID718 had 2025 children, all zombies (four more than initial ~2021 during this investigation). No names beyond <defunct> and no live recovery attempted.

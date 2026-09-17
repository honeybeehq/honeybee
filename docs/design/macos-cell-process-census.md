# macOS Cell process census

The macOS runtime builds `dist/native/process-census`, an unprivileged, read-only
executable. Honeybee's HSR identity reader uses this companion when available.
It reads `KERN_PROC_ALL`, which the existing Sandbox Runtime policy already
allows through `kern.proc.all`. It does not change the Cell policy or grant any
new process-inspection, signal, or filesystem permission.

## Apiary driver contract

On macOS, replace the `controlProcessOps().readRows()` invocation of
`/bin/ps -ww -ax -o pid=,ppid=,pgid=,state=,lstart=` with the helper from the
**same installed Honeybee release on the execution node**, with no arguments.
For the standard install this is
`~/.hive/runtime/current/dist/native/process-census`. Resolve the release once
when opening the driver, so a subsequent deployment cannot swap its helper.
Do not resolve the binary through the Cell's PATH or a Cell-controlled override.

- Stdout has no header: `PID PPID PGID STATE LSTART`, one process per line.
- Topology and birth come from one complete kernel census, including detached,
  reparented, and zombie processes. There are no command lines or environment
  variables in the output.
- `STATE` is the kernel process state: `I`, `R`, `S`, `T`, or `Z`. `Z` identifies
  zombies. It is **not** a thread scheduling sample or the full set of ps display
  modifiers (such as `+`, `s`, or `N`). Consumers must use it for zombie/stop
  handling, not CPU profiling or detailed thread state.
- `LSTART` is the local-time C-locale `ps lstart` representation, with the same
  second-level precision as existing durable HSR fingerprints. Keep timezone
  consistent between observers. No birth-token migration is needed.
- `--identity` omits `STATE`; Honeybee uses this form with its existing parser.
- Exit 0 means a complete census was read and emitted. Exit 2 indicates an error,
  with a diagnostic on stderr. Other exits/signals are also failures. In
  particular, there is no special “missing selected PID” exit status.
- Bound execution time (5 seconds) and output (16 MiB), as the existing HSR
  reader does. A spawn error, nonzero exit, signal, timeout, malformed output, or
  output-buffer overflow means **unverifiable**, never an empty process list.
- Retain the driver's ownership/ancestry validation, birth checks immediately
  before signaling, and complete descendant cleanup. Visibility alone never
  authorizes signaling a process.

`KERN_PROC_ALL` sizing/fetch races retry at most eight times with headroom.
Partial reads, persistent growth, invalid records, and omission of the reader's
own PID fail. The executable neither sends signals nor acquires task ports.
Apple's ps also derives `lstart` from `p_starttime.tv_sec`; see
[Apple's ps implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/print.c).

## Build and distribution

`npm run build` compiles the helper on Darwin with the installed command-line
C toolchain. `npm run build:test` also builds it beside compiled tests. The npm
package already includes `dist/`, so the executable travels with a macOS runtime
artifact. The destination must match its OS and architecture. No compiler,
privilege elevation, copied system binary, or runtime compilation is required
on a deployed node. Linux continues to use its existing ps reader.

A standalone downloaded runner-host JavaScript bundle has no native companion;
its existing ps behavior remains unchanged. Do not advertise contained macOS
census support for that bundle without staging the helper from a matching
release too. Missing companions fall back to existing ps behavior, which fails
closed inside the affected Cell. A broken companion fails directly; its error
is not hidden by a ps retry.

On mini06, the default macOS 27 SDK fails to link with the installed linker
(`unknown architecture arm64e.x1`). Build verification used the already-installed
SDK explicitly:

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk npm run build
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk npm run build:test
```

## Verification and limits

`tests/hsr-cell-process-census.test.ts` verifies live birth/topology, native
failure behavior, comparison with ps where executable, and the production
`wrapCellSandboxCommandForState` path with file-write containment. Existing
`tests/hsr-session-base.test.ts` verifies detached descendant cleanup and
protection of an unrelated sibling group.

The live inherited mini06 Cell reproduced `spawn /bin/ps EPERM` before the fix.
The native regression and cleanup cases pass in that same sandbox. Nested
Seatbelt application is refused there, so the fresh-wrapper containment test
and host-vs-ps comparison must additionally run from a host test shell:

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  node --import tsx --test tests/hsr-cell-process-census.test.ts tests/hsr-cell-sandbox.test.ts
```

The executable restriction is established at spawn, before ps can inspect any
process. The setuid bit on `/bin/ps` remains a leading explanation, not a
conclusively isolated cause. Native inspection succeeds without changing
process-info permissions. Full Apiary graphical startup profiling requires the
companion driver change above and has not been verified by this Honeybee change.
Rollout requires a normal reviewed `hive deploy` and driver adoption; no deployed
runtime, running policy, or live agent was changed during development.

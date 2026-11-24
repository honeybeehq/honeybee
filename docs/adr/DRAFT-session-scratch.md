---
status: draft
---

# Make `/tmp` inside a session the session's own scratch

Draft of 2026-11-24 for Tormod, after his question "Why are agent sessions so
extremely eager on using /tmp? We have had this issue before" (HON-34). Nothing here
is built. Every claim marked **ran** has a script and its output under
`.proof/session-scratch/`; claims marked **read** come from the code only.

## The answer

Agents use `/tmp` because it is the one path that exists and is writable on every
computer they have ever seen. A `TMPDIR` or `HIVE_SCRATCH` variable cannot compete
with a path you can type from memory, and briefs, skills and our own tests type it
too. So the fix is not to steer agents away from `/tmp`. It is to make `/tmp` belong
to someone.

On Linux, each session starts in its own mount and process namespace. Inside it,
`/tmp` **is** the session's scratch folder: a folder on disk that Honeybee owns,
measures, limits and removes. A literal `/tmp/x` lands there. When the session's
runtime ends, the kernel ends every process it started. The agent is told nothing
and forbidden nothing.

```
            what the session sees                what the computer holds
   ┌────────────────────────────────┐
   │ /tmp, /var/tmp, $TMPDIR,       │──bind──▶  <pool>/<bee>/          owner: the session
   │ $HIVE_SCRATCH                  │                                 limit: bytes + inodes
   │ /dev/shm  (RAM, capped)        │                                 gone: with the session
   │ own process ids                │──kernel─▶ all processes die with the runtime
   │ $HIVE_SCRATCH_HOST ───────────────────▶  the real path, for handing a file over
   │ the computer's cache ─────────────────▶  <pool>/cache/          owner: the computer
   └────────────────────────────────┘          the host's /tmp        untouched
```

macOS has no mount namespace. There the design gives owner, lifetime and limit to
everything under `$TMPDIR`, and a hard cap for the whole pool, but a literal `/tmp`
path still reaches the shared folder. That part stays an instruction on macOS. I say
so plainly in "macOS" below.

## What happened, and why each guard missed

| Guard that exists | Why it did not help on trmd-metal-3 |
|---|---|
| Per-bee `TMPDIR` (`v2/daemon/src/beeTmp.ts`) | Works for tools that read it. A typed `/tmp/...` ignores it. Claude Code itself ignores it for task files: this session's `TMPDIR` is my scratch, and its sub-agent outputs still went to `/private/tmp/claude-501/`. |
| `HIVE_SCRATCH` | Set for Cell bees only (`daemon.ts:2029`) and announced nowhere: no prompt, no doc, no skill mentions it (**read**). |
| Private `/tmp` under bwrap (`driver-cell/src/sandbox.ts:45`) | On by default for satellites only (`sandbox.ts:23`). metal-3 is a workstation, so no session there ever had it. It is also a 1 GiB RAM tmpfs that is lost at exit, not the bee's scratch. |
| Retention (`cellRetention.ts`) | Measures scratch bytes for `cell gc` output only. They are in no budget. Inodes are measured nowhere (**read**). |
| Stop | Signals one process group (`driver-hsr/src/driver.ts:1687`). A process that calls `setsid` leaves the group. That is how 51 processes lived 16 days. |
| systemd-tmpfiles, 10 days | Deletes only what is old on all three clocks, and `/tmp` is mounted `strictatime`, so any `find` or `du` over it resets every directory it lists. See "The host's cleaner". |
| Placement (`workspaces.placement.ts:217`) | Ranks by fewest working sessions and reads no failure history and no inode fact. A computer that cannot start anything wins. |

## Decision

### 1. What sessions put outside their Cell, and who owns it

From the metal-3 inventory (1,048,576 inodes) and the code:

| Class | Evidence | Owner | Goes away | Limit |
|---|---|---|---|---|
| Throwaway files, clones, worktrees, build trees | 386,334 inodes in five trees (37%) | the session | with the session's scratch | session bytes and inodes |
| Things `trash`ed inside `/tmp` | 49,433 (5%) | the session | same; it is the same folder | same |
| Sockets, pipes, lock files | small | the session | with the runtime's processes | counted in scratch; `/dev/shm` capped in RAM |
| Lab homes for daemons under test | `/tmp/lab-hived-*`, `/tmp/bsc`, `/tmp/t1chk-hive` | the session that started them | files with the scratch; daemons with the runtime | same |
| Package stores, SDKs, toolchains, reference clones | 59,986 (6%), fetched again per session | the computer | least recently used, under the cache limit | cache bytes and inodes |
| Files handed to a person or another session | not countable | whoever takes them: a share, or "keep" | until the taker releases them | the share's or the pool's |
| Honeybee's and Apiary's own runs | 5,457 `hb-rh-*`, 920 test entries | the run that made them | removed by the parent of the run | none needed |
| Unknown | about 425,000 that `du` could not reach (40%) | — | — | needs a root read on metal-3 |

Three mechanisms cover these: **session scratch** (rows 1–4), **the cache** (row 5)
and **a share** (row 6). Row 7 uses session scratch too: a test run is a session.

### 2. Linux: the session namespace

Every runtime of every bee, Cell or in place, every harness, starts through one
wrapper. bwrap is already a dependency.

```
bwrap --dev-bind / /                      (or today's --ro-bind / / when confinement is on)
      --bind <pool>/<bee> /tmp  --bind <pool>/<bee>/.var-tmp /var/tmp
      --size <shm cap> --tmpfs /dev/shm
      --unshare-pid --proc /proc --die-with-parent
      --setenv TMPDIR /tmp --setenv HIVE_SCRATCH /tmp --setenv HIVE_SCRATCH_HOST <pool>/<bee>
      [--bind-try <passthrough> ...]  --  <harness command>
```

- **Capture is separate from confinement.** Confinement (read-only root) stays the
  setting it is. Capture is on for everyone.
- **The scratch folder is the one that exists**, `<dataDir>/tmp/<beeId>`. Nothing
  moves at upgrade.
- **`TMPDIR` becomes `/tmp` again.** That removes the long-path problem for sockets
  that `beeTmp.ts:174` warns about. My own scratch path on this Mac was too long for
  the runner socket during these experiments.
- **The runner host stays outside the namespace**, as today, so the daemon still
  reaches its socket.
- **If user namespaces are unavailable**, the daemon's start-up probe fails
  (`bwrap: Creating new namespace failed`, **ran**), the computer reports
  `capture: env`, and sessions run as today with `TMPDIR` only. Processes are still
  fenced by a cgroup scope, which needs no namespace. The person sees the fact in
  Fleet and placement can prefer computers that capture.

**Ran on trmd-metal-2** (Debian 13, kernel 6.12, bwrap 0.12, no root):

| Test | Today | With the wrapper |
|---|---|---|
| Literal `/tmp/x`, `mktemp`, node `os.tmpdir()`, python `tempfile` | host `/tmp` | the bee's folder; host `/tmp` untouched; files keep the user's uid |
| Two sessions | share `/tmp` | do not see each other |
| Real HSR driver + real runner host + stub agent, then `driver.stop()` | 2 of 3 started processes survive | 0 survive, open root and confined |
| Cost per session start | — | 15.5 ms |

Per harness I could only go this far: the stub agent through the real driver in both
shapes, and the `grok` binary starting in both shapes. `claude`, `codex` and
`cursor-agent` are not installed where forage runs on metal-2, and I may not run them
against a login. Nested sandboxes work inside (`bwrap` in `bwrap`, `unshare -Urm`),
which is what Codex's and Claude's own tool sandboxes need.

### 3. What breaks

| Thing | Result | Change |
|---|---|---|
| tmux | works; the server is the session's own and dies with it (**ran**) | to attach from outside: `hive exec` into the session |
| pty, node-pty | works in both shapes (**ran**) | none |
| `node --inspect`, any TCP port | works; the network is shared (**ran**) | none |
| Debugging from outside | the person sees the session's processes by host pid; its `/tmp` is `/proc/<pid>/root/tmp` (**ran**) | none |
| gdb, strace, Chromium, Playwright | **not run**: none is installed on metal-2 | expected to work; `/dev/shm` cap must be ≥ 256 MB for Chromium |
| docker CLI | works (**ran**) | none |
| `docker run -v /tmp/x:/x` | **breaks quietly**: the daemon resolves `/tmp/x` on the host | use `$HIVE_SCRATCH_HOST/x`. This one is an instruction. |
| ssh client | **breaks**: root-owned config looks owned by `nobody` (**ran**) | the fix exists: the ssh config view in `sandbox.ts`; use it for the open shape too |
| `sudo`, other setuid tools | **break** inside a user namespace (**ran**) | none without root. See "Most likely wrong" 1. |
| ssh agent socket, X11 under the host's `/tmp` | invisible without help; works when bound in (**ran**) | `scratch.passthrough`, default: `/tmp/.X11-unix` and the folder of `$SSH_AUTH_SOCK` |
| `hb-rh-*` runner sockets | unaffected; the host is outside | move them out of `/tmp` anyway (section 8) |
| Apiary kernel MCP | unaffected: HTTP on 127.0.0.1, config under `~/.apiary/mcp` (**read**) | none |
| forage | unaffected: its only temp file goes through `os.tmpdir()`, so it lands in the session's scratch (**read**) | none |
| A parent and its children passing `/tmp/x` | **breaks**: each has its own `/tmp` (**ran**) | pass `$HIVE_SCRATCH_HOST/x`, or use a share |
| A lab daemon other sessions join | **breaks** if its socket is in `/tmp` | put it in a share |
| An agent telling the person "see /tmp/report.html" | the path means nothing outside | Honeybee knows the mapping; the session panel resolves it (section 7) |
| Background processes | end when the runtime ends | on purpose. For something that must outlive it: `run.command`, which the daemon owns. |

**A share is explicit.** `hive share create <name>` makes `<pool>/shares/<name>`,
owned by the bee or person who made it, removed when the owner goes or releases it,
counted against the owner. Members get it at the same path. Adding it to a session
that is already running works without root: the daemon enters the session's
namespaces and binds it (**ran**).

### 4. Lifetime and processes

```
runtime start ──▶ runtime end ──▶ revive ──▶ … ──▶ archive ──▶ +3 days ──▶ gone
 processes         all killed      new ones         (stopped)    in pool trash
 scratch files ─── kept ─────────── kept ─────────── kept ─────── restorable ── removed
```

- **Files** live as long as the bee. Stop and revive keep them. Archive moves them to
  the pool's trash for `scratch.keepAfterArchive` (3 days), then they go. Delete
  removes them at once. An idle stopped bee's scratch follows the Cell retention rule
  that exists (`idleDays` 7), and the same rule now applies to bees with no Cell.
- **Getting something back or keeping it:** unarchive within the grace restores the
  scratch. `hive scratch keep <bee> [path]` moves it to `<pool>/kept/`, owned by the
  person, never removed automatically, shown with its size.
- **Under pressure**, in this order: trash, cache (least recently used), idle
  stopped bees. Never a live session, never something kept.
- **Processes** live as long as one runtime. The pid namespace makes this the
  kernel's job: when the wrapper dies, everything in it is killed, whatever it did
  with `setsid`, `nohup` or double fork. The graceful SIGTERM still reaches the agent
  first, because the group signal is unchanged.
- **Second fence:** each runtime also gets a cgroup scope (`systemd-run --user
  --scope`, **ran**: `pids.max` and `memory.max` set, `cgroup.kill` leaves 0). It
  gives the process count, a limit, and the fence on hosts without namespaces.

**Why 51 processes survived 16 days (cause in the code).** `stop` calls
`signalGroup` (`driver-hsr/src/driver.ts:1687`), which is `process.kill(-hostPid)`.
The runner host is spawned detached (`:573`) and the agent joins its group
(`runner-host.ts:214`). The harness started `pnpm play:harness --serve` in new
sessions, each with its own group, so the signal never reached them. No pid
namespace, no cgroup and no census exists; eviction never signals anything. systemd
adopted them. The design closes it in the kernel, not with a better search.

### 5. Limits that cannot take the computer down

All session scratch and the cache live in one **pool**. The pool has a kind, and the
kind decides who enforces.

| Pool kind | Needs | Per session | Per computer | What the session sees at the limit |
|---|---|---|---|---|
| `quota` (Linux, recommended) | root once | kernel: bytes and inodes | kernel: the pool is its own filesystem | ordinary `No space left on device`; `df /tmp` shows its own limit |
| `volume` (macOS) | nothing | sampled | kernel: APFS volume quota | sampled: see below |
| `folder` (default until set up) | nothing | sampled | floors | sampled: see below |
| `memory` (setting) | nothing | kernel: tmpfs `size` and `nr_inodes` | sum of caps, in RAM | ordinary `No space left on device` |

**`quota`, ran in a privileged container on metal-2** (`linux/12-quota.out`). Root
makes an XFS filesystem with project quotas once and sets a default limit. After
that:

- The unprivileged daemon gives each session folder its own project id. No root.
- The session sees `df /tmp` = 20 MB and 500 inodes. Both end in `No space left on
  device`.
- The session cannot move itself to another project (`Invalid argument`), because it
  runs in a user namespace.
- A second session is untouched. A session with a raised limit cannot pass the size
  of the pool. The filesystem holding the daemon's store stays writable.
- The daemon reads a session's use with one `statfs`. No tree walk, no polling of
  files.

**Sampled** means the existing 5-second sampler pattern (`sandboxTmp.ts`). At the
limit the bee gets `resource_blocked` with "scratch 20 of 20 GB" and the person can
raise it or clean. If the computer falls under its floor, the daemon freezes the
largest live session (cgroup freeze on Linux, SIGSTOP on macOS) until there is room.
The session does not get an error it can read. That is where `folder` and `volume`
fall short of the goal.

**Where scratch lives.** On disk, not in RAM. The clone that held 137,679 inodes was
2.4 GB; many of those in RAM is the wrong default, and a tmpfs is lost when the
runtime ends. `/dev/shm` stays RAM, private, capped. `memory` remains a setting for a
small host that wants hard limits without root.

**The daemon cannot be starved.** Its store and runner sockets are outside the pool.
With `quota` or `volume`, sessions cannot take that space at all. With `folder`, the
daemon keeps a 1 GiB ballast file beside its store and refuses new sessions under the
floor. Floors are bytes **and** inodes.

### 6. Not downloading the world each time

`<pool>/cache/`, owned by the computer, limited in bytes and inodes, evicted least
recently used, reachable at the same path from every session.

- **Package stores by environment.** The daemon sets the store or cache variable for
  pnpm, npm, pip, uv, cargo, go and gradle to folders in the cache. The agent types
  nothing. **Ran:** a second session's `pnpm install` took 0.76 s from a warm store
  on the same computer.
- **Reference clones.** Honeybee keeps a bare mirror of each repository it has Cells
  for. **Ran:** `git clone --reference <mirror>` took 32 ms and 136 KB, against
  3.5 s and 91 MB for a plain clone of this repository.
- **Toolchains.** `hive cache fetch <url> [sha256]` downloads once, unpacks once and
  prints a read-only path. The Android SDK appeared twice in the inventory.

Shortfalls. `--reference` and `hive cache fetch` are things an agent must know about,
so they are in the tool's help and not automatic. pnpm 11 copied files from its store
instead of linking them in my run, so the inode saving for `node_modules` is not
shown. With a `quota` pool, hard links across project ids fail by design; the cache
must be read through copy or reflink, and that needs measuring before step 6.

### 7. Seen and changeable

**Per session** (in `ViewResult`, for the session panel): scratch bytes and inodes,
both limits, `enforced: filesystem | sampled`, live process count, `capture: mount |
env`, the real path, kept bytes, what archive would reclaim.

**Per computer** (in `NodeCapacity`, for Fleet and placement): pool kind; pool bytes
and inodes total and free; both floors; reclaimable bytes and inodes; cache size;
`capture`; the process fence in use; and free inodes of the host's own `/tmp`, since
other software still uses it.

Samples do not become audit rows every 5 seconds. Like `node.capacity` today, an
event is written when a state changes (under floor, at limit); the numbers ride the
snapshot and an on-demand read.

**Path resolution.** Honeybee knows each session's mapping, so `hive scratch path
<bee> /tmp/report.html` prints the real path and Apiary can make `/tmp/...` in a
transcript a link that opens the real file.

**Settings.** Every default is a key. Home resolves it (session, workspace, all,
install) and sends the value at start; Honeybee holds the computer's own defaults in
`config.json` and `hive config` grows from `cells.retention.*` to `scratch.*` and
`cache.*`. There are no deny lists and no hooks.

| Key | Default |
|---|---|
| `scratch.capture` | `auto` (mount where the computer can, else env) |
| `scratch.pool.path`, `scratch.pool.kind` | `<dataDir>/tmp`, `folder` |
| `scratch.session.maxBytes`, `.maxInodes` | 20 GiB, 500,000 |
| `scratch.shm.maxBytes` | 1 GiB |
| `scratch.floor.bytes`, `.inodes` | the retention floor that exists; 5% of inodes |
| `scratch.keepAfterArchive` | 3 days |
| `scratch.passthrough` | X11 folder, ssh agent folder |
| `session.processes.max`, `session.processes.end` | 4,096; `runtime` |
| `cache.maxBytes`, `cache.maxInodes` | 50 GiB, 2,000,000 |

Honeybee owns these facts. Apiary mirrors and shows them, and places by them.

### 8. Honeybee's own leaks

| Leftover | Source | Why it stays |
|---|---|---|
| `hb-rh-*` (8,027 empty folders on metal-2 today) | `daemon.ts:914` takes `tmpdir()` before the daemon moves its own `TMPDIR`; `runner-host.ts:180` makes a folder per generation | only the socket is removed (`runner-host.ts:234`, `:296`); the folder never; no sweep. **Ran:** the folder is left after a clean stop. |
| `hb-v2-daemon-*` | `v2/daemon/tests/helpers.ts:280` | cleanup runs in the test process; a killed run leaves it |
| `batching-*`, `human-first-*`, `hb-backup-*` | `mail-batching.test.ts:32`, `human-first.test.ts:15`, `store-backup.test.ts:15` | never removed |
| `gateway-cell-*`, `t1c-*` | Apiary test support and a proof script, both gone from Apiary main | never removed |

One mechanism, the same as for sessions: **the parent owns the scratch and removes
it; the child is never trusted to.**

- Runner sockets move to `<dataDir>/run/<bee>.<generation>/`. The daemon removes the
  folder when it records the runtime stopped, and at boot removes every folder with
  no live runtime. The path is short and is not in any `/tmp`.
- Test and gate runners (`scripts/run-node-tests.mjs`, the fixture warden, Apiary's
  `with-test-root.mjs`) start the run inside the session wrapper on Linux, with a
  per-run scratch, and remove it when the run ends however it ends. A test that
  types `/tmp` or forgets `rm` then leaves nothing. On macOS the runner sets `TMPDIR`
  and removes the folder; a literal `/tmp` in a test is still a leak there.

### 9. The host's cleaner

Do not rely on it. **Ran** on metal-2 (`linux/05`–`08`):

- The rule `q /tmp 1777 root root 10d` removes an entry only when its access, change
  and modify times are **all** older than 10 days.
- `/tmp` is mounted `strictatime`, so listing a directory makes it new again. Of
  11,115 top-level entries older than 10 days by modify time, 11,040 had been read
  that day. My own read-only probe then reset them again. I extended their lives by
  running `find`. Any agent's `du` or `find /tmp` does the same.
- It does remove old files inside trees. What stays is directories: 9,770 old empty
  ones on metal-2, 8,027 of them `hb-rh-*`. Each is one inode, for ever.
- In a lab folder with the same rule at 3 seconds: a fresh write, a held `flock` and
  a live socket protect an entry. An open file or a process's working directory do
  not. One listing protects a directory.
- Apiary's hourly `apiary-tmp-sweep` only looks at `apiary-*` names.

I did not check on metal-3 why files inside `/tmp/miner` survived. An age rule on a
shared folder guesses at ownership. The design replaces the guess with an owner.

### 10. macOS

| Mechanism | Captures a literal `/tmp`? | Cost | Verdict |
|---|---|---|---|
| Per-session `TMPDIR` (exists) | no | none | the floor |
| Seatbelt profile | **refuses** it: `Operation not permitted`. It cannot redirect (**ran**) | none | a setting, off by default: it forbids |
| `DYLD_INSERT_LIBRARIES` rewrite | node: yes. `/bin/sh` and anything a shell starts: no, SIP strips it (**ran**) | fragile | rejected |
| One APFS volume with a quota for the pool | no, but caps the pool in the kernel | no admin; 1.4 s to create, 2.8 s to delete (**ran**, 64 MB) | **use for the pool** |
| An APFS volume per session | no; a custom mount point needs root | 1.4 s per start; shows in Finder | a setting for hard per-session limits |
| Sparse disk image per session | no | 1.2 s attach, 10.5 s detach (**ran**) | rejected |
| chroot, a VM or container per session | yes | root, or a different product | rejected |

Processes on macOS: killing the group leaves `setsid` children (**ran**), and so does
`launchctl bootout` of a per-session launchd job (**ran**). There is no kernel fence
without root. The design uses a census at stop: the process tree while it is still
linked, plus every process carrying the bee's `HIVE_BEE_ID`. **Ran:** the marker is
readable for node and python, not for Apple's own binaries such as `/bin/sleep`, and
not after a process cleans its environment. So on macOS a determined or unlucky
process can still escape, and the session panel should say "census", not "fenced".

What remains only an instruction on macOS: literal `/tmp` paths. The harm is smaller
there: APFS has no fixed inode table, so inodes run out only when bytes do, and the
floors see bytes. Honeybee should also say where scratch is, once, in
the placement text it already injects: "Your scratch folder is `$HIVE_SCRATCH`; it
is removed with the session." That is a fact, not a prohibition.

## A path to it

Each step helps alone. "Red first" is the test that fails today.

| # | Step | Needs | Red first |
|---|---|---|---|
| 1 | **Never a black hole.** Measure bytes and inodes of the pool and of the socket folder; publish them; refuse any start under a floor with `resource_blocked`, not five `boot_exit`s. Move runner sockets to `<dataDir>/run`, removed by the daemon; sweep `hb-rh-*`. Apiary: skip blocked computers and debit a computer after failed starts. | new `NodeCapacity` fields; Apiary placement | a lab daemon whose socket folder is a 1,000-inode tmpfs, filled: today five `boot_exit`s and it still wins placement |
| 2 | **Capture and the process fence on Linux**, for every bee. | wrapper in the spawn path; health reports `capture` | `.proof/session-scratch/proto/run.ts`: today 2 survivors and a file in host `/tmp` |
| 3 | **Facts and sampled limits** per session; the panel and Fleet show them. | `ViewResult.scratch`; new `resource_blocked` reasons; Apiary UI | a session writing 2× its limit raises no flag today |
| 4 | **Lifetime:** trash with a grace, keep, the idle rule for bees without a Cell, `hive scratch orphans` for what is already in shared `/tmp`. | store: kept and trash records | archive deletes scratch at once today |
| 5 | **The cache:** environment for package stores, mirrors, `hive cache fetch`. | cache accounting | two sessions fetch the same SDK twice |
| 6 | **Kernel limits:** `hive scratch pool install` for an XFS pool on Linux; the APFS pool volume on macOS. | root once on Linux | a session fills the data disk and the store fails to write |
| 7 | **Our own runs** inside the wrapper. | both repositories | a killed test run leaves `hb-v2-daemon-*` |
| 8 | **macOS census** at stop; the scratch sentence in the placement text. | none | `mac/03-processes.sh`: 1 survivor |

Step 1 would have turned today's outage into one blocked computer that placement
avoided. Step 2 would have kept `/tmp` from filling. I did not read metal-3's logs,
so "the sessions died because nothing could be created in `/tmp`" is likely, not
shown.

**Sessions running at upgrade** keep the host's `/tmp` until their next runtime
generation. Nothing is restarted for this. The per-session `capture` fact shows which
are which. Their scratch folder is the same folder before and after.

**What is already in shared `/tmp`** has no owner Honeybee can prove, so Honeybee
deletes none of it except its own `hb-rh-*`. `hive scratch orphans` lists the rest by
age, inodes and live processes for a person to decide.

## Reason and alternatives

Rejected:

- **Tell agents to use `$HIVE_SCRATCH`.** It is what exists. It failed.
- **Refuse writes to `/tmp`** (Seatbelt, Landlock). It forbids, and every tool with
  `/tmp` built in breaks.
- **A RAM tmpfs per session as the default.** Hard limits without root, but
  multi-GB clones in RAM, and files lost at every runtime end.
- **Rely on systemd-tmpfiles, or a better age sweeper.** Section 9.
- **A container or VM per session.** Captures everything, and cuts the session off
  from the host's tools, logins and checkouts that Cells exist to use.
- **A Unix user per session with user quotas.** Needs root per session and breaks
  file ownership between the session and the person.
- **A FUSE filesystem with a size** (`fuse2fs`). Works without root; too slow for
  `node_modules`. Not measured.
- **A root-installed systemd unit per session** (`BindPaths=`, no user namespace).
  It would keep `sudo` working. It needs root to install and new plumbing for the
  runner's pipes. Kept in reserve for "Most likely wrong" 1.

## Most likely wrong

1. **The user namespace costs too much on workstations.** `sudo` fails inside it,
   root-owned files look owned by `nobody`, setuid tools fail. If his agents use
   `sudo` on workstations, the open shape breaks them. *Experiment:* count `sudo` and
   setuid use in a week of transcripts from metal-3, then run half of one
   workstation's sessions captured for a week. If it hurts, build the reserve
   alternative.
2. **Ending processes with the runtime is too strict.** A revive, an account swap or
   a crash starts a new generation and would kill a dev server the agent still
   wants. *Experiment:* from the store, count generations per bee per day and how
   many had children alive at the change. If common, hold the namespace per bee, not
   per runtime, with a small holder process.
3. **macOS stays the hole.** If most sessions run on the Studio, most literal `/tmp`
   writes stay unowned. *Experiment:* a week of the census on the Studio: bytes in
   `/private/tmp` per session. If it is large, the Seatbelt refusal becomes the
   default there, which is a prohibition he would have to choose.

## Where this falls short of the brief

- Per harness: the stub through the real driver and `grok --version` only. No real
  Claude, Codex or Cursor turn ran inside the wrapper.
- Chromium, Playwright, gdb and strace were not run.
- Kernel limits were proven in a privileged container on a loopback file, not on a
  host install. Cache reads across project ids are unmeasured.
- `folder` and `volume` pools give the session no readable error at its limit.
- On macOS a literal `/tmp` is not captured and processes are not fenced.
- The 425,000 inodes `du` could not reach on metal-3 are unexplained. I did not
  touch metal-3.

## Side effects of the experiments

- My read-only `find` on metal-2 reset the access time of about 11,005 old
  directories in its shared `/tmp`. They had already been read that morning.
- pnpm 11 ignored the lab `HOME`, so two test installs added a few packages to his
  real pnpm store on metal-2 (about 60 MB, content-addressed). I left them.
- I pulled `debian:13` into Docker on metal-2 and removed it.
- Everything else lived in lab folders that were removed, on metal-2 and in my
  `$HIVE_SCRATCH` on this Mac. The 64 MB APFS volume and disk image were deleted.

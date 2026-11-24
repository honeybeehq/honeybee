---
status: draft
---

# Make `/tmp` inside a session the session's own scratch

Draft of 2026-11-24 for Tormod, after his question "Why are agent sessions so
extremely eager on using /tmp? We have had this issue before" (HON-34). Nothing here
is built except where a commit is named. Every claim marked **ran** has a script and
its output under `.proof/session-scratch/`; claims marked **read** come from the
code only.

Revised the same day after his decisions: sessions do not need `sudo`; processes live
as long as the session, not one runtime (section 4); a typed `/tmp` path on macOS is
accepted as an instruction; a session has no fixed cap and is warned before anything
is enforced (section 5).

## The answer

Agents use `/tmp` because it is the one path that exists and is writable on every
computer they have ever seen. A `TMPDIR` or `HIVE_SCRATCH` variable cannot compete
with a path you can type from memory, and briefs, skills and our own tests type it
too. So the fix is not to steer agents away from `/tmp`. It is to make `/tmp` belong
to someone.

On Linux, each session starts in its own mount and process namespace. Inside it,
`/tmp` **is** the session's scratch folder: a folder on disk that Honeybee owns,
measures and removes. A literal `/tmp/x` lands there. Processes the session starts
live as long as the session and no longer: when it ends, the kernel ends them all.
The agent is told nothing and forbidden nothing.

```
            what the session sees                what the computer holds
   ┌────────────────────────────────┐
   │ /tmp, /var/tmp, $TMPDIR,       │──bind──▶  <pool>/<bee>/          owner: the session
   │ $HIVE_SCRATCH                  │                                 limit: the computer's reserve
   │ /dev/shm  (RAM, capped)        │                                 gone: with the session
   │ own process ids                │──kernel─▶ all processes end with the session
   │ $HIVE_SCRATCH_HOST ───────────────────▶  the real path, for handing a file over
   │ the computer's cache ─────────────────▶  <pool>/cache/          owner: the computer
   └────────────────────────────────┘          the host's /tmp        untouched
```

macOS has no mount namespace. There the design gives owner, lifetime and limit to
everything under `$TMPDIR`, and a hard cap for the whole pool, but a literal `/tmp`
path still reaches the shared folder. That part stays an instruction on macOS, which
he accepted ("typed tmppath is ok").

## What happened, and why each guard missed

| Guard that exists | Why it did not help on trmd-metal-3 |
|---|---|
| Per-bee `TMPDIR` (`v2/daemon/src/beeTmp.ts`) | Works for tools that read it. A typed `/tmp/...` ignores it. Claude Code itself ignores it for task files: this session's `TMPDIR` is my scratch, and its sub-agent outputs still went to `/private/tmp/claude-501/`. It has its own variable, which Honeybee does not set: see "macOS". |
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
| Throwaway files, clones, worktrees, build trees | 386,334 inodes in five trees (37%) | the session | with the session's scratch | none by default; the computer's reserve |
| Things `trash`ed inside `/tmp` | 49,433 (5%) | the session | same; it is the same folder | same |
| Sockets, pipes, lock files | small | the session | with the session's processes | counted in scratch; `/dev/shm` capped in RAM |
| Lab homes for daemons under test | `/tmp/lab-hived-*`, `/tmp/bsc`, `/tmp/t1chk-hive` | the session that started them | files with the scratch; daemons with the session | same |
| Package stores, SDKs, toolchains, reference clones | 59,986 (6%), fetched again per session | the computer | least recently used, under the cache limit | cache bytes and inodes |
| Files handed to a person or another session | not countable | whoever takes them: a share, or "keep" | until the taker releases them | the share's or the pool's |
| Honeybee's and Apiary's own runs | 5,457 `hb-rh-*`, 920 test entries | the run that made them | removed by the parent of the run | none needed |
| Unknown | about 425,000 that `du` could not reach (40%) | — | — | needs a root read on metal-3 |

Three mechanisms cover these: **session scratch** (rows 1–4), **the cache** (row 5)
and **a share** (row 6). Row 7 uses session scratch too: a test run is a session.

### 2. Linux: the session namespace

Every bee, Cell or in place, every harness, gets one set of namespaces, made by
bwrap, which is already a dependency. A holder keeps them for the session's life and
each runtime enters them (section 4).

```
bwrap --dev-bind / /                      (or today's --ro-bind / / when confinement is on)
      --bind <pool>/<bee> /tmp  --bind <pool>/<bee>/.var-tmp /var/tmp
      --size <shm cap> --tmpfs /dev/shm
      --tmpfs <dataDir>/run                (other sessions' runner sockets are not visible)
      --unshare-pid --proc /proc
      [--bind-try <passthrough> ...]  --  sleep infinity          (the holder)

nsenter -U -m -p --preserve-credentials -t <holder>  --  <harness command>   (each runtime)
      with TMPDIR=/tmp HIVE_SCRATCH=/tmp HIVE_SCRATCH_HOST=<pool>/<bee> in its environment
```

- **Capture is separate from confinement.** Confinement (read-only root) stays the
  setting it is. Capture is on for everyone.
- **The scratch folder is the one that exists**, `<dataDir>/tmp/<beeId>`. Nothing
  moves at upgrade.
- **`TMPDIR` becomes `/tmp` again.** That removes the long-path problem for sockets
  that `beeTmp.ts:174` warns about. My own scratch path on this Mac was too long for
  the runner socket during these experiments.
- **The runner host stays outside the namespace**, as today, so the daemon still
  reaches its socket. Inside, the runner socket folder is an empty tmpfs: step 1
  masks it for sandboxed bees (ruling D7), and the holder does the same for every
  bee, which closes HON-36 on Linux. **Ran:** 0 entries visible inside. macOS and
  computers without capture stay open until HON-36 is fixed.
- **If user namespaces are unavailable**, the daemon's start-up probe fails
  (`bwrap: Creating new namespace failed`, **ran**), the computer reports
  `capture: env`, and sessions run as today with `TMPDIR` only. Processes are still
  fenced by the session's cgroup slice, which needs no namespace. The person sees the fact in
  Fleet and placement can prefer computers that capture.

**Ran on trmd-metal-2** (Debian 13, kernel 6.12, bwrap 0.12, no root):

| Test | Today | With the wrapper |
|---|---|---|
| Literal `/tmp/x`, `mktemp`, node `os.tmpdir()`, python `tempfile` | host `/tmp` | the bee's folder; host `/tmp` untouched; files keep the user's uid |
| Two sessions | share `/tmp` | do not see each other |
| Real HSR driver + real runner host + stub agent, wrapper per runtime, then `driver.stop()` | 2 of 3 started processes survive, owned by nobody | 0 survive, open root and confined |
| Holder per session, two runtimes entering it (`linux/16-holder.out`) | — | a process that left the group survives the runtime, is listed, is capped, and dies with the holder |
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
| `sudo`, other setuid tools | **break** inside a user namespace (**ran**) | none. Accepted: "no they dont need sudo". |
| ssh agent socket, X11 under the host's `/tmp` | invisible without help; works when bound in (**ran**) | `scratch.passthrough`, default: `/tmp/.X11-unix` and the folder of `$SSH_AUTH_SOCK` |
| `hb-rh-*` runner sockets | unaffected; the host is outside | move them out of `/tmp` anyway (section 8) |
| Apiary kernel MCP | unaffected: HTTP on 127.0.0.1, config under `~/.apiary/mcp` (**read**) | none |
| forage | unaffected: its only temp file goes through `os.tmpdir()`, so it lands in the session's scratch (**read**) | none |
| A parent and its children passing `/tmp/x` | **breaks**: each has its own `/tmp` (**ran**) | pass `$HIVE_SCRATCH_HOST/x`, or use a share |
| A lab daemon other sessions join | **breaks** if its socket is in `/tmp` | put it in a share |
| An agent telling the person "see /tmp/report.html" | the path means nothing outside | Honeybee knows the mapping; the session panel resolves it (section 7) |
| Background processes | live past a runtime stop if they left the harness's process group; end with the session (**ran**) | none. Section 4. |

**A share is explicit.** `hive share create <name>` makes `<pool>/shares/<name>`,
owned by the bee or person who made it, removed when the owner goes or releases it,
counted against the owner. Members get it at the same path. Adding it to a session
that is already running works without root: the daemon enters the session's
namespaces and binds it (**ran**).

### 4. Lifetime and processes

Decided by Tormod on 24 Nov: processes "should probably end with the session … they
might want it running past their own pause." So files **and** processes live as long
as the session (the bee), not as long as one runtime.

```
runtime 1 ─ ends ─▶ runtime 2 ─ ends ─▶ … ─▶ a person stops it, archive, delete, idle rule
 harness      │      harness      │                          │
 its group ───┘ killed, as today  ┘                          │
 processes that left the group (a dev server) ── live on ────┤ all killed by the kernel
 scratch files ─────────────────── kept ─────────────────────┴─▶ trash 3 days ─▶ gone
```

**The holder.** The namespaces can no longer belong to a runtime, so each session
gets a holder that owns them:

- **What it is.** `bwrap` with the mounts of section 2, a pid namespace, and
  `sleep infinity` inside. It contains no Honeybee code. It is started detached,
  without `--die-with-parent`, in a cgroup slice `hive-bee-<id>.slice`.
- **How a runtime uses it.** The runner host stays outside, as today. Its command
  becomes `nsenter -U -m -p --preserve-credentials -t <holder> -- <harness>`, in a
  scope inside the slice. The harness keeps the user's uid, sees the same `/tmp`
  and `/dev/shm` as the last runtime, and sees the processes that runtime left.
  The daemon sets `TMPDIR=/tmp` and the other variables in the runtime's own
  environment; a variable set on the holder does not reach a process that enters.
- **What a runtime stop does.** Exactly what it does today: TERM, then KILL, to the
  runner's process group. The harness and everything in its group end. A process
  that left the group, which is what harness background tasks do (the 51 on metal-3
  each had their own session), lives on in the holder.
- **What ends the holder, and with it every process:** a person's stop
  (`stopped_by_user`), archive, delete, a move to another computer, and Cell
  eviction or the idle rule. The daemon kills the namespace's first process by
  exact pid and birth identity; the kernel then kills the rest. The slice's
  `cgroup.kill` is the second fence. A runtime that ends by itself, crashes, or is
  stopped by the system (revive, account swap) does not end the holder.
- **What it costs idle:** 3 processes and 5.4 MiB resident (**ran**). A holder with
  nothing in it but itself is ended when its runtime stops, so a session with no
  background processes costs nothing while stopped. The next runtime makes a new
  one in 15 ms.
- **Daemon restart.** The holder does not depend on the daemon (**ran**: its starter
  exited and it was adopted by pid 1). The daemon records the holder's pid and
  birth identity with the session, and at boot re-adopts it by that exact identity,
  the same rule as for runner hosts. If the identity does not match, the session
  has no holder and the next runtime makes one. Lifecycle truth stays in SQLite;
  the holder is evidence.
- **Upgrade.** `hive deploy` does not touch holders; there is nothing of Honeybee's
  in them to replace. A changed mount list applies to holders made afterwards; a
  bind can be added to a live one (section 3). A session that was running before
  step 2 gets its holder at its next runtime.
- **Machine restart.** Holders and processes are gone; files stay. Nothing to
  reconcile beyond `machine_restart`.

**Ran on trmd-metal-2** (`linux/16-holder.out`): runtime 1 started three processes;
after its group was stopped, the one that had left the group was alive; runtime 2
entered and saw runtime 1's `/tmp` file, its `/dev/shm` file and that process; from
outside, the session's processes were listed by pid namespace without entering;
with the slice capped at 30, the 25th extra process failed with `Resource
temporarily unavailable`; killing the namespace's first process left 0 alive and
the scratch files in place.

**How a person sees and ends leftover processes.**

- `hive ps <bee>` and the session panel list them: command, age, memory, CPU,
  listening ports, and which runtime started them. Read from the slice and the pid
  namespace; no entering.
- "End" on one process, "End all" on the session (ends the holder). Stopping a
  session by hand ends all of them, so a person's stop means stopped.
- Fleet shows, per computer, how many stopped sessions still have processes and
  what they hold in memory.

**What bounds them.**

- `session.processes.max`, default 4,096, enforced by the kernel on the slice. The
  session sees an ordinary "Resource temporarily unavailable".
- No memory cap by default; memory is reported. A cap is a setting on the slice.
- A stopped session's processes follow the idle rule that exists for Cells
  (`idleDays`, 7): when the session has had no runtime for that long, its holder is
  ended, then its Cell and scratch are evicted as today. Retention must treat a
  live holder as "in use" until then (`cellInUse`, `cellRetention.ts:118`).
- `session.processes.end`: `session` (default) or `runtime`, which ends the holder
  at every runtime end.

**Files.** Stop and revive keep them. Archive moves the scratch to the pool's trash
for `scratch.keepAfterArchive` (3 days); unarchive within that time restores it.
Delete removes it at once. `hive scratch keep <bee> [path]` moves it to
`<pool>/kept/`, owned by the person, never removed automatically, shown with its
size.

**Without user namespaces** there is no holder. The slice alone plays its part for
processes: runtimes start in scopes inside it, a process that leaves the runner's
group stays in the slice, and the slice is killed when the session ends.

**macOS** has neither. A runtime stop kills the group, as today, and a process that
left it lives on, which happens to be the rule he chose. At the session's end the
census of section 10 ends what it can find.

**Why 51 processes survived 16 days (cause in the code).** `stop` calls
`signalGroup` (`driver-hsr/src/driver.ts:1687`), which is `process.kill(-hostPid)`.
The runner host is spawned detached (`:573`) and the agent joins its group
(`runner-host.ts:214`). The harness started `pnpm play:harness --serve` in new
sessions, each with its own group, so the signal never reached them. Nothing else
looks: no pid namespace, no cgroup, no census, and eviction never signals. Surviving
a pause is now intended. What was wrong is that nothing owned them afterwards: no
one could see them, nothing bounded them, and nothing ended them with the session.
The holder is that owner.

### 5. Limits: warn first, enforce only at the computer's floor

Decided by Tormod on 24 Nov: "wont this potentially unnecessarily inhibit agents?
Shouldnt we warn before we enforce? Say the disk has 1 TB available, but the agent
only gets, say 10 GB?" The earlier draft gave every session 20 GiB. That is
withdrawn.

**1. A session has no cap by default.** It may use what the computer has.

**2. What is protected is the computer's reserve:** bytes and inodes that scratch as
a whole may never take, so the daemon, the system and a new start always have room.
Default: the retention floor that exists, 5% or 20 GiB whichever is larger, and 5%
of inodes or 200,000. Under it sits step 1's start floor (512 MiB, 20,000 inodes).

**3. A warning comes long before that, and it enforces nothing.**

- *When.* Let "room" be what scratch may still take: free space minus the reserve.
  A session is warned when its own scratch is a quarter of its use plus the room
  (`scratch.warn.share`, 0.25), in bytes or in inodes. With 1 TB free that is about
  245 GB. With 60 GB free it is about 10 GB. The largest session is also warned
  when the room falls under twice the reserve, whatever its share.
- *What the session gets.* One ordinary message, once per crossing: "Your scratch
  (`/tmp`) holds 212 GB in 1.4 million files. This computer has 90 GB left before
  it stops starting sessions. Largest: `/tmp/a` 120 GB, `/tmp/b` 60 GB. Remove what
  you no longer need." The list comes from one walk of that session's folder, made
  only then.
- *What the person sees.* The session shows its size and the warning. Fleet shows
  the computer's room and what trash, cache and idle sessions would give back.
- Nothing is paused, refused or flagged. `resource_blocked` is for enforcement only.

**4. Enforcement happens at the reserve, in the order a person would choose:**

1. empty the pool's trash;
2. evict the cache, least recently used first;
3. evict idle stopped sessions under the retention rule (its pressure pass exists);
4. only then the session that is growing. Where the pool is its own filesystem it
   gets an ordinary `No space left on device` from the kernel and nothing else
   happens to it. Where it is not, that one session is paused and flagged
   `resource_blocked` ("scratch: this computer is at its reserve") until a person
   makes room or ends it.

A session that is not growing is never paused because another grew. New starts are
refused under the start floor, as in step 1.

**5. A hard cap per session is a setting**, off by default:
`scratch.session.maxBytes` and `.maxInodes`, for a shared satellite or a small host.
It is kernel-enforced where the pool can do it (a `quota` pool, or `memory`
backing); elsewhere it is sampled and the session is paused at the cap.

**Pool kinds, after this change.**

| Pool kind | Needs | The computer's reserve | The growing session at the reserve | Per-session cap, if turned on |
|---|---|---|---|---|
| `folder` (default) | nothing | sampled, then the order above | paused; no error it can read | sampled |
| `volume` (macOS, recommended) | nothing | kernel: an APFS volume whose quota is the disk minus the reserve; it takes no space until used | `No space left on device` | sampled |
| `quota` (Linux, optional) | root once | kernel: the pool is its own filesystem | `No space left on device`; `df /tmp` shows the truth | kernel, bytes and inodes |
| `memory` (setting) | nothing | RAM, sum of caps | `No space left on device` | kernel |

**What this does to the case for the root-installed pool on Linux.** Its per-session
limits were half of the argument and are now an option nobody needs by default.
What remains:

- the reserve is a wall the kernel keeps, not a level a sampler watches: a fast
  writer cannot pass it between two samples and take the daemon's store with it;
- the growing session gets `No space left on device` and can act, where `folder`
  can only pause it;
- the pool has its own inode table, sized when it is made;
- per-session use can be read without walking trees (project ids, **ran** for the
  limit; reading use this way with no limit set is not yet shown).

Its cost changed too. A separate filesystem has a fixed size, which is the owner's
objection moved up one level: a 200 GB pool on a disk with 1 TB free. A sparse image
avoids reserving the space but breaks badly if the disk under it fills. So the pool
has to be a real partition, a logical volume, or a fully allocated file.

**Recommendation.** Do not make it part of the default path, and do not ask for
root on any computer for it now. Build steps 1 to 4 on the `folder` pool, with the
warning. Use the `volume` pool on Macs, where it costs no root and reserves nothing.
On Linux, offer the pool as an install option for computers that only run sessions
(the three metal hosts, satellites), sized to most of the disk, and decide after a
month of step 3's facts: if no computer reached its reserve, the pool is not worth
root. If one did and a session was paused, it is.

**Ran** for the kernel half (`linux/12-quota.out`, a privileged container on
metal-2): an XFS pool with project quotas gave a session `No space left on device`
at its byte and inode limits, the session could not change its own project, a
second session was untouched, a session with a raised limit could not pass the
pool's size, and the filesystem outside stayed writable. The warning levels and the
order of reclaim are design, not run.

**Where scratch lives.** On disk, not in RAM. The clone that held 137,679 inodes was
2.4 GB, and a tmpfs would hold it in memory. `/dev/shm` stays RAM, private and
capped at 1 GiB, because it is RAM by definition.

**The daemon cannot be starved.** Its store and runner sockets are outside the pool.
With `volume` or `quota`, scratch cannot take that space at all. With `folder`, the
daemon keeps a 1 GiB ballast file beside its store, refuses starts under the start
floor, and pauses only the session that is growing.

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
its share of the room and whether it has been warned, a cap if one is set, its
processes (count, how many outlived their runtime, memory, the oldest), `capture:
mount | env`, the real path, kept bytes, what archive would reclaim.

**Per computer** (in `NodeCapacity`, for Fleet and placement): pool kind; pool bytes
and inodes total and free; the reserve and the room left above it; reclaimable bytes
and inodes by kind (trash, cache, idle sessions); cache size; stopped sessions that
still hold processes;
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
| `scratch.session.maxBytes`, `.maxInodes` | none |
| `scratch.warn.share` | 0.25 of the room |
| `scratch.reserve.bytes`, `.inodes` | the retention floor that exists (5% or 20 GiB); 5% or 200,000 inodes |
| `scratch.shm.maxBytes` | 1 GiB |
| `scratch.keepAfterArchive` | 3 days |
| `scratch.passthrough` | X11 folder, ssh agent folder |
| `session.processes.max`, `session.processes.end` | 4,096; `session` |
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
| Seatbelt profile | **refuses** it: `Operation not permitted`. It cannot redirect (**ran**) | none | a setting, off. Decided: no refusal by default. |
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

**The harness's own files (added after review).** A harness writes temp and task
files itself, before any agent types a path. Each has its own knobs, and Honeybee
can set them at spawn. On macOS this moves the harness's own share of `/tmp` into
the bee's scratch with no mount.

| Harness | Honors `TMPDIR` for its own temp files | Own knobs | Honeybee should set | Source |
|---|---|---|---|---|
| claude | **no on macOS**: the base is `CLAUDE_CODE_TMPDIR`, else the literal `/tmp` | `CLAUDE_CODE_TMPDIR` | `CLAUDE_CODE_TMPDIR=<scratch>` | binary 2.1.319 read; **ran** |
| codex | yes | `CODEX_HOME`; `sandbox_workspace_write.exclude_slash_tmp`, `exclude_tmpdir_env_var`, `writable_roots` | `TMPDIR` (set today). Never put `CODEX_HOME` under `TMPDIR`: release builds refuse to start helpers. | source read |
| cursor-agent | yes; falls back to `/tmp/.cursor` when a path passes 84 characters | `CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`; `disableTmpWrite` in its sandbox file | `TMPDIR`, and keep the scratch path short | docs and bundle strings |
| grok | yes (`grok-goal-<id>` under the temp dir) | `GROK_HOME`, `GROK_SANDBOX` | `TMPDIR` | source read |
| opencode | yes (`<tmp>/opencode`) | the four `XDG_*` homes, `OPENCODE_CONFIG_DIR` | `TMPDIR`; `XDG_CACHE_HOME` and `XDG_STATE_HOME` are not set today | source read |
| kimi | yes; one hard-coded `/tmp/kimi-startup-trace.log` for a debug trace | `KIMI_CODE_HOME`, `KIMI_CODE_CACHE_DIR` | `TMPDIR` | docs and binary strings |
| agy | likely (Go) | none; only `HOME` moves its data | `TMPDIR` | docs; closed source |
| muse | likely (`${TMPDIR:-/tmp}` in its launcher) | `XDG_*`, `MUSE_PROJECTS_HOME` | `TMPDIR` | binary strings; closed source |

Claude Code is the one that needs a change, and it is the most used. In its binary:
`function Xf(){let e=i.CLAUDE_CODE_TMPDIR;if(e)return e;return"/tmp"}`, and on macOS
it skips `TMPDIR` on purpose. Its sandboxed commands get
`TMPDIR=${CLAUDE_CODE_TMPDIR||CLAUDE_TMPDIR||"/tmp/claude"}`.

**Ran on this Mac** (`mac/06-claude-tmpdir.sh`: lab home and config folder, a dummy
key, a dead local endpoint; the run ended in "Connection refused", so no login was
read and no model was called):

- `TMPDIR=<scratch>` alone, which is what Honeybee sets today: nothing of Claude's
  appears in the scratch. Its sockets are in the shared `/tmp/cc-socks` (32 there
  from his sessions) and its files under `/tmp/claude-501`.
- With `CLAUDE_CODE_TMPDIR=<scratch>`: `<scratch>/claude-501/` and
  `<scratch>/cc-socks/<pid>.sock` appear at start, before any model call.

So one line in `beeTmpEnv` (`daemon.ts:2020`) moves Claude Code's task outputs,
shell snapshots and sockets into the bee's scratch on every platform. Two cautions.
The socket is `<scratch>/cc-socks/<pid>.sock`, 84 characters under
`~/.hive/v2/tmp/<uuid>` on this Mac, inside the 104 limit; a longer data folder
needs the short-path fallback `beeTmp.ts:174` already measures. And this moves the
harness's files, not a path the agent types. That part is still an instruction on
macOS.

## A path to it

Each step helps alone. "Red first" is the test that fails today.

| # | Step | Needs | Red first |
|---|---|---|---|
| 1 | **Never a black hole.** Measure bytes and inodes of the pool and of the socket folder; publish them; refuse any start under a floor with `resource_blocked`, not five `boot_exit`s. Move runner sockets to `<dataDir>/run`, removed by the daemon; sweep `hb-rh-*`. Apiary: skip blocked computers and debit a computer after failed starts. | new `NodeCapacity` fields; Apiary placement | a lab daemon whose socket folder is a 1,000-inode tmpfs, filled: today five `boot_exit`s and it still wins placement |
| 2 | **Capture and the session's processes on Linux**, for every bee: the holder, runtimes entering it, the slice with the process cap, `hive ps`. See "What step 2 needs". | holder identity stored with the session; health reports `capture` | `.proof/session-scratch/proto/run.ts` (a file in host `/tmp`, survivors nobody owns) and `linux/16-holder.sh` as a daemon test |
| 3 | **Facts, the warning, and reclaim at the reserve** in the order of section 5; the panel and Fleet show size, room and what would be reclaimed. | `ViewResult.scratch`; one new `resource_blocked` reason; Apiary UI | a session that takes half the free disk is told nothing today |
| 4 | **Lifetime:** trash with a grace, keep, the idle rule for bees without a Cell, `hive scratch orphans` for what is already in shared `/tmp`. | store: kept and trash records | archive deletes scratch at once today |
| 5 | **The cache:** environment for package stores, mirrors, `hive cache fetch`. | cache accounting | two sessions fetch the same SDK twice |
| 6 | **A kernel-kept reserve:** the APFS pool volume on macOS (no root). On Linux, `hive scratch pool install` as an option, decided after a month of step 3's facts. | root once, Linux only, optional | a session fills the data disk and the store fails to write |
| 7 | **Our own runs** inside the wrapper. | both repositories | a killed test run leaves `hb-v2-daemon-*` |
| 8 | **macOS census** at stop; the scratch sentence in the placement text. | none | `mac/03-processes.sh`: 1 survivor |

`CLAUDE_CODE_TMPDIR` is set on main (1eea4627). Setting `HIVE_SCRATCH` for bees
without a Cell is a few lines more. Step 1 is specified in Appendix A and is being
built.

**What step 2 needs.**

- A holder per session: started before the first runtime, its pid and birth
  identity stored with the session, re-adopted at boot by exact identity, ended on
  a person's stop, archive, delete, move and eviction. An empty holder is ended
  when its runtime stops.
- The spawn path wraps the harness in `nsenter` into the holder, for Cell and
  in-place bees. `util-linux` `nsenter` becomes a dependency beside bwrap; the
  start-up probe checks both.
- `beeTmpEnv` sets `TMPDIR`, `HIVE_SCRATCH` and `CLAUDE_CODE_TMPDIR` to `/tmp` and
  `HIVE_SCRATCH_HOST` to the real folder when the session is captured.
- The holder's mounts: the scratch binds, `/dev/shm`, the masked runner socket
  folder, the passthrough list, and the ssh config view from `sandbox.ts`. For a
  confined bee, today's `bwrapArgs` with its two tmpfs mounts replaced.
- A cgroup slice per session with `pids.max`; runtimes in scopes inside it.
  Without a user systemd, the namespace alone.
- Retention treats a live holder as in use, and ends it under the idle rule.
- `hive ps <bee>`, the per-session process facts, and the `capture` fact.
- Red first: the daemon test of `16-holder.sh` (a process that left the group
  survives a system stop and a revive, is listed, and is gone after archive), and
  a restart test (the holder is re-adopted with the same pid).

Step 1 would have turned today's outage into one blocked computer that placement
avoided. Step 2 would have kept `/tmp` from filling. I did not read metal-3's logs,
so "the sessions died because nothing could be created in `/tmp`" is likely, not
shown.

**Sessions running at upgrade** keep the host's `/tmp` until their next runtime
generation, which makes their holder. Nothing is restarted for this. The per-session `capture` fact shows which
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
  multi-GB clones in RAM.
- **A fixed cap per session by default.** It stops an agent at 20 GiB on a disk
  with 1 TB free. Withdrawn; section 5.
- **Namespaces per runtime.** Simpler, and every process dies at every stop, revive
  and account swap. Reversed; section 4.
- **Rely on systemd-tmpfiles, or a better age sweeper.** Section 9.
- **A container or VM per session.** Captures everything, and cuts the session off
  from the host's tools, logins and checkouts that Cells exist to use.
- **A Unix user per session with user quotas.** Needs root per session and breaks
  file ownership between the session and the person.
- **A FUSE filesystem with a size** (`fuse2fs`). Works without root; too slow for
  `node_modules`. Not measured.
- **A root-installed systemd unit per session** (`BindPaths=`, no user namespace).
  It would keep `sudo` working. It needs root to install and new plumbing for the
  runner's pipes. Not needed: sessions do not need `sudo`.

## Most likely wrong

The first draft's three were answered by his decisions. The three now:

1. **Entering the holder breaks a real harness.** Only shell commands and a stub
   agent have run through `nsenter`. A harness with its own sandbox starts nested
   namespaces from a process that entered, not one that was born inside.
   *Experiment:* one real Claude, Codex and Cursor turn each through the holder on
   a lab host, with a tool call, a background task and the harness's own sandbox on.
2. **"Left the process group" is the wrong line for what survives a pause.** Claude
   Code's background tasks do leave it. If another harness keeps its background
   work in its own group, a system stop still kills it; if one puts tool helpers in
   their own session, they pile up in the holder. *Experiment:* per harness, start a
   background task and a tool helper and read their group and session ids.
3. **Without a cap, the sampler is too slow on a `folder` pool.** A writer at 2 GB/s
   passes from the warning to the start floor in seconds, between two samples.
   *Experiment:* after step 3, fill a lab disk at full speed and see whether the
   daemon stays up and which session is paused. If it does not hold, the reserve
   needs the kernel (section 5's pool) on that kind of computer.

## Where this falls short of the brief

- Per harness: the stub through the real driver and `grok --version` only. No real
  Claude, Codex or Cursor turn ran inside the wrapper.
- Chromium, Playwright, gdb and strace were not run.
- Kernel limits were proven in a privileged container on a loopback file, not on a
  host install. Cache reads across project ids are unmeasured.
- On a `folder` pool the growing session is paused at the reserve; it gets no error
  it can read.
- The holder ran with shell commands only; no real harness has entered one.
- On macOS a literal `/tmp` is not captured and processes are not fenced. Accepted.
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

## Appendix A. Step 1 as a buildable spec: never a black hole

**Status.** This step is being built from this appendix by another bee. Nine points
came back and were ruled. The rulings stand; the text below has been brought in line
with them.

| Ruling | What it settles |
|---|---|
| D1 | A held start uses the claim filter (`blockedRuntimeStartBeeIds`). No attempt is counted. |
| D2 | The daemon itself sets and clears `resource_blocked` with detail `start_floor`, and clears it at boot when no start is pending. The detail is stored as the `start_floor` prefix plus compact JSON `{role, path, metric, free, floor}`; words are rendered from it. Snapshots gain optional `views[].flagDetails`, and `flag.set` rows carry `payload.startFloor`. |
| D3 | R4 is three runs on one filled tmpfs: today's code (five `boot_exit`), defaults (refused, `start_floor`), and `node.startFloor.enabled=false` (boots, facts published, nothing refused). |
| D4 | The `cells` folder is checked only for Cell starts. Admission reports `newSessions` and `newCells` separately. |
| D5 | The boot sweep protects the socket paths of runtimes the driver holds after adoption and any socket that accepts a connection, with a 60 s age guard on empty folders. |
| D6 | The driver's fallback when no `socketDir` is passed is `<runners parent>/run`, not `tmpdir()`. |
| D7 | The runner socket folder is masked from sandboxed bees with an empty tmpfs. Linux only. |
| D8 | A device no bigger than the bytes floor skips the bytes floor, logs once, and still checks inodes. `floorBytes` is `number | null`. |
| D9 | A refused start's reason is in the RPC error's `details`, not `data`. |

Also ruled: while a floor is tripped the sampler runs every 5 s; the socket move and
the mask are Linux only in step 1. macOS is unchanged there (HON-36).

None of these conflicts with the holder of section 4. Step 2's holder applies D7's
mask to every bee on Linux, not only sandboxed ones.

Written against main at c7188458. Goal: a computer that cannot start a session says
so as a fact, refuses the start with a typed reason, and is not chosen. No session
is started only to die.

### A1. The start set

The folders a runtime needs in order to boot. Each is read with one `statfs`, and
folders on the same device are reported once.

| Role | Path | Why a start needs it |
|---|---|---|
| `data` | `cfg.dataDir` | store, runner config and status, session logs |
| `sockets` | the runner socket folder (A4) | the runner host makes a folder and a socket there |
| `scratch` | the bee tmp root (`resolveBeeTmpPolicy`), when on | per-bee `TMPDIR` |
| `hostTmp` | `/tmp` on Linux; `/private/tmp` on macOS | harnesses and agents write here until capture (step 2) |
| `cells` | the Cells root | already measured for `disk_floor`; checked only for Cell starts (D4) |

New module `v2/daemon/src/startFloor.ts`, independent of `CellRetention` so it also
runs on a node with retention off. It samples on the existing 60 s disk check, every
5 s while a floor is tripped,
(`DEFAULT_DISK_CHECK_MS`, `cellRetention.ts:208`) and once more, synchronously,
inside admission (A3); a `statfs` is one system call per folder.

Node's `statfsSync` already returns `files` and `ffree`. `defaultStatfs`
(`cellRetention.ts:225`) keeps bytes only today. A filesystem that reports
`files === 0` has no inode table to exhaust: publish `totalInodes: null,
freeInodes: null` and skip the inode test.

### A2. Facts: `NodeCapacity` grows, `schema` stays 1

All additions are optional fields, the way `transcriptObjects?` was added
(`v2/core/src/types.ts:1357`).

```ts
export type StartVolumeRole = "data" | "sockets" | "scratch" | "hostTmp" | "cells";
export interface NodeVolumeFacts {
  roles: StartVolumeRole[];          // every role that lives on this device
  path: string;                      // the first role's path
  totalBytes: number;  freeBytes: number;
  totalInodes: number | null;  freeInodes: number | null;
  floorBytes: number | null;  floorInodes: number | null;   // null bytes floor: the device is no bigger than the floor (D8)
  below: "bytes" | "inodes" | null;  // which floor it is under, if any
}
export interface NodeCapacity {
  // ...existing fields unchanged...
  volumes?: NodeVolumeFacts[];
  resourceBlocked: {
    blocked: boolean; since: number | null;
    reason: "start_floor" | "disk_floor" | "wip_unconfirmed" | null;   // "start_floor" is new and wins
    detail?: { role: StartVolumeRole; path: string; metric: "bytes" | "inodes"; free: number; floor: number } | null;
  };
  admission: { newCells: "accept" | "refuse"; enforce: boolean; newSessions?: "accept" | "refuse" };
}
```

- `cells.freeInodes?: number | null` is also added beside `cells.freeBytes`, so a
  reader that only knows `cells` gets inodes without learning `volumes`.
- `admission.newSessions` is `refuse` exactly when `reason === "start_floor"`. It
  ignores `enforce`: `disk_floor` is advice on a workstation (`budgetEnforce:
  false`, `config.ts:710`), but under the start floor a start cannot work on any
  kind of node. `newCells` is reported separately: it is `refuse` when the `cells`
  device is under the start floor or the `disk_floor` refuses (D4).
- Carried where capacity already rides: `deployInfo`, `health`, the snapshot, and
  the `node.capacity` audit event. `announceCapacity` (`cellRetention.ts:604`) fires
  on a change of `blocked` or `newCells`; add `reason` and `newSessions` to that
  comparison so entering and leaving `start_floor` each write one event.
- New daemon capability `node.capacity.volumes.v1` in `DAEMON_CAPABILITIES`
  (`protocol.ts:102`).
- No store change: no table, no column, `SCHEMA_VERSION` and `MIN_READER_SCHEMA`
  stay. The facts are sampled, never persisted.

**Versions meeting each other.** Read from Apiary's `capacityFacts`
(`services/kernel/src/fleet/facts.ts:37`) and `verdictOf`
(`workspaces.placement.ts:190`):

| Pair | What happens |
|---|---|
| New Honeybee, old Apiary | Old Apiary reads keys by name and ignores `volumes`, `detail`, `newSessions`. It sees `blocked: true, reason: "start_floor"`; the reason is not `disk_floor`, so the warn-only exception does not apply and it refuses the computer with "blocked: start_floor". **The black hole closes with no Apiary change.** |
| Old Honeybee, new Apiary | The fields are absent. Apiary must read absent as "unknown", never as zero free, and place as it does today. The capability string tells it which it has. |
| New both | Apiary shows the volume, the metric and the numbers, and its own debit covers computers running old Honeybee. |

### A3. Floors and admission

Defaults, in a new config block `node.startFloor`, read in `config.ts` beside
`cellRetentionOf` and settable through `hive config` (widen the key check at
`cli/src/main.ts:3741` and add a `START_FLOOR_CONFIG_KEYS` list beside
`RETENTION_CONFIG_KEYS`, `config.ts:1056`):

| Key | Default | Meaning |
|---|---|---|
| `node.startFloor.minFreeBytes` | 536,870,912 (512 MiB) | per start-set device |
| `node.startFloor.minFreeInodes` | 20,000 | per start-set device that reports inodes |
| `node.startFloor.enabled` | `true` | `false` publishes the facts and refuses nothing |

The numbers are small on purpose: this floor means "a session cannot boot here",
not "this disk is getting full". The `disk_floor` (5% and 20 GiB) keeps that job.
On metal-3 today `hostTmp` had 0 free inodes; the floor would have tripped at
20,000.

Admission, replacing `assertCellAdmission` (`daemon.ts:4342`) with
`assertStartAdmission(verb, substrate)`, called for **every** substrate at `spawn`
(`daemon.ts:3932`) and `bee.import` (`:6747`):

- Under the start floor: `RpcError("resource_blocked", message, details)`. The code
  exists. Message: `spawn: this computer cannot start sessions: /tmp has 0 free
  inodes (floor 20000)`. Details (D9): `{ reason: "start_floor", role, path, metric, free,
  floor }`.
- Otherwise, for Cells only, the existing `disk_floor` check and message, with
  details `{ reason: "disk_floor" }` added.

A start for a bee that already exists (a wake after `send`, a revive) must not be
refused at the RPC: mail is accepted whatever the process health. In the command
loop, before `driver.start`, when the start floor is tripped:

- hold the start with the claim filter (`blockedRuntimeStartBeeIds`), so no attempt
  is counted (D1), and
- the daemon sets the bee's `resource_blocked` flag with detail `start_floor` plus
  compact JSON `{role, path, metric, free, floor}`; the words a person reads are
  rendered from that. The `flag.set` row carries `payload.startFloor`, and
  snapshots carry it in optional `views[].flagDetails` (D2).

At boot the daemon clears the flag when no start is pending. When the floor clears, clear the flag and release the command. The spawn-failure
budget and `boot_exit` are untouched: the runtime never started, so there is no
exit to count.

### A4. Runner sockets: what HON-35 did and what is left

HON-35 (a03ab4f9) removes a runner's `hb-rh-<digest>/` folder when its host exits:
`removeRunnerSocket` is called by both host exit paths, by the driver's `onExit`,
and by `disposeAll`. That stops the growth. Left to do:

1. **The folder is still the shared temp folder.** `daemon.ts:914` takes `tmpdir()`
   and `placeDaemonSockets` (`daemon/src/socketPath.ts:35`) keeps it whenever the
   path fits. A full `/tmp` therefore still stops every start. New default, on Linux only in step 1:
   `<dataDir>/run`, mode 0700, when `join(dataDir, "run", RUNNER_SOCKET_SAMPLE)`
   fits the socket limit; else the `persistentSocketDir` fallback that exists.
   `~/.hive/v2/run/hb-rh-<16>/stdin.sock` is 52 bytes on Linux. Ruling D7: a
   sandboxed bee can write under `~/.hive`, so on Linux the sandbox mounts an empty
   tmpfs over this folder. On macOS Seatbelt does not stop a socket connect, so any
   bee can still reach any runner socket there (HON-36).
2. **Survivors must still reconnect.** `adopt` computes the socket from the
   current folder (`runnerPaths`, `driver.ts:347`, used at `:1371`), so changing
   the default would strand every runtime that lives through the upgrade. The
   runner's own config file `<runners>/<bee>.<generation>.json` holds the
   `socketPath` it was started with (the driver already reads that file at
   `:1026`). `adopt` and `removeRunnerSocket` callers must use the recorded path
   when the file exists, and compute only for new generations.
3. **A boot sweep.** A host that dies while no daemon is watching still leaves its
   folder. At boot, after adoption: in the current socket folder **and** in the
   inherited `tmpdir()`, remove every `hb-rh-*` entry owned by this user that no
   live runner config names. Empty folders with `rmdir`, stale sockets with
   `unlink`, nothing else, never a socket path of a runtime the driver holds after
   adoption, never an empty folder younger than 60 s (D5), bounded to 20,000
   entries per boot and logged as
   `runner.sockets.swept n=`. This is also what clears the 5,457 on metal-3 and the
   8,027 on metal-2. Several daemons can share a temp folder (lab daemons), so
   never remove a folder whose socket accepts a connection.
4. **Tests and the driver's own fallback.** With no `socketDir` passed, the driver
   uses `<runners parent>/run`, not `tmpdir()` (D6). About 50 `new RuntimeHost(`
   sites pass none. Also give
   `v2/driver-hsr/tests/helpers.ts` a default inside the test's own folder.

### A5. Red first

| # | Test that fails today | Passes when |
|---|---|---|
| R1 | Unit, fake `statfs` returning `ffree: 0` for `hostTmp`: `capacity.volumes` is undefined | the volume shows `below: "inodes"`, `reason: "start_floor"`, `newSessions: "refuse"` |
| R2 | Daemon test, same fake: `spawn` of an in-place bee succeeds and the runtime dies | `spawn` throws `resource_blocked` with `details.reason === "start_floor"`; no runtime row is created |
| R3 | Daemon test: `send` to a stopped bee under the floor burns boot attempts to `spawn_failed` | mail is accepted, the bee carries `resource_blocked` (detail `start_floor`), `spawnFailures` stays 0; lifting the floor starts it and clears the flag |
| R4 | Linux lab, real, three runs on one filled tmpfs with `nr_inodes=64` as the daemon's inherited `TMPDIR` (the mount recipe is `.proof/session-scratch/linux/03-limits.sh`, no root): today's code gives five `boot_exit`s | with defaults the start is refused with `start_floor`; with `node.startFloor.enabled=false` the bee boots, the facts are published and nothing is refused (D3) |
| R5 | Daemon restart test: start a runtime with the socket folder set to A, restart the daemon with the default set to B | the runtime is adopted with the same pid and generation, and mail is delivered |
| R6 | Boot test: plant 3 empty `hb-rh-*` folders, 1 stale socket, and 1 live runner | after boot only the live one remains; an empty folder younger than 60 s is kept |
| R7 | Type test on `capacityOf`: `schema` is still `1` and a reader that knows only today's fields gets the same values | unchanged |

### A6. What Honeybee publishes for Apiary's half

The bee building Apiary's half needs these names:

- **Free inodes beside free bytes:** `capacity.cells.freeInodes`, and per device
  `capacity.volumes[].{roles, path, freeBytes, totalBytes, freeInodes, totalInodes,
  floorBytes, floorInodes, below}`. Absent means an older Honeybee; `null` inodes
  means the filesystem has no inode table.
- **The computer cannot start sessions:** `capacity.resourceBlocked.{blocked: true,
  reason: "start_floor", detail}` and `capacity.admission.newSessions: "refuse"` (and `newCells`, reported separately),
  with one `node.capacity` audit event on entry and one on exit.
- **Which Honeybee it is talking to:** capability `node.capacity.volumes.v1` in the
  hello.
- **A start that was refused:** RPC error code `resource_blocked` with
  `details.reason: "start_floor" | "disk_floor"`. Move the session without waiting.
- **A session that cannot start, said by the session:** the bee's `resource_blocked`
  flag with detail `start_floor` and its JSON, in `BeeView.flags` and
  `views[].flagDetails`.
- **Failed starts, for the debit:** these exist already. The audit event
  `bee.spawn_failures` carries `{ beeId, spawnFailures, reason }` with reason
  `boot_exit` or `boot_exit_not_retryable` (`core/src/store.ts:3699`), and the
  bee's `spawn_failed` flag is set when the budget is spent. Step 1 adds nothing
  here; the debit is still needed for failures the floor cannot see.

## Appendix B. Withdrawn

The two read-only checks written here (use of `sudo` on workstations; runtime
changes with children alive) are not needed: he answered both questions himself.
The commands are in this file's history at fd5446cd.

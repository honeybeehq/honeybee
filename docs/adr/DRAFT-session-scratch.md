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
| 2 | **Capture and the process fence on Linux**, for every bee. | wrapper in the spawn path; health reports `capture` | `.proof/session-scratch/proto/run.ts`: today 2 survivors and a file in host `/tmp` |
| 3 | **Facts and sampled limits** per session; the panel and Fleet show them. | `ViewResult.scratch`; new `resource_blocked` reasons; Apiary UI | a session writing 2× its limit raises no flag today |
| 4 | **Lifetime:** trash with a grace, keep, the idle rule for bees without a Cell, `hive scratch orphans` for what is already in shared `/tmp`. | store: kept and trash records | archive deletes scratch at once today |
| 5 | **The cache:** environment for package stores, mirrors, `hive cache fetch`. | cache accounting | two sessions fetch the same SDK twice |
| 6 | **Kernel limits:** `hive scratch pool install` for an XFS pool on Linux; the APFS pool volume on macOS. | root once on Linux | a session fills the data disk and the store fails to write |
| 7 | **Our own runs** inside the wrapper. | both repositories | a killed test run leaves `hb-v2-daemon-*` |
| 8 | **macOS census** at stop; the scratch sentence in the placement text. | none | `mac/03-processes.sh`: 1 survivor |

Two things can ship before any of these, each a few lines: set
`CLAUDE_CODE_TMPDIR` to the bee's scratch (section "macOS"), and set `HIVE_SCRATCH`
for bees without a Cell too. Step 1 is specified in Appendix A.

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

## Appendix A. Step 1 as a buildable spec: never a black hole

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
| `cells` | the Cells root | already measured for `disk_floor` |

New module `v2/daemon/src/startFloor.ts`, independent of `CellRetention` so it also
runs on a node with retention off. It samples on the existing 60 s disk check
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
  floorBytes: number;  floorInodes: number | null;
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
  kind of node. `newCells` is also `refuse` then.
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

- Under the start floor: `RpcError("resource_blocked", message, data)`. The code
  exists. Message: `spawn: this computer cannot start sessions: /tmp has 0 free
  inodes (floor 20000)`. Data: `{ reason: "start_floor", role, path, metric, free,
  floor }`.
- Otherwise, for Cells only, the existing `disk_floor` check and message, with
  data `{ reason: "disk_floor" }` added.

A start for a bee that already exists (a wake after `send`, a revive) must not be
refused at the RPC: mail is accepted whatever the process health. In the command
loop, before `driver.start`, when the start floor is tripped:

- defer the command without counting an attempt, the way `deferReconnect` is used
  in `loops.ts`, and
- set the bee's `resource_blocked` flag with owner `start_floor` (add it beside
  `"sandbox_tmp"` in `FlagEvidence.owner`, `driver-hsr/src/driver.ts`) and detail
  `start_floor: /tmp has 0 free inodes (floor 20000)`.

When the floor clears, clear the flag and release the command. The spawn-failure
budget and `boot_exit` are untouched: the runtime never started, so there is no
exit to count.

### A4. Runner sockets: what HON-35 did and what is left

HON-35 (a03ab4f9) removes a runner's `hb-rh-<digest>/` folder when its host exits:
`removeRunnerSocket` is called by both host exit paths, by the driver's `onExit`,
and by `disposeAll`. That stops the growth. Left to do:

1. **The folder is still the shared temp folder.** `daemon.ts:914` takes `tmpdir()`
   and `placeDaemonSockets` (`daemon/src/socketPath.ts:35`) keeps it whenever the
   path fits. A full `/tmp` therefore still stops every start. New default:
   `<dataDir>/run`, mode 0700, when `join(dataDir, "run", RUNNER_SOCKET_SAMPLE)`
   fits the socket limit; else the `persistentSocketDir` fallback that exists.
   `~/.hive/v2/run/hb-rh-<16>/stdin.sock` is 52 bytes on Linux.
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
   `unlink`, nothing else, bounded to 20,000 entries per boot and logged as
   `runner.sockets.swept n=`. This is also what clears the 5,457 on metal-3 and the
   8,027 on metal-2. Several daemons can share a temp folder (lab daemons), so
   never remove a folder whose socket accepts a connection.
4. **Tests.** About 50 `new RuntimeHost(` sites pass no `socketDir`. Give
   `v2/driver-hsr/tests/helpers.ts` a default inside the test's own folder.

### A5. Red first

| # | Test that fails today | Passes when |
|---|---|---|
| R1 | Unit, fake `statfs` returning `ffree: 0` for `hostTmp`: `capacity.volumes` is undefined | the volume shows `below: "inodes"`, `reason: "start_floor"`, `newSessions: "refuse"` |
| R2 | Daemon test, same fake: `spawn` of an in-place bee succeeds and the runtime dies | `spawn` throws `resource_blocked` with `data.reason === "start_floor"`; no runtime row is created |
| R3 | Daemon test: `send` to a stopped bee under the floor burns boot attempts to `spawn_failed` | mail is accepted, the bee carries `resource_blocked` (owner `start_floor`), `spawnFailures` stays 0; lifting the floor starts it and clears the flag |
| R4 | Linux lab, real: a daemon whose inherited `TMPDIR` is a tmpfs with `nr_inodes=64`, filled (the mount recipe is `.proof/session-scratch/linux/03-limits.sh`, no root). Today five `boot_exit`s | with A4.1 the bee boots, because its socket is under `<dataDir>/run`; and capacity reports `hostTmp` under its floor |
| R5 | Daemon restart test: start a runtime with the socket folder set to A, restart the daemon with the default set to B | the runtime is adopted with the same pid and generation, and mail is delivered |
| R6 | Boot test: plant 3 empty `hb-rh-*` folders, 1 stale socket, and 1 live runner | after boot only the live one remains |
| R7 | Type test on `capacityOf`: `schema` is still `1` and a reader that knows only today's fields gets the same values | unchanged |

### A6. What Honeybee publishes for Apiary's half

The bee building Apiary's half needs these names:

- **Free inodes beside free bytes:** `capacity.cells.freeInodes`, and per device
  `capacity.volumes[].{roles, path, freeBytes, totalBytes, freeInodes, totalInodes,
  floorBytes, floorInodes, below}`. Absent means an older Honeybee; `null` inodes
  means the filesystem has no inode table.
- **The computer cannot start sessions:** `capacity.resourceBlocked.{blocked: true,
  reason: "start_floor", detail}` and `capacity.admission.newSessions: "refuse"`,
  with one `node.capacity` audit event on entry and one on exit.
- **Which Honeybee it is talking to:** capability `node.capacity.volumes.v1` in the
  hello.
- **A start that was refused:** RPC error code `resource_blocked` with
  `data.reason: "start_floor" | "disk_floor"`. Move the session without waiting.
- **A session that cannot start, said by the session:** the bee's `resource_blocked`
  flag with owner `start_floor` and the detail text, in `BeeView.flags`.
- **Failed starts, for the debit:** these exist already. The audit event
  `bee.spawn_failures` carries `{ beeId, spawnFailures, reason }` with reason
  `boot_exit` or `boot_exit_not_retryable` (`core/src/store.ts:3699`), and the
  bee's `spawn_failed` flag is set when the budget is spent. Step 1 adds nothing
  here; the debit is still needed for failures the floor cannot see.

## Appendix B. Two read-only checks on his computers

Both print counts only. Neither reads a transcript's text or a credential. Run each
on trmd-metal-1, -2 and -3 and paste the output.

### B1. Do sessions use `sudo` on workstations? ("Most likely wrong" 1)

`sudo` logs every call with its working folder and terminal. A harness's shell has
no terminal.

```sh
sudo journalctl -q _COMM=sudo --since "-30 days" -o cat | grep 'COMMAND=' | awk '
  { tty = ($0 ~ /TTY=unknown/) ? "no-terminal" : "terminal"
    where = ($0 ~ /PWD=[^ ;]*\/\.hive\/v2\/cells\//) ? "in-a-Cell" : ($0 ~ /PWD=\/(var\/)?tmp/) ? "in-/tmp" : "elsewhere"
    cmd = $0; sub(/.*COMMAND=/, "", cmd); split(cmd, a, " "); n = split(a[1], b, "/")
    count[tty " " where " " b[n]]++ }
  END { for (k in count) print count[k], k }' | sort -rn | head -25
```

A second count, for setuid tools that leave no log, over Claude transcripts by file
name only:

```sh
cd ~/.hive/homes && for w in sudo ping pkexec fusermount 'su -' mount; do
  printf '%-10s %s of %s session files\n' "$w" \
    "$(find . -name '*.jsonl' -mtime -30 -print0 | xargs -0 grep -lE "\"command\":\"([^\"]*[ ;&|(])?$w " 2>/dev/null | wc -l)" \
    "$(find . -name '*.jsonl' -mtime -30 | wc -l)"; done
```

| Result | Design |
|---|---|
| No `no-terminal` rows, and `sudo` in under 1% of session files | stands as written |
| A few rows, all package installs or service restarts | stands; those become a `run.command` on the host, outside the namespace, and the draft says so |
| `no-terminal` calls on most days, or `sudo` in over 5% of session files | build the root-installed unit (no user namespace, `sudo` works) before step 2 reaches workstations; satellites keep bwrap |

### B2. How often does a runtime change under a live task, and with what running? ("Most likely wrong" 2)

From the store, read-only. Per day: how many runtimes followed an earlier one of
the same bee within 30 minutes, by how the earlier one ended.

```sh
sqlite3 -readonly ~/.hive/v2/core.sqlite3 "
WITH pairs AS (
  SELECT a.bee_id, a.exit_cause, b.started_at AS next_start, (b.started_at - a.updated_at) / 1000 AS gap_s
  FROM runtimes a JOIN runtimes b ON b.bee_id = a.bee_id AND b.generation = a.generation + 1
  WHERE a.state = 'stopped' AND b.started_at > (strftime('%s','now') - 30*86400) * 1000)
SELECT date(next_start / 1000, 'unixepoch') AS day, exit_cause,
       count(*) AS changes, sum(gap_s < 1800) AS within_30_min, count(DISTINCT bee_id) AS bees
FROM pairs GROUP BY day, exit_cause ORDER BY day DESC, changes DESC LIMIT 60;"
```

The store does not record child processes, so the second half is a snapshot of
now (Linux): per bee, processes that left the harness's own session and are older
than 10 minutes. These are what a runtime change would kill.

```sh
for p in /proc/[0-9]*; do
  bee=$(tr '\0' '\n' < $p/environ 2>/dev/null | sed -n 's/^HIVE_BEE_ID=//p' | head -1); [ -n "$bee" ] || continue
  echo "$bee $(ps -o sid=,etimes=,comm= -p ${p#/proc/})"
done | awk '{ n[$1]++; if (!root[$1] || $2 < root[$1]) root[$1] = $2; row[NR] = $0 }
  END { for (i in row) { split(row[i], f, " "); if (f[2] != root[f[1]] && f[3] > 600) { away[f[1]]++; kind[f[4]]++ } }
        for (b in n) { bees++; if (away[b]) withbg++ }
        print bees " bees with live processes; " withbg " have long-lived processes outside the harness session"
        for (k in kind) print "  " kind[k], k }'
```

| Result | Design |
|---|---|
| `within_30_min` changes are rare (under about 1 per bee per week), or few bees have long-lived outside processes | stands: processes end with the runtime |
| Changes within 30 minutes are common **and** many bees have such processes | hold the namespace per bee with a small holder process, so a revive or account swap keeps the agent's servers; processes end at stop by a person, archive and delete |
| Changes are common but they are `crashed` | fix the crashes first; the count says nothing about the design |

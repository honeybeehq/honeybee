# darwin-gate/1

Runs the Honeybee v2 daemon suite (`v2/daemon/tests`, `v2/cli/tests`) on a lab Mac mini through forage. The run is scrubbed, kept off the network, and checked by sentinels. Proof history and incident notes are kept in the Project file `ops/darwin-gate.md`.

## How to run

Dispatch from metal-1/3 or a lab mini (mini02–05), never from a workstation or mini01. Use a full clone (never shallow) under that host's `~/.cache`, and add no ssh trust.

```sh
git clone git@github.com:honeybeehq/honeybee.git ~/.cache/dg/honeybee
cd ~/.cache/dg/honeybee && git fetch origin && git checkout --detach <sha>
sh scripts/gates/darwin/gate-run.sh > .dg.sh
~/.local/bin/forage --needs darwin --host trmd-erebor-mini02 -- "bash .dg.sh" > ~/.cache/dg/<name>.txt 2>&1; rm -f .dg.sh
```

- `gate-run.sh` puts `darwin-gate.sh` and a body (default `daemon-suite-body.sh`) into one script.
  - It pins the source commit; the sha gets `+dirty` if this directory has local changes.
  - It also records a short sha256 of each gate file and data file (including `excluded-tests.txt`).
- forage syncs the working tree, untracked `.dg.sh` included, into the lane.
- Every run prints and ends with `forage run · lane · snapshot · source · scripts`.
- Stage output only under `~/.cache`, never `/tmp`.

## Rules

**Where it runs:** hosts `trmd-erebor-mini02`, `trmd-moria-mini03`, `trmd-hobbiton-mini04` and `trmd-lorien-mini05` only, inside a forage job, inside a forage lane, and never in a Cell checkout or with `HIVE_CELL*` set. Cells never run the daemon suite.

**Scrubbed environment:**
- Stage 2 re-runs under `env -i`.
- Fake HOME, TMPDIR, XDG dirs and provider homes live under a run root shorter than 40 bytes (`~/.cache/scg/r.XXXXXX`).
- `HIVE_REAL_HOME` is set to the fake HOME and is the only `HIVE_*` variable.
- Real `npm ci`; a symlinked `node_modules` is refused. The pnpm store (`$GATE_ROOT/pnpm-store`) and npm's logs (`$GATE_ROOT/npm-logs`) live in the run root, never `~/Library/pnpm` or `~/.npm/_logs`.

**HOME sentinel:** before and after, on the real HOME top level, `~/.hive/v2` and `hived.sock`. The gate refuses to start without a valid before-snapshot, and any change FAILs.

**~/.npm record:** npm's cache stays at the real `~/.npm`, because it is content-addressed and integrity-checked. The HOME sentinel only compares top-level names and inodes, so the gate also records `~/.npm`'s file count and newest mtime before and after.
- Any change, or any path newer than the run start, prints `WARN ~/.npm changed (npm cache)` with the paths (first 100 and a count), never contents.

**No outside network:**
- Seatbelt (`sandbox-exec`) denies everything outbound except localhost and unix sockets.
- A Node preload trap blocks non-loopback connect, dns and dgram and records each attempt.
- Also: `GIT_ALLOW_PROTOCOL=file`, proxies pointed at `127.0.0.1:9`, npm offline.
- A mandatory probe runs before any test and must show outbound refused (nc, node, dns, git https), loopback working and the ps shim working. Otherwise exit 97.
- Any trap violation or Seatbelt `network-outbound` deny FAILs the gate.

**ps shim:** Seatbelt refuses setuid binaries, and `/bin/ps` is setuid. The gate puts an ad-hoc-signed copy without the setuid bit first on PATH inside the run root.

**Fake security:** the gate puts a fake `security` first on PATH, next to the ps shim.
- It records the time, pid, ppid and argv of every call in the run root's `security-calls`, never reads stdin, and exits 1. Any recorded call FAILs the gate; the calls are printed in the result and kept with the sentinels.
- The probe must find `security` resolving to the fake both inside and outside Seatbelt, else exit 97.
- This stays permanently, even after the Keychain fix lands. Code that runs `/usr/bin/security` by absolute path would bypass it; none does today.

**Known hosts (2026-10-15):** macOS AppleSystemPolicy kills the ad-hoc ps shim on some builds, even outside Seatbelt. The gate tries the shim right after building it, before `npm ci`, and on such a host refuses with exit 97, naming the macOS build.
- trmd-erebor-mini02, macOS 26.6.2 (25G83): runs the gate.
- trmd-moria-mini03, macOS 26.3 (25D125): refused.
- trmd-hobbiton-mini04 and trmd-lorien-mini05, macOS 26.4 (25E246): refused.

**Every file runs:** each test file runs separately, so one failure doesn't stop the rest.
- Files that spawn `sandbox: true` Cells run trap-only, because nested sandbox-exec is refused.
- So do the files listed in `seatbelt-exceptions.txt`. Its header names the fix that removes the need for it; delete the listed lines once that fix is on main.
- A listed file that no longer exists in the suite is refused with exit 98.
- Trap-only files must still pass.

**Excluded tests:** `excluded-tests.txt` lists test files the gate does not run at all, in either phase. Its header gives the reason.
- Today: files that reach `v2/daemon/src/keychain.ts` and so the real `/usr/bin/security`, until c51035e5's fake-security fix lands. The list comes from c51035e5 via Queen.
- The file must exist; an empty list is allowed for this file only.
- A listed file missing from the suite refuses with exit 98.
- The banner and the GATE RESULT line print every excluded file.

**Stale-tree guard:** before anything else, the gate checks the lane and refuses with exit 88 unless both hold:
- The lane HEAD is the source sha pinned by `gate-run.sh`, or a `forage snapshot` commit whose parent is that sha.
- Every pinned gate file in the lane (`scripts/gates/darwin/`) has the sha256 `gate-run.sh` recorded.

So a lane that another author resynced can never run under this provenance.

**One gate per host:** the gate holds `~/.cache/scg/gate.lock` (owner pid plus its start time) for the whole run.
- A second gate on the same host refuses with exit 89.
- A lock whose owner pid is gone, or now has a different start time, is stale and is cleared.
- A lock with no readable owner is never cleared automatically.
- The gate releases the lock only if it still owns it.

**Logs on failure:** when a run fails, its per-file test logs are kept in `~/.cache/scg/sentinels/<run root>-logs/`, next to the sentinels.
- After each run, only the newest 10 `r.XXXXXX-logs` directories are kept; older ones go to the Trash with `trash`.
- If `trash` is missing, the sweep is skipped and says so; it never uses rm.

**Reaping:** at exit the gate kills every process tied to the run root or the gate's own process tree.

**No foreign environment reads:** no step reads another process's environment. The census reads only pid, ppid, pgid, argv, and cwd via `lsof`.

## ~/Library sentinel

Before and after, on `~/Library/Preferences` and on Application Support, Logs, Caches, Containers and LaunchAgents.

**FAIL:**
- our app or lab plists (`dev.apiary.*`, `dev.honeybee.*`, `com.github.Electron*` with keys beyond AppleTextDirection, NSForceRightToLeftWritingDirection, NSTreatUnknownArgumentsAsOpen, SKPurchaseIntentUpdatesLastChecked);
- any created non-com.apple plist;
- any removal under Application Support, Logs, Caches, Containers or LaunchAgents (a removed plist WARNs unless it is ours);
- any path containing our names (`dev.apiary.`, `dev.honeybee.`, `com.trmd.apiary`, `com.github.Electron`, `Apiary`/`apiary`, `Honeybee`/`honeybee`);
- anything else that no rule below covers.

**Fail-closed scan:** every `find`, `stat` and `plutil` error in the ~/Library scan goes to the run root's `lib.errors`.
- The verdict and the GATE RESULT line print the error count. Any error is a FAIL with the lines printed; in the before-snapshot it refuses with exit 92.
- An absent optional area directory (for example no LaunchAgents) is recorded explicitly as `ABSENT|<area>` and is not an error. If it appears later it is a change; if a present area disappears it is a removal.
- A missing `~/Library/Preferences` is an error.

**Key names, every run:** for every watched plist (our app and lab ids, `com.github.Electron*`, `io.tailscale.*`, `.GlobalPreferences.plist`, `com.apple.spaces.plist`), the before and after key-name sets are compared on every run, even when mtime, size and birth time are unchanged. Values are never read into the record.

**WARN (key names only):** modified `com.apple.*` plists; `io.tailscale.*` plists with an unchanged key set; `.GlobalPreferences.plist`; `com.apple.spaces.plist`.

**Third-party list:** `third-party-warn.txt`, one `path|owner|mode` per line. Only Queen changes it.
- If the file is missing, empty or has a malformed line, the gate refuses (exit 99) before any test runs.
- Every warned path is printed with its owner.

| Entry under ~/Library | Owner | WARNs for |
|---|---|---|
| Application Support/Google/Chrome/ | Google Chrome | the dir and below |
| Application Support/Google/GoogleUpdater/ | Google Updater | the dir and below |
| Caches/io.tailscale.ipn.macsys/ | Tailscale | the dir and below |
| Caches/tv.parsec.www/ | Parsec | the dir and below |
| Containers/com.apple.Safari.CacheDeleteExtension/ | Safari CacheDelete extension | the dir and below |
| Containers/com.apple.geod/Data/Library/Caches/com.apple.geod/ | Apple geod | the dir and below |
| Caches/com.apple.duetexpertd/com.apple.e5rt.e5bundlecache/ | Apple duetexpertd | the dir and below |
| Application Support/networkserviceproxy/ | Apple (iCloud Private Relay) | only paths present in the before-snapshot; new files FAIL |
| Caches/com.apple.cache_delete/ | Apple CacheDelete | the dir and below |
| Caches/CloudKit/ | Apple CloudKit | the dir and below |
| Caches/GeoServices/ | Apple GeoServices | the dir and below |
| Caches/Google/Chrome/ | Google Chrome | the dir and below |
| Containers/com.apple.lighthouse.PnROnDeviceWorker | Apple lighthouse | paths inside; the dir itself only if it existed |
| Containers/com.apple.unilog.SearchUploadWorker | Apple unilog | paths inside; the dir itself only if it existed |
| Containers/com.apple.siri.ODDIPoirotExperimentationExtension | Apple Siri | paths inside; the dir itself only if it existed |
| Containers/com.apple.UsageTrackingAgent | Apple UsageTrackingAgent | paths inside; the dir itself only if it existed |

**Interim Apple rule:** mode `interim` in the same file, until a dedicated macOS gate user exists.
- Created or modified entries under `Application Support/com.apple.*`, `Containers/com.apple.*` and `Caches/com.apple.*` WARN.
- Interim globs are checked only after every other entry.
- Our names and removals still FAIL.

**Application Support/AddressBook** (the user's Contacts) is decided by attribution too, never by the list. The gate never opens or reads these files; it only sees their names in the scan.
- On any change there, the gate queries the system log for the run window (process names and pids only, no message text) for the named non-gate writers: `contactsd`, `AddressBookSourceSync` and `AddressBookManager`.
- A live writer counts as gate-owned if it descends from the gate shell, shares its process group, or has the run root in its argv or cwd. Otherwise it is foreign.
- An exited writer counts as foreign only if runningboardd recorded it as a launchd OS service (`Resolved pid N to [osservice<…>]`); otherwise it is unknown.
- The change WARNs `host shared (writer: <name> <pid>, …)` only when at least one foreign writer was seen and no gate-owned or unknown one. Anything else FAILs, including no writer seen.
- The per-run attribution (process, pid, owner) is printed and kept with the sentinels.

**Caches/claude-cli-nodejs** is decided by attribution, not by the list. A census samples Claude CLI processes every 2 s.
- A process is gate-owned if it descends from the gate shell, shares its process group, or has the run root in its argv or cwd.
- A change WARNs as "host shared" only when foreign Claude CLIs were seen and no gate-owned one was. Gate-owned or unknown FAILs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | PASS |
| 1, 95 | a test, network or sentinel FAIL |
| 88 | the lane tree or a gate file is not what `gate-run.sh` pinned, or no source sha was pinned |
| 89 | another darwin gate holds the host lock |
| 90 | wrong host, a Cell, outside a forage job or lane, or no Node ≥ 24 |
| 91 | `node_modules` is a symlink |
| 92 | before-sentinel invalid |
| 93 | run root could not be made or is 40 bytes or longer |
| 94 | test socket path would be 104 bytes or longer, or the ps shim or fake security could not be installed |
| 97 | probe failed |
| 98 | a file in `seatbelt-exceptions.txt` or `excluded-tests.txt` is not in the suite, or `excluded-tests.txt` is missing |
| 99 | `third-party-warn.txt` is missing, empty or malformed |

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
  - It also records a short sha256 of each gate file.
- forage syncs the working tree, untracked `.dg.sh` included, into the lane.
- Every run prints and ends with `forage run · lane · snapshot · source · scripts`.
- Stage output only under `~/.cache`, never `/tmp`.

## Rules

**Where it runs:** hosts `trmd-erebor-mini02`, `trmd-moria-mini03`, `trmd-hobbiton-mini04` and `trmd-lorien-mini05` only, inside a forage job, inside a forage lane, and never in a Cell checkout or with `HIVE_CELL*` set. Cells never run the daemon suite.

**Scrubbed environment:**
- Stage 2 re-runs under `env -i`.
- Fake HOME, TMPDIR, XDG dirs and provider homes live under a run root shorter than 40 bytes (`~/.cache/scg/r.XXXXXX`).
- `HIVE_REAL_HOME` is set to the fake HOME and is the only `HIVE_*` variable.
- Real `npm ci`; a symlinked `node_modules` is refused.

**HOME sentinel:** before and after, on the real HOME top level, `~/.hive/v2` and `hived.sock`. The gate refuses to start without a valid before-snapshot, and any change FAILs.

**No outside network:**
- Seatbelt (`sandbox-exec`) denies everything outbound except localhost and unix sockets.
- A Node preload trap blocks non-loopback connect, dns and dgram and records each attempt.
- Also: `GIT_ALLOW_PROTOCOL=file`, proxies pointed at `127.0.0.1:9`, npm offline.
- A mandatory probe runs before any test and must show outbound refused (nc, node, dns, git https), loopback working and the ps shim working. Otherwise exit 97.
- Any trap violation or Seatbelt `network-outbound` deny FAILs the gate.

**ps shim:** Seatbelt refuses setuid binaries, and `/bin/ps` is setuid. The gate puts an ad-hoc-signed copy without the setuid bit first on PATH inside the run root.

**Every file runs:** each test file runs separately, so one failure doesn't stop the rest.
- Files that spawn `sandbox: true` Cells run trap-only, because nested sandbox-exec is refused.
- So do the files listed in `seatbelt-exceptions.txt`. Its header names the fix that removes the need for it; delete the listed lines once that fix is on main.
- A listed file that no longer exists in the suite is refused with exit 98.
- Trap-only files must still pass.

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

**WARN (key names only):** modified `com.apple.*` plists; `io.tailscale.*` plists with an unchanged key set; `.GlobalPreferences.plist`; `com.apple.spaces.plist`.

**Third-party list:** `LIB_THIRD_PARTY_CHANGES_ONLY_VIA_QUEEN` in `darwin-gate.sh`. Only Queen changes it. Every warned path is printed with its owner.

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
| Containers/com.apple.lighthouse.PnROnDeviceWorker | Apple lighthouse | paths inside; the dir itself only if it existed |
| Containers/com.apple.unilog.SearchUploadWorker | Apple unilog | paths inside; the dir itself only if it existed |
| Containers/com.apple.siri.ODDIPoirotExperimentationExtension | Apple Siri | paths inside; the dir itself only if it existed |
| Containers/com.apple.UsageTrackingAgent | Apple UsageTrackingAgent | paths inside; the dir itself only if it existed |

**Interim Apple rule:** `LIB_INTERIM_APPLE_UNTIL_GATE_USER`, until a dedicated macOS gate user exists.
- Created or modified entries under `Application Support/com.apple.*` and `Containers/com.apple.*` WARN.
- Our names and removals still FAIL.

**Caches/claude-cli-nodejs:** a census samples Claude CLI processes every 2 s.
- A process is gate-owned if it descends from the gate shell, shares its process group, or has the run root in its argv or cwd.
- A change WARNs as "host shared" only when foreign Claude CLIs were seen and no gate-owned one was. Gate-owned or unknown FAILs.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | PASS |
| 1, 95 | a test, network or sentinel FAIL |
| 90 | wrong host, a Cell, outside a forage job or lane, or no Node ≥ 24 |
| 91 | `node_modules` is a symlink |
| 92 | before-sentinel invalid |
| 93 | run root could not be made or is 40 bytes or longer |
| 94 | test socket path would be 104 bytes or longer, or the ps shim could not be built |
| 97 | probe failed |
| 98 | a file in `seatbelt-exceptions.txt` is not in the suite |

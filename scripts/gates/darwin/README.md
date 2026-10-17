# Darwin gate v2

This wrapper runs only on erebor, through the orchestrator-authorized absolute forage route. All ordinary Darwin runs remain held pending Queen's review of this hardening. This PR's self-test uses only its private run root; it does not read the real HOME sentinel or LaunchAgents.

## Entry and provenance

Use a committed, pinned Honeybee checkout. Run all fetch/push/gh commands from an explicit absolute checkout cwd, under the exact I-8 authorization and provisioned config. Never use origin, credential overrides or host-key workarounds.

The runner invokes a committed script by path, rather than an inline remote shell payload:

```sh
/home/trmd/.local/bin/forage --host trmd-erebor-mini02 --needs darwin -- /bin/sh scripts/gates/darwin/self-test-run.sh <exact-approved-sha>
```

The metal-1 runner needs PATH=/usr/local/bin:/usr/bin:/bin. Its tool call supplies its absolute checkout cwd explicitly. Forage syncs into /Users/trmd/.cache/fj/<lane>; the gate also recognizes the older .forage/work lane. Source HEAD must equal the approved SHA or be forage's snapshot child. Gate file hashes are full SHA256, including the guard, native scope helper and bodies. Uncommitted gate files and redirected files refuse. The wrapper archives the pinned Git commit into the run root before compiling or running anything, so it does not execute a mutable lane copy.

Node is selected from an explicit configured absolute path, or /opt/homebrew/bin/node, /usr/local/bin/node, /opt/homebrew/opt/node@24/bin/node. No mise, nvm or real-HOME discovery. A selected Node below 24 refuses. Python is explicitly /usr/bin/python3 or /opt/homebrew/bin/python3. Selected canonical executable paths and versions go in the retained receipts. No Keychain or security command runs; the workload's security shim refuses, and Seatbelt denies /usr/bin/security and Mach service lookup.

## Before the first write

The stdlib Python guard canonicalizes the planned /private/var/tmp/g.<id> root and every fake HOME, TMPDIR, XDG, provider and cache path before opening the host lock or creating any directory. Fake paths must be absolute and resolve inside that root. The passwd HOME, Library, all provider homes and symlink escapes refuse. The environment is rebuilt without stamped HIVE_/APIARY_ values; only HIVE_REAL_HOME names the fake HOME.

The host lock is /private/var/tmp/hb-darwin-gate.lock, the expressly approved control-path exception. It uses a non-following open, validates regular-file ownership, and holds a kernel flock. It is never swept or removed. Run roots are created exclusively with mode 0700.

## Storage, caches and network

The complete workload, including dependency preparation, runs under an inherited Seatbelt policy denying writes outside its run root and reads under the real HOME. It cannot relax the policy through a plain or nested subprocess. Source and dependencies live in the root; the original forage lane is not writable or readable by the workload.

npm, pnpm, Node compile caches, compiler caches and logs are per-run. Normal runs require an explicit hashed cache-seed archive from the pinned lane or this root. Only npm/, pnpm/ and node/ regular-file/directory entries are accepted; unsafe members and hash mismatches refuse before extraction. Self-tests create a fresh empty seed inside their own root. Nothing inspects or shares the real ~/.npm.

Darwin network is SHARED, not a Linux network namespace. Seatbelt denies non-loopback outbound and limits Unix socket connections to the run root. Loopback remains shared with the host; this is not a host-network isolation claim. A Node preload records/refuses remote TCP/DNS/datagram attempts. No system-log or foreign-process census is performed.

## Sentinels, cleanup and evidence

The only Library sentinel is LaunchAgents: immediate entry names and SHA256 content hashes. It never reads Preferences keys, other plist bodies, Contacts, caches or other Library areas. Symlinks and non-regular entries refuse. Any snapshot change fails. Self-tests substitute a fixture entirely inside the run root.

The native scope helper discovers only children of the gate's own workload. It records kernel process births with seconds and microseconds. Cleanup rechecks each recorded birth immediately before TERM/KILL; an unreadable or mismatched identity refuses and fails, never falls back to argv, a process-group number or a foreign census. Scope observations and signal outcomes are retained. Sampling can miss a process born and reparented between observations; this is not a same-UID-adversary security boundary.

Every run root remains in place, including failures. Logs, source manifest, guard evidence, scope records, sentinel hashes and result are retained there. SHA256SUMS.json hashes receipt files and logs; its own SHA256 is printed. Source and caches are represented by their source manifest and seed hash. Nothing moves into a shared HOME sentinels directory; no sweep, trash or previous-run cleanup exists. Pull only this recorded root into a dedicated local pull directory.

## Self-tests

Linux: linux-self-test.sh runs the pure guard tests in a private user/network namespace, checks Bash syntax, and runs shellcheck when installed. The entry guard validates its cache-root fake environment before the test writes. Native Darwin scope and Seatbelt behavior require the erebor self-test; Linux success does not establish them.

Darwin: self-test-run.sh <sha> runs the same guard tests plus physical rows for an allowed in-root write, refused outside-root write, isolated per-run caches, exact-birth signaling/refusal and non-loopback network refusal. No test invokes security or probes any real HOME file. Earlier-run log retention and LaunchAgents-only behavior are exercised with owned fixtures. A planted write must fail before bytes land outside the root. Any unexpected success is a failure, never an expanded allowance.

No deployment or proof is authorized by this gate.

## Per-run Node bootstrap

The legacy pinned-runtime and pinned-full bodies refuse before work with
`darwin_gate_body_unsupported_until_audited`. Their old real-home service sentinel
needs a root-only conversion and Queen audit. Only daemon-suite and self-test
bodies are supported by this change.

Network policy denies network operations by default, allowing Unix sockets only
under the run's TMPDIR (<root>/t) and IP only on loopback. Loopback is necessary for the HTTP
fixtures in daemon auth-death-fixture, claude-refresh-transport, lease-enrol-rpc
and auth-death-rpc tests. Darwin shares the host network namespace: outbound
loopback could reach real host-local services. This residual risk is explicit
in the receipt; this gate does not claim Linux network-namespace isolation.
The controller creates two real listeners before the self-test: one under t
for a successful connect, one outside t but still inside the run root for an
EPERM/EACCES refusal. ENOENT never counts as enforcement. The controller removes
both using recorded inode/type identities. Future suite sockets outside TMPDIR
remain held pending audit; the scope is never widened silently.

The native scope helper uses only an absolute clang, matching absolute linker
and explicit SDK from the fixed Xcode/CommandLineTools candidates. Metadata and
selected paths are recorded. No cc, xcrun, xcodebuild or xcode-select discovery
runs. The compiler has an exact executable allowlist and read access to the
selected toolchain/SDK, with module cache inside the root. The one permitted
device write is file-write-data on literal /dev/null, a kernel sink. Other /dev
writes stay denied and are tested. No storage exception is granted by this rule.
After flags-only attempts still produced an empty cc1 executable, the compiler
policy adds metadata-only literal access to clang and its exact ancestor
directories, never a subpath or a path under /Users. These literals are recorded.
The dry run must show absolute job executables/resources before compilation.

`self-test-run.sh <sha> --download-node` explicitly enables the Queen-approved
per-run official Node download. `node_bootstrap.py` is the single archive pin:
v24.18.0 darwin-arm64, from nodejs.org over HTTPS/TLS1.2 or newer. SHA256 is
checked before opening the tar or creating its extraction directory. A mismatch
extracts nothing. Node is first on PATH by absolute run-root path; npm and Node
caches remain under that root. No system install or real-HOME Node is used.
The distribution has the run root's lifetime and is deleted only with that root;
the gate retains the root and its receipts for collection, never sweeps it.
Honeybee's Node runtime uses per-install binary pins, and the inspected Apiary
bootstrap has no shared pinned archive list (orchestrator1918), so this gate pin
does not duplicate an existing staging pin source.

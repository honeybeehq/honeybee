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

The host lock is exactly /private/var/tmp/hb-darwin-gate.lock (Queen, 17 Oct 12:13Z). It must be an empty regular file, mode0600, owned by the lab user. A non-following open refuses symlinks; wrong owner, mode or nonempty content refuses. Only flock is used: no writes, removal or sweep. Device, inode, mode and uid are recorded in the receipt. Run roots are created exclusively with mode0700.

## Storage, caches and network

The complete workload, including dependency preparation, runs under an inherited Seatbelt policy denying writes outside its run root and reads under the real HOME. It cannot relax the policy through a plain or nested subprocess. Source and dependencies live in the root; the original forage lane is not writable or readable by the workload.

npm, pnpm, Node compile caches, compiler caches and logs are per-run. Normal runs require an explicit hashed cache-seed archive from the pinned lane or this root. Only npm/, pnpm/ and node/ regular-file/directory entries are accepted; unsafe members and hash mismatches refuse before extraction. Self-tests create a fresh empty seed inside their own root. Nothing inspects or shares the real ~/.npm.

Darwin network is SHARED, not a Linux network namespace. The 52e76fd3 probe accepted a remote tailnet connection: Seatbelt did not restrict IP bind or inbound despite the localhost policy. The controller now samples only birth-verified workload processes for TCP LISTEN and bound UDP, fails on addresses outside 127.0.0.0/8 or ::1, and invokes the fenced reaper. Sampling sleeps 50 ms between cycles; actual intervals include the scan cost and are recorded. A listener can be exposed between observations, and a short-lived process may escape observation. Loopback outbound can reach host-local services. Unix socket permission is limited to TMPDIR. No system-log or foreign-process census is performed.

The static listener check scans every file under v2/** and tests/**. Unknown extensions containing listen/bind fail closed. Listen targets must be literal Unix paths or loopback addresses, or have an audited entry in listener-allowlist.json. Entries combine normalized call-context hashes with hashes of exact cited receiver declaration lines; changing or moving a declaration fails closed. Bind scanning covers modules importing dgram/socket; a socket passed across modules is covered only by the runtime own-pid sampler. No variable-name assumption is used. No product test was modified to hide a finding. Self-tests record wildcard TCP and UDP detections, including a retained reparented grandchild, as expected FAIL observations followed by fenced cleanup; they make no remote connection. The one-shot inbound diagnostic mode has been removed after the probe.

The gates perform no remote Git operations: only local status, revision checks and archive. Forage transport is tool-owned. The common fixture runners also perform no remote Git operations. Disposable perf fixtures configure synthetic remotes and exercise local clones; cell-warmpool-bench uses GIT_CONFIG_GLOBAL/SYSTEM. These are existing repository test/bench behavior, left unchanged under the orchestrator's ruling. Agent fetch/push commands separately require the exact authorized URL variable and allowlist guard.

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

## Focused delivery-file manifest

The reviewed focused entry is `gate-run.sh --execute scripts/gates/darwin/focused-manifest-body.sh <full-merged-source-sha>`. It requires the same pinned per-run Node and lane-local hashed dependency seed as the ordinary gate. There is no arbitrary body, test-file or package-script selector. The checked-in focused-manifest.json currently selects 49 required rows in three files: 47 inside the outer Seatbelt and exactly two Darwin read-matrix rows (Cell and satellite) in a controller-launched sibling. The HSR row stays in the outer sandbox (Queen, 17 Oct 16:05Z). Twenty audited Linux-only names are excluded, never counted as Darwin proof. The manifest remains subject to PR 2's final reviewed source.

The sibling test HARNESS runs outside the outer Seatbelt. Only its Cell/satellite RECIPIENT runs under the real production wrapper/profile, with the approved scratchPaths:[] fixture narrowing. The outer HSR row reports its production write denial as NOT APPLICABLE. Every selected row must appear exactly once and PASS. SKIP, TODO, cancellation, a missing/duplicate/unexpected row, a nonzero process exit or an incomplete TAP plan fails. Per-row TAP diagnostics must include the six exact harness labels and the substrate-specific write evidence. The test process gets a constructed allowlist environment, a root-local cwd, pinned Node, a 600-second timeout, retained-birth listener sampling and fenced cleanup. Sampler and identity helpers have individual two-second subprocess timeouts. Library/provider snapshots are metadata-only, without following symlinks; LaunchAgents additionally retains the approved content hashes. Every delta fails.

Each sibling row runs twice (Queen, 17 Oct 16:09Z): instrumented for the execution census and plain for the production read result. The checked-in gate preloader is hash-pinned. It adds --import to the instrumented Node argvs only, observes or refuses executable/native-load operations, and emits a hello in every Node descendant. Trace data travels over an inherited fd, with no trace file and no file opens by the recipient's preloader. Every touched argv records the added flag; long arguments are represented by their length and hash. Native loads admit exactly delivery-file.node and peercred.node by resolved path and controller-manifest hash with matching inode/mtime (Queen, 17 Oct 16:10Z). The controller verifies the actual artifacts before and after every launch. Other executables and native loads fail; ps is never admitted. psutil's literal ps sites are census-only unreachable-callsite entries, requiring the checked-in source-line reachability proof and the checker's manual review of the final audit.

Only the instrumented harness uses --test-isolation=none. Node's default test-runner child is born before preloader hooks and loses the trace fd; a regression proves that this configuration fails closed without hello coverage. The plain harness keeps default isolation and no preloader (orchestrator ruling, 17 Oct 16:45Z). Both argvs and the reason are retained. The read pair uses each run's own SCG_READ_RESULT digest and header sha256 evidence, never raw headers. Expected and observed hashes must match within each run; both runs must PASS and agree on readClass and writeDenied, while their random publication digests may differ (Queen, 17 Oct 16:10Z and 16:16Z). Missing, duplicate or malformed evidence fails.

The source-final PR 2 head must supply `scripts/gates/darwin/focused-sibling-audit.json`. Missing pins refuse. Version 1 has exactly version/files/spawns/packages/capabilityReferences/nativeEdges/entryPins. Every files entry has path, sha256 and siblingClosure; all three manifest entry files are pinned, and only the two outer-only entries may set siblingClosure=false. Every runtime relative import in the sibling closure must have another true pin. Every spawn entry has path, line, context, executable, receiver and the required manualReview boolean. Context is the entire cited source line; hashes use raw file bytes, without normalization. The fixed executable vocabulary is node, production-sandbox-exec, production-wrapWithSandbox and delivery-file-reader. The sole disabled-build citation, build-refused-prebuilt-only, additionally requires prebuiltGuard with path/line/context for the preceding single-line `if (process.env.SCG_DELIVERY_FILE_PREBUILT_ONLY === "1") throw ...` refusal. The checker must verify that this guard dominates the build branch; exact source hashes preserve that review. Test rows receive that key as 1. No compiler or build script becomes an allowed sibling executable.

The TypeScript census tracks scoped symbol identities for direct sensitive imports, aliases, re-exports and uses. It does not taint callers of wrapper functions or the data returned by spawn. Re-exported aliases retain their sensitive builtin origin, rather than treating the wrapper module as a new origin. Explicit type-only declarations are erased; all-type specifier imports remain runtime edges when the candidate's tsconfig preserves an empty import, including verbatimModuleSyntax. Config files used for this decision are confined to the candidate root and hashed in the census receipt. One spawn citation covers all sensitive groups on its exact file:line. Otherwise one capabilityReferences citation is required per file:line:module:kind group, with duplicate matches and stale entries failing. An unreachable-callsite replaces only a reference group at the exact literal callsite. These checks are necessary but not sufficient: the checker must manually review the final closure and every cited receiver and reachability proof.

entryPins is a separate array of exact `{path,line,context,role}` citations. Exactly one production-sandbox-exec pin and one reader-entry pin are required, in hash-pinned sibling-closure files. Missing, duplicate or changed contexts fail. They never count as capability groups and never grant an executable permission. The census receipt includes counts by kind, builtin origin and top-level directory, plus the ten files with the most groups.

Symbol identity comes from the pinned TypeScript syntax binder and lexical locals, without a type checker or contextual type inference. Any census exception fails the entire operation with a typed CensusFailure naming the file and phase; an exception never produces a partial census or skips a file.

Bare package pins are limited to ajv/dist/2020.js, jsonc-parser and smol-toml. Each package record contains specifier, path, version, packageJson, packageJsonSha256 and entrySha256. A gate-owned resolver runs inside the outer profile and resolves only the lockfile-installed run-root node_modules. All fields must equal the reviewed audit. Other bare imports fail closed. Source, runtime, gate-control files and dependency bytes are rechecked before launches.

The controller builds BOTH delivery-file and peercred darwin-arm64 bridges by invoking absolute clang directly under the existing compiler.sb, unchanged. It uses the same fixed driver, resource, SDK and linker paths and literal-ancestor metadata grants as scope.c. Each C source must match its original candidate-archive hash before and after compilation. It writes each product-compatible version/target/napi/sourceSha256/sha256 manifest itself, then requires the respective non-optional probe under the ordinary workload profile. Candidate build JavaScript is never run unsandboxed. The focused workload adds compiler-execution denials; the sibling gets no compiler route. Source, binary and manifest digests and metadata must remain unchanged through tests. A missing artifact, probe failure or rebuild is a failure.

The dependency-seed proposal is network-enabled seeding only on an approved Linux gate host, under a fresh fake HOME/cache, from the exact candidate lockfile, using npm ci --ignore-scripts --no-audit --no-fund --include=optional --os=darwin --cpu=arm64. Record npm version and verify the Darwin optional-package cache inventory; platform flags alone are not sufficiency evidence. Pack npm/_cacache entries (no Linux node_modules/native output), record a new SHA256, and transfer only through the approved runner lane. Existing guard hash/member checks still apply. Darwin offline npm ci and the actual confined native builds must prove completeness. If Linux cannot populate the necessary tarballs, stop and request Queen's separate controller-owned erebor network-seeding authorization. This PR does not provision a seed or authorize network for workloads.

# External execution dev review

`external-exec-v1` is review code under DEPLOY HOLD. No merge, deploy, guest proof
or credentials are authorized by this document. Phase 3 remains design only.

Spawn selects a pre-registered bridge id. Executable paths, all three SHA-256 pins
and workspace grants come exclusively from an owner file. Inline `externalExec`
configuration is rejected. `externalOwnerFile` points outside the Cell to a 0600
regular, single-link file under a canonical 0700 management directory. The file is
`{"schema":"honeybee.external-owner.v1","externalExec":{"bridges":{},"workspaces":{}}}`.
Only the owner or trusted management may provision it; the loader never creates
this authority. The hive v2 root, its ancestors, the public data root and Cell
roots cannot be used as owner roots. The directory also contains an existing 0600, 32-byte
`management.key`, a daemon-written 0600 `endpoint.json`, and the absolute
private `hived.sock`. The daemon keeps its ordinary public socket and endpoint
unchanged and adds this separate management-only listener. Default config and CLI
target resolution never open the owner file or key; only daemon loading and the
external-exec management command opt in. Files and private parents require the daemon owner's uid; ancestors
must be protected from other writers (root-owned sticky temporary roots are safe
for isolated test fixtures). Cell paths, symlinks and permissive authority files
refuse. No such directory or owner configuration was provisioned by this work.

The dedicated `rpc.externalManagement.challenge/register` slot is separate from
Apiary's observation registration. The HMAC binds workspace, uid, pid, process
birth, nonce, expiry and daemon instance. The CLI checks its own process identity
and expected daemon instance from the protected endpoint before signing. Spawn
uses the connection's registered workspace, ignoring caller-asserted workspace
context. Existing local uid, peer-credential, remote, relay and phone checks still
apply. Capability `external-exec.v1` is off without a protected management slot and
an explicit workspace grant. An unrestricted bee sharing management's uid is NOT
isolated by 0700/0600: production must keep the management files and socket outside
bee filesystem authority using a separate uid or sandbox. No Apiary grant path is
implemented here.

The CLI is `hive external-exec NAME --bridge urbench-v2 --workspace WORKSPACE
--file PRIVATE-DISPATCH --idempotency-key KEY`. It installs no account, config,
preamble, kit or MCP and does not initialize app-server or resume a vendor session.
Ordinary spawn profiles cannot alias this adapter. Mail is never a native prompt.

Before EACH start/wait/stop/reconcile exec, the driver verifies the three pins on
open descriptors, requires immutable root-owned install files and a root-owned
path chain with no group/other writers, hashes every files.json and payload.sha256
entry, and verifies the shebang interpreter is listed and immutable. Root-owned
symlinks are permitted only with a protected original AND resolved chain. The
executable remains on fd 3 for exec. Manifests may be reopened by the launcher only
because their entire chain is immutable to unprivileged callers. Root and kernel
are trusted. The superseded home-directory install fails this chain check;
changing only its file modes or matching its hashes does not make it usable.
A relocated launcher may require new pins from Ur Bench, because its paths are
embedded. This work does not alter that installation or weaken the root check.

The bridge env is exactly PATH=/usr/sbin:/usr/bin:/sbin:/bin, LANG=C.UTF-8,
LC_ALL=C.UTF-8. Dispatch is canonical JSON plus newline on stdin. HOME being unset
DOES NOT hide the real account home from getpwuid or direct filesystem access;
separate uid/sandbox isolation is required for that guarantee.

SQLite schema 48 stores attempt/bridge/workspace, redacted dispatch, fence hash,
dispatch digest, ownership and validated receipt. The full fence passes through a
private daemon-to-host stdin pipe and a host-to-runner pipe, never host config or
the bidirectional session log. Existing config files are checked, truncated and
chmodded through their fd. The survivor holds the dispatch in memory. The daemon evicts the fence when a
validated receipt reaches terminal state; idempotent terminal replay does not
restore it. The encoded private boot limit accounts for both JSON layers. Adoption
needs only hashes. Losing the survivor also loses the launch capability: management
must resubmit the identical dispatch/key before revive can reconcile. Dispatch is
claimed before launch; a new observer never blindly starts an existing attempt.
The pre-review schema-48 prototype with plaintext bindings is incompatible and
refuses when read; use a fresh isolated dev store. Existing prototype database/WAL
files and runner configs must remain private and be retired, not treated as
securely erased by an SQL update. This unreleased format has no production upgrade
or rollback promise. Public mirrors retain only optional safe execution metadata.

Stop first uses the owner control lane. After the grace period, exact process
identity is checked before group SIGTERM. A separate timer retains verified group
member PID/birth/pgid anchors even if the host leader exits and is removed from the
driver. The next grace period sends group SIGKILL after re-verifying a surviving
anchor; an empty group ends cleanup. Unknown group ownership never permits a
signal: cleanup stays armed and records uncertainty until empty or a verified KILL.
The survivor attempts reconcile with its in-memory dispatch if transport is
interrupted. Signaling never proves guest teardown. Destructive conversation/account
mutations are refused; delete requires terminal receipt and stopped runtime.

Raw native stdout/stderr and operational bridge stderr remain untrusted private
data. Each stream has a 16 MiB cap, recorded in capture.json with truncation and
drain status; final drain is bounded to 32 passes of at most 1 MiB per native
stream. Events have a 2 MiB frame cap and 16 MiB invocation cap. Receipt publication
waits for bounded capture and its metadata write. Truncation settles with
externalExecution.capture="truncated", alongside the unchanged bridge model
status. Duplicate receipts preserve that capture result. Capture I/O failure or an
incomplete drain still requires reconciliation. This additive mirror/view/audit
field reuses existing schema-48 metadata; no SQLite column is added.
Receipt binds attempt, fence hash, canonical
dispatch and pinned payload. Zero bridge exit never implies model success.

The FINAL candidate is Ur Bench main 14de2f119af5a822c12e8910339666c311dace27,
bridge id urbench-v2. `docs/design/external-exec-owner-candidate.json` preserves the
exact executable/files.json/payload pins for review, but is inside the Cell and is
explicitly NOT loadable authority. `.local/external-exec-dev/config.json` has no
external grant, key or relative/proc socket. No live configuration changed. Trusted
provisioning and Queen's review must precede any no-inference round trip.

The second read-only row is external-exec-pin-check-14de2f11.json: all three /opt
pins and the install chain pass, covering 1913 inventory files and 2038 unique
symlink-expanded components (including package metadata). All three individual
flipped-pin probes refuse. The bridge was not executed or registered. The earlier
home-layout refusal row remains in .local/external-exec-dev/fix-pin-row.json.
These checks do not provision owner isolation or make the disabled adapter usable.

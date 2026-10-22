# metal-3 DEV external-exec provisioning plan

Review target: T2, 2026-10-22. **NOT EXECUTABLE / NO GO YET.** This document
records exact infrastructure commands for T3 and the unresolved inputs that must
be replaced in a follow-up reviewed commit before execution. T2 ran no sudo,
bridge, guest, service-control, credential-generation or host-change command.
Queen GO must name the final commit; GO on this draft cannot authorize the missing
broker, launcher, credentials or privilege-policy work. DEPLOY HOLD remains.

## Scope and blocking decisions

The result is a locked `honeybee-exec-dev` UID, dedicated system daemon and broker,
separate private roots, pinned bwrap and a sandboxed no-inference bridge. The LIVE
trmd daemon, its UID, unit, artifact, config and data stay untouched. No `hive deploy`
is in this plan. Any later change to the deployed LIVE runtime requires that command
and separate authorization. Provisioning a DEV artifact must also follow the approved
immutable artifact/deploy mechanism, never copy build output from a mutable Cell.

The source at design base `59be42e5fad27682f22ab93c09db179280df4ef0`
(source head `4fe7e4b501563f7a5c23a25ad908bc96177ae7e6`) implements a
foreground daemon and owner CLI, **not an external-exec broker or bwrap launcher**.
`src/daemon/broker.ts` is unrelated existing broker code. There is no truthful
broker ExecStart command today. Starting the existing daemon with an enabled owner
file would bypass the required future sandbox. Keep `workspaces` empty.

Before T3 executes even infrastructure changes, Tormod and Queen must settle:

| Decision | Observation and cost | Required outcome |
| --- | --- | --- |
| Cell privilege escalation | Current native Cell tool and harness have NoNewPrivs=0, CapEff=0, uid 1001, supplementary groups 27/1001. trmd belongs to sudo. No sudo probe was run; membership alone does not prove a usable rule. | Trusted operator audits sudoers/polkit and all agent/harness-native execution paths. No available root/service-control route from Cells. |
| Dedicated VM/host | Best independent boundary if trmd keeps broad sudo on metal-3; costs another isolated machine/VM, networking, KVM passthrough/nested virtualization proof and re-pinning inventory there. | New host requires a new plan; do not silently substitute it. |
| Narrow sudo | Retains selected operational tasks, but every allowed executable, argument, writable dependency and service-control route needs review. | Exact allowlist and root-owned dependencies; separate operator-reviewed plan. |
| Enforce NNP for every Cell | Preserves operator sudo outside Cells; must cover harness, native tools, children, alternate launchers and existing sessions. Existing sandbox.ts does not provide this universal guarantee. | A reviewed launcher change and real tests; never infer from one bwrap child. |
| Remove sudo | Breaks agent/operator maintenance workflows; password and polkit alternatives must also close. | Tormod decision; no group mutation in this plan. |
| KVM strict policy | getent lists trmd in kvm, though current process groups omit it. A fresh login could inherit kvm. Removing membership affects trmd's Ur Bench labs and existing groups/FDs survive changes. | Original design requires no trmd KVM route; needs operator remediation and new-session/open-FD checks. |
| KVM reduced policy | Keep trmd KVM, grant only service UID additionally. KVM access alone does not read owner data, but both share kernel/KVM attack surface. | Tormod + Queen must explicitly accept narrower claim: Cells may use KVM, cannot read/control service roots, broker or keys. This amends original design; T2 does not accept it. |
| Runtime artifact | No reviewed broker/launcher entry point or artifact digest exists. | T1/code owner supplies immutable artifact, Node pin, install/deploy command, exact broker argv and cgroup/seccomp helper policy. Queen reviews a new plan commit. |
| Credentials | No keys provisioned. T1 notes absent at inspection. | Trusted operator supplies key/pin paths and artifact schema; no agent generates or handles secret values. |

No host-wide ptrace, hidepid, sudoers, group, time-service or live-unit change is
bundled here. Cross-UID proc/ptrace protections do not rely on ptrace_scope >=1:
ordinary UID/capability checks apply even at 0. Prove against the actual service
later. An available root route invalidates those checks.

## Observed read-only evidence

Commands below ran as trmd in this Cell on `trmd-metal-3`; date 2026-10-22.
Commands separated by newlines are separate observations, not a script to provision.

```sh
hostname
cat /etc/os-release
/usr/lib/systemd/systemd --version
uname -r
id
getent passwd trmd
getent passwd honeybee-exec-dev
getent group honeybee-exec-dev
getent group kvm
ls -l /dev/kvm
getfacl -p /dev/kvm
/usr/sbin/sysctl kernel.unprivileged_userns_clone user.max_user_namespaces kernel.yama.ptrace_scope
bwrap --version
sha256sum /usr/bin/bwrap
namei -l /usr/bin/bwrap
systemctl is-active chrony systemd-timesyncd
timedatectl show -p NTPSynchronized -p NTP
systemctl list-unit-files '*honeybee*'
systemctl --user list-unit-files '*honeybee*'
cat /proc/self/status
cat /proc/876498/status
```

Observed: Debian 13.5 trixie, kernel 6.12.94+deb13-amd64, systemd
257.13-1~deb13u1. `/usr/lib/systemd/systemd` and `/usr/sbin/sysctl` require
absolute paths in this harness. User namespaces: enabled, maximum 1030151.
ptrace_scope=0. chrony inactive, systemd-timesyncd active, NTP=yes and
NTPSynchronized=yes. This is a point-in-time observation, not proof of <=5 s clock
uncertainty or broker fail-closed time monitoring.

No service account/group or proposed roots exist. trmd is uid/gid 1001,
current groups trmd/sudo; `getent group kvm` says `kvm:x:993:trmd`.
`/dev/kvm` is root:kvm 0660; ACL contains only user::rw-, group::rw-,
mask::rw-, other::---, no named trmd ACL. Current process group absence is not
permanent denial. No system Honeybee unit exists. User unit
`dev.honeybee.hive.v2.service` is enabled/active; six old lab unit entries are bad.
Do not repair them as part of this task.

`/usr/bin/bwrap`: bubblewrap 0.12.0, root:root 0755, all canonical ancestors
root-owned 0755, SHA-256:
`573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f`.
It has no setuid bit. Pin a protected copy rather than follow package updates.

`test -r /proc/1199/environ` returned 1; readlink of that systemd-timesyncd
process's root/fd/0 failed. Public status remains readable. No ptrace attempt,
signal, service-UID proc test, sudo-policy test or real sandbox proof was run.
The harness PID 3882363 and native shell reported NoNewPrivs=0; live daemon too.
`v2/driver-cell/src/sandbox.ts:285` binds whole `/` read-only and shares net;
it is not the proposed bridge secrecy boundary.

Bridge prefix (B):
`/opt/urbench-v2/bridge/14de2f119af5a822c12e8910339666c311dace27`.

| File under B | Observed SHA-256 | Mode/owner |
| --- | --- | --- |
| bin/urbench-bridge | 7157b41da3845b273f1208e0c9d14e53ec0ff7c56c9d5c7950d1ccf4e1c4d946 | 0555 root:root |
| files.json | 2b25875bc9bc5b7808b614b022497febc4bd0afd2a8a6fcd7fb16ae8ec5607cf | 0444 root:root |
| payload.sha256 | 89ba8f60ce2638d89533ce97cb2a8623c0db8ca067cf47d0b73fdc2395ebed2d | 0444 root:root |

Read-only Python iteration over `files.json.files` hashed all 1913 file paths and
checked uid=0/no mode&022 on each path, resolved path and their ancestors: PASS.
No bridge execution. OS updates to listed Python/QEMU/libraries/config data can
invalidate this inventory and require reviewed new pins. Do not relocate the bridge:
its script embeds absolute B paths and checks payload and project-files.list.

## Full intended layout

`S` below means `honeybee-exec-dev:honeybee-exec-dev`. Each listed directory is
0700 unless another mode is shown. Runtime-created files are 0600 and sockets
0600 (verify explicitly), never symlinks. Roots are siblings, not descendants of
the owner root: externalAuthority.ts forbids overlapping owner/data/Cell roots.

```text
/var/lib/                                  root:root 0755 (existing)
  honeybee-exec-dev/                        S 0700 OWNER ROOT
    owner.json                             S 0600 (workspaces initially {})
    management.key                         S 0600 (32 bytes, trusted provisioner)
    endpoint.json                          S 0600 (daemon creates)
    hived.sock                             S 0600 (daemon creates)
  honeybee-exec-dev-data/                   S 0700 DATA ROOT
    config.json                            S 0600
    [daemon SQLite/WAL, endpoint/socket,
     runner hosts, captures, logs, cells]   S dirs0700/files0600
  honeybee-exec-dev-broker/                 S 0700 RECOVERY ROOT
    [journal SQLite/WAL, request tombstones] S 0600
  honeybee-exec-dev-state/                  S 0700 STATE ROOT
    attempts/                              S 0700
      [owner-minted attempt id]/           S 0700
        [private bridge state/control/evidence] S dirs0700/files0600
    inputs/                                S 0700 (approved content ids only)
  honeybee-exec-dev-home/                   S 0700 (empty service HOME)
/etc/honeybee-exec-dev/                     root:root 0755 CONFIG ROOT
  management-spki.sha256                    root:root 0644 PLACEHOLDER T1
  broker.json                              root:root 0644 PLACEHOLDER T1; no secrets
  credentials/                             root:root 0700 CREDENTIAL SOURCE ROOT
    broker-client.key                      root:root 0600 PLACEHOLDER trusted human
    broker-client.crt                      root:root 0600 PLACEHOLDER trusted human
    recovery.key                           root:root 0600 PLACEHOLDER trusted human
/run/credentials/honeybee-exec-dev-broker.service/ systemd-private credential copy
  broker-client.key, broker-client.crt, recovery.key (systemd credential semantics)
/opt/honeybee-exec-dev/                     root:root 0755 CODE ROOT
  bwrap/                                   root:root 0755
    0.12.0/bwrap                            root:root 0755 PINNED COPY
  releases/[reviewed digest]/               root:root dirs0755/files0644/exes0755
    [Node, daemon, broker, launcher, seccomp, manifests] NOT AVAILABLE
/etc/systemd/system/
  honeybee-exec-dev-daemon.service          root:root 0644
  honeybee-exec-dev-broker.service          root:root 0644
/etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules root:root 0644
```

The broker recovery root deliberately retains the sibling path in the governing
design. Bridge state never uses `/home/trmd/.local/state/urbench-v2`. No existing
trmd state is copied; approved immutable base/input objects need a separately
reviewed import and bootstrap recipe. No guest credentials, inference or lease code.

## Ordered T3 procedure (STOP at every failed verification)

These are proposed commands, not commands executed by T2. Run as trusted root
operator on metal-3 only after Queen GO and all gates above are closed. T3 must
record stdout/stderr and exit status after each block. Do not run a blanket script,
reuse an existing account/root, or chown an existing tree. Unexpected existence is
a stop requiring review. No `sudo` is needed inside these root-session blocks.
All rollback paths quarantine via rename, not deletion. Keep forensic data private.

### 0. Baseline LIVE and preflight (read-only, trmd session)

```sh
systemctl --user cat dev.honeybee.hive.v2.service
sha256sum /home/trmd/.config/systemd/user/dev.honeybee.hive.v2.service
systemctl --user show dev.honeybee.hive.v2.service -p MainPID -p ExecStart -p FragmentPath -p ActiveState
cat /proc/876498/stat
readlink -f /proc/876498/exe
systemctl list-unit-files '*honeybee*'
getent passwd honeybee-exec-dev
getent group honeybee-exec-dev
stat /var/lib/honeybee-exec-dev /var/lib/honeybee-exec-dev-data /var/lib/honeybee-exec-dev-broker /var/lib/honeybee-exec-dev-state /var/lib/honeybee-exec-dev-home /etc/honeybee-exec-dev /opt/honeybee-exec-dev
getfacl -p /dev/kvm
getent group kvm
```

Expected new names/paths absent (getent exit2/stat exit1). Other commands exit0.
Observed LIVE unit hash `4ec8d5be3b741c16f821634d26c81ef8d9c9e0412ea1504261f547a5bb36d32d`,
PID 876498, stat field22 birth ticks 294294967, active. ExecStart uses
`/home/trmd/.local/share/apiary-satellite/node-v24.21.0-linux-x64/bin/node`
and `/home/trmd/.apiary/honeybee-runtime/9dfc12437b3389a9b1849c3a06bdf17594bf4eeb635075a511cea6b701cc0ea3/lib/node_modules/honeybee/dist/cli.js v2 daemon run --data-dir /home/trmd/.hive/v2`.
Re-record at execution time; independent legitimate changes require rebaseline and
review, not an assertion of unchanged state. Keep output in T3's private proof.
Verify by reading the captured outputs before continuing. Rollback: none, read-only.

### 1. Locked identity

```sh
/usr/sbin/groupadd --system honeybee-exec-dev
getent group honeybee-exec-dev
/usr/sbin/useradd --system --gid honeybee-exec-dev --home-dir /var/lib/honeybee-exec-dev-home --no-create-home --shell /usr/sbin/nologin honeybee-exec-dev
getent passwd honeybee-exec-dev
/usr/sbin/usermod --lock honeybee-exec-dev
/usr/bin/passwd --status honeybee-exec-dev
id honeybee-exec-dev
```

Expected mutations silent exit0; new numeric UID/GID allocated by host (record them,
never assume a number). passwd status contains `L`; shell nologin, primary group
only, no sudo/kvm/trmd groups. Verify operator audit of sudoers/polkit grants and
that no login/SSH key/service-control access was created. Those policy-audit exact
commands depend on the host's operator rules; unresolved policy is a STOP, not PASS.
Rollback after all units stopped: `usermod --lock honeybee-exec-dev` and
`usermod --expiredate 1 honeybee-exec-dev`; verify `chage -l honeybee-exec-dev`
shows expiry. Retain locked UID/group to prevent reuse against retained data;
account/group deletion is not part of this rollback.

### 2. Protected roots

```sh
install -d -o honeybee-exec-dev -g honeybee-exec-dev -m 0700 /var/lib/honeybee-exec-dev /var/lib/honeybee-exec-dev-data /var/lib/honeybee-exec-dev-broker /var/lib/honeybee-exec-dev-state /var/lib/honeybee-exec-dev-home /var/lib/honeybee-exec-dev-state/attempts /var/lib/honeybee-exec-dev-state/inputs
stat -c '%a %U:%G %n' /var/lib/honeybee-exec-dev /var/lib/honeybee-exec-dev-data /var/lib/honeybee-exec-dev-broker /var/lib/honeybee-exec-dev-state /var/lib/honeybee-exec-dev-home /var/lib/honeybee-exec-dev-state/attempts /var/lib/honeybee-exec-dev-state/inputs
install -d -o root -g root -m 0755 /etc/honeybee-exec-dev /opt/honeybee-exec-dev /opt/honeybee-exec-dev/bwrap /opt/honeybee-exec-dev/bwrap/0.12.0
stat -c '%a %U:%G %n' /etc/honeybee-exec-dev /opt/honeybee-exec-dev /opt/honeybee-exec-dev/bwrap /opt/honeybee-exec-dev/bwrap/0.12.0
install -d -o root -g root -m 0700 /etc/honeybee-exec-dev/credentials
stat -c '%a %U:%G %n' /etc/honeybee-exec-dev/credentials
```

Expected silent mutation success, then exact modes/owners from layout. Verify no
ACL grants using `getfacl -p` on every created root; expected only owner rwx,
group/other --- on 0700 roots. Rollback after units stopped: quarantine each root
using the exact rollback block below. Do not recursively change ownership.

### 3. Pin bwrap without changing installed package

```sh
printf '%s  %s\n' 573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f /usr/bin/bwrap | sha256sum --check
install -o root -g root -m 0755 /usr/bin/bwrap /opt/honeybee-exec-dev/bwrap/0.12.0/bwrap
printf '%s  %s\n' 573236e5328ac2ebb08f59ae3a9805b4f8d12bdef14be8af4450d5463294985f /opt/honeybee-exec-dev/bwrap/0.12.0/bwrap | sha256sum --check
/opt/honeybee-exec-dev/bwrap/0.12.0/bwrap --version
namei -l /opt/honeybee-exec-dev/bwrap/0.12.0/bwrap
```

Expected two `...: OK`, bubblewrap 0.12.0, root-owned non-writable ancestors,
0755 binary. Launcher must verify this hash/canonical chain on an opened FD at
each launch; copying a pinned binary alone does not implement that check. Rollback:
quarantine `/opt/honeybee-exec-dev` after stopping DEV units; system bwrap untouched.

### 4. KVM service-only grant (gated policy choice)

Never add service to kvm. This grants a named-UID ACL and the systemd device policy
narrows devices separately. It does not revoke existing trmd KVM access and thus
cannot satisfy the original stricter claim without the operator's separate decision.
Do not add a trmd ACL. No uaccess TAG is added. Record the pre-change ACL as step0.

```sh
cat > /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules <<'RULE'
ACTION=="add|change", SUBSYSTEM=="misc", KERNEL=="kvm", RUN+="/usr/bin/setfacl -m u:honeybee-exec-dev:rw- /dev/kvm"
RULE
chown root:root /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules
chmod 0644 /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules
cat /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules
stat -c '%a %U:%G %n' /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules
udevadm control --reload-rules
setfacl -m u:honeybee-exec-dev:rw- /dev/kvm
getfacl -p /dev/kvm
id honeybee-exec-dev
```

Expected named user honeybee-exec-dev:rw-, original base entries preserved; service
only primary group. Reload silent exit0; does not trigger/recreate other devices.
On an approved reboot/device recreation, verify ACL persists before enabling runs.
Verify both actual service device open and actual Cell denied open under strict
policy; reduced policy records Cell success as accepted residual access. Exact
harness test and root-route closure must accompany the final GO revision.
Rollback: stop DEV, `setfacl -x u:honeybee-exec-dev /dev/kvm`; verify `getfacl -p
/dev/kvm` equals baseline; quarantine udev rule and `udevadm control --reload-rules`.
If other ACLs changed concurrently, preserve them and stop for operator review.

### 5. Runtime/configuration/credentials — STOP, unresolved artifacts

No runnable command is provided for an absent broker. The final GO revision must
replace this section with reviewed artifact digest, Node executable hash, installer
command, broker argv/schema, owner/config content, trusted credential provisioning
receipt and unit-install heredocs. T1 placeholder contract:

- root-owned `/etc/honeybee-exec-dev/management-spki.sha256` and `broker.json`;
- LoadCredential broker-client.key, broker-client.crt and recovery.key from the
  credential source root above, never Environment= secret values;
- owner file and 32-byte management.key remain in the service-owned owner root,
  matching existing externalAuthority.ts checks; operator must supply them, not T2;
- node `config.json` points `externalOwnerFile` to
  `/var/lib/honeybee-exec-dev/owner.json`; approved owner bridge pins above,
  `workspaces: {}` until all proofs pass. Never load the candidate file directly;
- daemon argv supported by source: pinned Node, immutable `dist/cli.js`, `v2`,
  `daemon`, `run`, `--data-dir`, `/var/lib/honeybee-exec-dev-data`.
  `loadNodeConfig` reads that root's config.json. The existing CLI cmdDaemon drops
  arbitrary --config when forwarding, so use the default data-root config path.
- broker argv: **UNDEFINED; implementation absent**. No fake `hive broker` command.

Only after these exact commands are reviewed may units be installed, verified with
`systemd-analyze verify`, then started. Activation must remain disabled. No start,
enable, registration or bridge command is authorized by this incomplete section.

## Required systemd unit body for the final artifact revision

These are reviewable **templates**, not install commands. Literal REQUIRES_* entries
are deliberately non-runnable. Replacing them needs a new Queen review; do not
substitute a Cell checkout or the LIVE runtime/current. No secrets in unit text.

Common daemon settings (broker differences immediately below):

```ini
[Unit]
Description=Honeybee external-exec DEV daemon
After=systemd-timesyncd.service

[Service]
Type=simple
User=honeybee-exec-dev
Group=honeybee-exec-dev
SupplementaryGroups=
UMask=0077
Environment=HOME=/var/lib/honeybee-exec-dev-home
Environment=PATH=/usr/bin:/bin
Environment=HIVE_V2_DATA_DIR=/var/lib/honeybee-exec-dev-data
WorkingDirectory=/var/lib/honeybee-exec-dev-data
ExecStart=/opt/honeybee-exec-dev/releases/REQUIRES_DIGEST/node /opt/honeybee-exec-dev/releases/REQUIRES_DIGEST/dist/cli.js v2 daemon run --data-dir /var/lib/honeybee-exec-dev-data
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=no
DevicePolicy=closed
DeviceAllow=/dev/kvm rw
ReadWritePaths=/var/lib/honeybee-exec-dev /var/lib/honeybee-exec-dev-data /var/lib/honeybee-exec-dev-state
InaccessiblePaths=/etc/honeybee-exec-dev/credentials /var/lib/honeybee-exec-dev-broker
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectClock=yes
ProtectControlGroups=yes
ProtectProc=invisible
ProcSubset=pid
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_UNIX
Delegate=no
KillMode=control-group
TimeoutStopSec=60
SendSIGKILL=yes
Restart=on-failure
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Broker uses the same User/Group, umask, filesystem/kernel/capability protections,
ProtectProc and process limits, with these replacements/additions:

```ini
[Unit]
Description=Honeybee external-exec DEV broker
After=honeybee-exec-dev-daemon.service systemd-timesyncd.service
Requires=honeybee-exec-dev-daemon.service

[Service]
WorkingDirectory=/var/lib/honeybee-exec-dev-broker
ExecStart=REQUIRES_REVIEWED_BROKER_ARGV
ReadWritePaths=/var/lib/honeybee-exec-dev-broker
InaccessiblePaths=/etc/honeybee-exec-dev/credentials /var/lib/honeybee-exec-dev-state /var/lib/honeybee-exec-dev-data
PrivateDevices=yes
DevicePolicy=closed
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LoadCredential=broker-client.key:/etc/honeybee-exec-dev/credentials/broker-client.key
LoadCredential=broker-client.crt:/etc/honeybee-exec-dev/credentials/broker-client.crt
LoadCredential=recovery.key:/etc/honeybee-exec-dev/credentials/recovery.key
```

Broker reads owner root and uses management socket; it never needs public data or
bridge state. Systemd credential source is hidden while systemd supplies private
credential copies. Current same-UID daemon/broker share a trust domain; do not claim
separation between those two. Sandbox separation from both is mandatory.

| Setting | Purpose / compatibility condition |
| --- | --- |
| User/Group/no supplementary groups | Stable locked UID, no trmd/sudo/kvm inheritance. Verify actual process groups. |
| UMask=0077 | Private new files; validate sockets and SQLite/WAL explicitly. |
| NNP/empty capabilities/RestrictSUIDSGID | Exec cannot gain privileges via setuid/caps. Applies to every service descendant. |
| ProtectSystem=strict + ReadWritePaths | Root-owned code/config read-only; writes confined to declared roots. Doesn't hide readable keys: separate mounts/permissions do that. |
| ProtectHome=yes/PrivateTmp | Hide account homes and isolate temporary namespace; no bind of trmd home. |
| DevicePolicy/DeviceAllow | Daemon may use KVM only alongside ACL; cgroup device policy is a second check, not a substitute for ACL. Broker PrivateDevices hides host devices entirely. |
| PrivateDevices=no on daemon | Required for actual /dev/kvm; bridge receives only this host device via its sandbox. |
| RestrictAddressFamilies | Daemon local RPC only. Broker filesystem Unix RPC plus direct outbound mTLS. AF_UNIX must be denied in bridge seccomp, not in daemon. No TCP/abstract listener allowed by broker policy. |
| ProtectKernel*/ProtectClock/ControlGroups | No global sysctl/module/log/time/cgroup changes. No privileged bypass. |
| ProtectProc/ProcSubset | Reduce cross-UID proc exposure inside service; not a host-wide hidepid change. Verify Node/process identity introspection works. |
| RestrictRealtime/LockPersonality | Prevent RT abuse and ABI switching; verify compatibility. |
| KillMode=control-group | DEV unit stop must reap its descendants, never LIVE; service shutdown may be destructive to DEV attempts and must record uncertainty first. |
| Delegate=no | Service cannot write arbitrary host cgroups. Per-attempt cgroup ownership needs a separately reviewed constrained root/systemd helper; unavailable today. |

Do NOT add MemoryDenyWriteExecute (Node/V8 JIT), RestrictNamespaces=yes or a broad
SystemCallFilter that breaks bwrap/QEMU before compatibility proof. NNP does not
block unprivileged userns when enabled. Broker could later restrict namespaces,
but that is not assumed proven. The proposed per-attempt helper must preserve
ProtectControlGroups and have no generic command or service-control interface.

## Sandbox argv contract (future launcher; NOT a shell command)

The final launcher builds an argv array, never a shell string, for **every**
start/wait/stop/reconcile. This is the required shape, not a claim it exists:

```text
/opt/honeybee-exec-dev/bwrap/0.12.0/bwrap
 --unshare-all --die-with-parent --new-session --cap-drop ALL
 --disable-userns --assert-userns-disabled
 --clearenv
 --setenv PATH /usr/sbin:/usr/bin:/sbin:/bin
 --setenv LANG C.UTF-8 --setenv LC_ALL C.UTF-8
 --tmpfs /
 [--dir parent, --ro-bind-fd verifiedFD exactInventoryPath,
  --symlink pinnedTarget inventorySymlink, in validated dependency order]
 --proc /proc --dev /dev --dev-bind /dev/kvm /dev/kvm
 --tmpfs /tmp --tmpfs /run --tmpfs /home
 --tmpfs /var/lib/honeybee-exec-dev
 --tmpfs /var/lib/honeybee-exec-dev-data
 --tmpfs /var/lib/honeybee-exec-dev-broker
 --tmpfs /etc/honeybee-exec-dev/credentials
 --tmpfs /run/credentials
 --bind-fd privateAttemptStateFD /state
 [--ro-bind-fd approvedImmutableInputFD /inputs/contentDigest]
 --chdir /state
 --seccomp reviewedFilterFD
 -- /exact/pinned/bridge/path {start|wait|stop|reconcile} --manifest -
```

Create all target parents under the empty tmpfs root before child mounts. No
ro-bind `/`, `/usr`, `/etc`, `/opt` or whole bridge install directory. Inventory
expansion includes every verified files.json entry plus payload.sha256's complete
project closure (manifest files, project-files.list, scripts, firmware and runtime
libraries). Deduplicate and preserve exact pinned aliases/symlinks; reject unsafe
links/mounts. `--ro-bind-fd` is supported by observed bwrap 0.12.0. Only verified
opened objects cross the launcher; reopen-by-path must not reintroduce replacement
races. Final executable FD exec/interpreter mapping must be implemented and proven;
the illustrative pathname tail above is not that proof. Keep bridge's absolute
install paths unchanged. Dispatch stateDir is `/state`; its host mapping is the
owner-created private attempt directory, not the management root. Existing base
state/input population and repeat wait/stop/reconcile mapping need reviewed code.

`--unshare-all` includes network, PID, user, IPC, UTS and cgroup namespaces; no
`--share-net` fallback. Private `/proc` must enumerate only sandbox processes.
`--dev` creates synthetic devices; `/dev/kvm` is the only real host device. No
host /dev, /sys, cgroup, socket or account mount. Bridge seccomp must deny AF_UNIX
socket and socketpair creation (including abstract sockets), preserve inherited
pipes, deny network use in no-inference mode, and cover compat ABIs. A namespace
alone does not enforce socket prohibition. Filter bytecode/hash and required
QEMU compatibility tests are absent and block startup.

Mounting empty tmpfs roots is defense in depth; the empty-root inventory excludes
all alternate paths to secrets, credential copies, owner/data/recovery and homes.
No service HOME, management FD, recovery FD, key FD or socket may cross. Close all
non-allowlisted FDs at broker -> daemon -> runner -> bwrap -> bridge boundaries;
private stdin carries dispatch/fence. Verify FD listings and CLOEXEC exclusions.

Each attempt needs its own protected systemd/cgroup-v2 identity binding. Existing
pgid stop tests are insufficient after --new-session/PID namespaces. Stop protocol,
leader-exit escalation, bwrap death, daemon restart and uncertain teardown must
prove no survivors or durable reconcile_required. Unit-level cgroup cleanup is not
per-attempt reconciliation and does not satisfy this gate.

## Final acceptance and LIVE invariant

The GO revision must supply exact runnable acceptance commands for its installed
artifact and actual UIDs/PIDs. Minimum tests: service identity/lock/groups; ordinary
Cell cannot read roots or credentials, connect management socket, signal/ptrace or
read service environ/mem/fd/root; no escalation route; actual service KVM open and
chosen Cell KVM behavior; all effective hardening settings; no TCP/abstract
listeners (enumerate all service descendants with `ss -lxp`, `ss -ltp` from trusted
operator); broker's only network channel is outbound pinned mTLS. No secrets in
argv/env/logs. Invalid pin, time skew/unhealthy clock, nonce replay after restart,
changed actor/body, unauthorized operation and fake/copied caller claims refuse
before effects. Test actual approval path, no guest credentials or inference.

Sandbox positive/negative tests must enumerate mounts, devices, FDs and PID view,
try all secret path aliases and AF_UNIX socket creation, re-prove FD replacement
and interpreter closure, kill/restart/reconcile through real QEMU with all session
and cgroup descendants accounted for. No such result is claimed here.

After every action block, repeat step0's LIVE unit hash/show and PID/birth checks
as trmd. At the end, repeat all of step0 and compare exact unit text/hash,
ExecStart/artifact, MainPID+birth and active state. Also run ordinary read-only
`hive` status against LIVE using its existing CLI/target (never service DEV args).
Do not compare a hash of LIVE SQLite: normal concurrent activity changes it.
A changed PID/birth or unit means STOP and investigate; do not restart LIVE to
restore appearances. DEV units must have distinct system cgroups and roots.

## Rollback (trusted root, only paths this plan created)

Do not execute rollback until actual unit installation occurred and T3 records
which steps completed. Never stop a wildcard or the trmd user unit. Before any
stop, future broker must suspend admissions and durably reconcile/stop its own
attempts; exact command is blocked on broker implementation. If teardown uncertain,
keep state and report; do not enable replacements. On no-attempt bootstrap rollback:

```sh
systemctl stop honeybee-exec-dev-broker.service honeybee-exec-dev-daemon.service
systemctl is-active honeybee-exec-dev-broker.service honeybee-exec-dev-daemon.service
systemctl disable honeybee-exec-dev-broker.service honeybee-exec-dev-daemon.service
systemctl is-enabled honeybee-exec-dev-broker.service honeybee-exec-dev-daemon.service
```

Expected inactive (is-active exit3), disabled (is-enabled exit1); absent units may
report not-found, record explicitly. Verify `systemctl show` ControlGroup and
trusted process inventory find no DEV survivors. Never signal guessed PIDs or
unrelated sessions. Units did not exist initially; quarantine only newly created
unit files, never an existing file. Commands below require destinations absent:

```sh
mv -T /etc/systemd/system/honeybee-exec-dev-broker.service /etc/systemd/system/honeybee-exec-dev-broker.service.T2-rollback
mv -T /etc/systemd/system/honeybee-exec-dev-daemon.service /etc/systemd/system/honeybee-exec-dev-daemon.service.T2-rollback
systemctl daemon-reload
systemctl list-unit-files 'honeybee-exec-dev-*.service'
setfacl -x u:honeybee-exec-dev /dev/kvm
getfacl -p /dev/kvm
mv -T /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules /etc/udev/rules.d/70-honeybee-exec-dev-kvm.rules.T2-rollback
udevadm control --reload-rules
mv -T /var/lib/honeybee-exec-dev /var/lib/honeybee-exec-dev.T2-rollback
mv -T /var/lib/honeybee-exec-dev-data /var/lib/honeybee-exec-dev-data.T2-rollback
mv -T /var/lib/honeybee-exec-dev-broker /var/lib/honeybee-exec-dev-broker.T2-rollback
mv -T /var/lib/honeybee-exec-dev-state /var/lib/honeybee-exec-dev-state.T2-rollback
mv -T /var/lib/honeybee-exec-dev-home /var/lib/honeybee-exec-dev-home.T2-rollback
mv -T /etc/honeybee-exec-dev /etc/honeybee-exec-dev.T2-rollback
mv -T /opt/honeybee-exec-dev /opt/honeybee-exec-dev.T2-rollback
stat -c '%a %U:%G %n' /var/lib/honeybee-exec-dev.T2-rollback /var/lib/honeybee-exec-dev-data.T2-rollback /var/lib/honeybee-exec-dev-broker.T2-rollback /var/lib/honeybee-exec-dev-state.T2-rollback /var/lib/honeybee-exec-dev-home.T2-rollback /etc/honeybee-exec-dev.T2-rollback /opt/honeybee-exec-dev.T2-rollback
usermod --lock honeybee-exec-dev
usermod --expiredate 1 honeybee-exec-dev
passwd --status honeybee-exec-dev
chage -l honeybee-exec-dev
```

Run only rollback lines for completed actions; each mv expects silent exit0,
follow with `test ! -e ORIGINAL` and `stat DESTINATION` before next move. Preserve
modes/owners, owner roots remain0700. Root config parent stays0755 with credential
child0700; revoke client pin/cert through trusted management (exact T1 command
pending) before rollback counts complete. Retained secrets are not securely erased.
The service identity remains locked/expired so retained private files cannot be
claimed by a reused UID. Verify KVM ACL equals captured baseline and udev rule is
inactive; existing trmd permissions/groups and pinned /opt/urbench-v2 remain
unchanged. Re-run LIVE invariant checks; no runtime deploy or restart.

## Review and validation record

T2 used honeybee-core-work, astack-principles (idempotency, shared-state ownership,
real verification and sequencing), technical-writing and show-me-your-work.
No repository verification skill is installed: setup gap reported to orchestrator.
A local decision trail is retained outside the change; only this document is
committed. Build/typecheck/targeted tests validate the unchanged source baseline,
not the future broker, hardening compatibility or host provisioning.

Read sources: external-exec-owner-isolation.md, external-exec-dev.md,
externalAuthority.ts, config.ts, main.ts, CLI cmdDaemon/serviceExecArgs,
driver-cell sandbox.ts; Project handoff/65313bbb.md and prior session response.
Queen's early review requires the privilege/KVM choices above remain Tormod's call.
The handoff says human per-run approval was selected; stale design text saying
choice pending is not new authority for implementation. T1 owns that layer.

# Dedicated executor host proposal

**Decision requested: choose option A (recommended) or B; no purchase or provisioning
is authorized by this proposal.** Tormod chose a dedicated host/VM at 04:05Z on
2026-10-22 (Queen relay, questions a0c2b850 → 7e00e0df). The executor must be outside
all agent-controlled administration. A VM on metal-3 fails that requirement while
trmd can administer its host. **Drop metal-3 steps1–3 entirely**, including dormant
UID/directories/bwrap preparation. Its LIVE daemon, trmd privileges, KVM, units and
storage stay unchanged. The earlier [metal-3 plan](external-exec-metal3-provisioning.md)
is historical evidence, not authority to provision there.

## Two concrete options and cost

Prices checked against official sources on 2026-10-22; taxes/FX excluded. Reconfirm
availability, invoice currency and final checkout total before buying. No account,
quote request, order, key, host or VM was created. Labor estimates below are our
planning estimates, not vendor quotes or the cost of the whole approval project.

| Option | Specification and recurring cost | Setup and tradeoff |
| --- | --- | --- |
| **A — Hetzner AX42-1 physical server, Helsinki** | Ryzen7 PRO8700GE,64GB RAM,2×512GB NVMe. Published server €97.30/month + primary IPv4 €1.70 = **€99/month**. Storage included; mirror the disks, do not add capacities. | **€49 vendor setup**, first month €148 before tax. Human installation estimate1day plus Ur Bench repin/T8 work below. Physical KVM, no nested layer; provider hardware/console remains trusted. |
| **B — Google Compute Engine n2-standard-8, us-central1 (Iowa)** | Intel8vCPU/32GiB, nested virtualization enabled,300GiB pd-balanced total. At730h: compute $0.388472/h×730=$283.58456; disk $0.000136986/GiB-h×300×730≈$30; IPv4 $0.005/h×730=$3.65. **About $317.24/month**, plus transfer/snapshots/taxes. | On-demand, no upfront commitment/setup fee in the rate card. Human setup estimate1day; additionally budget1–2days for nested-KVM acceptance, not a performance promise. Cloud IAM/console and hypervisor are trusted; never grant agents project or instance control. |

A's CPU/RAM/storage are from the [AX42 configurator](https://www.hetzner.com/dedicated-rootserver/ax42/configurator/),
its non-limited AX42-1 rate/setup from the [June2026 price schedule](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/),
and IP charge from [IP pricing](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/).
The [dedicated-server guide](https://docs.hetzner.com/robot/dedicated-server/getting-started/root-server-guide/)
states1Gbit servers include unlimited traffic. This quote excludes optional backup
storage, managed service and VAT; no promotional/auction/limited price assumed.
Ask provider to confirm BIOS virtualization is available before accepting the order;
a remote console called “KVM” is not proof of Linux `/dev/kvm`.

B uses [Google's N2 rate card](https://cloud.google.com/products/compute/pricing/general-purpose),
[balanced disk rates](https://cloud.google.com/compute/disks-image-pricing), and
[in-use IPv4 pricing](https://cloud.google.com/vpc/network-pricing).
No free tier, sustained-use discount or commitment is assumed. Month length changes
compute/IP cost; disks persist and bill while compute is stopped. Limit exported
evidence to10GiB/month initially, obtain the destination-specific transfer quote
before selecting B, and set a billing alert (an alert is not a hard spend cap).
Off-host backup, extra admin hardware/FIDO2 key, approved Mac hardware and operator
labor are additional, unquoted costs; use existing suitable human-only devices if
available, otherwise obtain Tormod's budget before ordering. Neither monthly figure
prices T1's Mac approval topology or its engineering work.

## KVM and what Ur Bench must rebuild

A runs QEMU/KVM directly on physical x86-64 hardware. Verify firmware exposes svm,
kvm_amd is active, `/dev/kvm` exists and a no-inference guest boots under the final
service/sandbox before acceptance. This is expected capability, not a test already
run. B runs Ur Bench as an L2 guest inside an L1 Google VM; explicitly enable
nested virtualization and ensure organization policy allows it. Google documents
Linux KVM support and warns of10% or more CPU-bound slowdown, potentially more
for I/O. Do not replace KVM with TCG or relax deadlines when extensions are absent.
Re-measure deadline, snapshot, stop/reconcile and CPU feature compatibility.
[Google nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview),
[enablement procedure](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/enabling).
Hetzner Cloud VMs are excluded: its [FAQ](https://docs.hetzner.com/cloud/servers/faq/)
says nested virtualization is unavailable.

**The three metal-3 FINAL hashes are not transferable authority.** Ur Bench must
build/install a fresh root-owned closure on the chosen host, produce a new FINAL
executable/files.json/payload.sha256 trio and reviewed root-chain inventory, then
have Queen verify it independently. Even unchanged Ur Bench source may resolve
different distro/Python/QEMU/firmware/library files. Preserve approved absolute
install paths or rebuild the embedded paths. Rebuild/bootstrap guest base disks,
profile/fingerprint/snapshot and no-inference input identities; account for CPU
vendor/features on A versus Intel virtual CPU on B. Rehash the pinned bwrap,
Node/daemon/broker/dispatch-builder, seccomp and sandbox policy artifacts too.
Never copy old trmd-owned state or secrets. Estimate2–3 engineer-days for repin and
basic guest compatibility after artifacts exist; T8/security implementation is
separate and may take longer. Existing T1 design PASS is not a runnable installer.

## Administration and agent network path (same rule for A and B)

Tormod alone owns provider billing, console/rescue/reset/IAM, DNS and executor
administration, from a human-only account/device. Use a FIDO2
`sk-ssh-ed25519` key requiring user verification and physical presence; agents
create **no accounts or keys**. Server SSH accepts only that public key for a
separate human admin account, enforces verification, disables passwords/root
login/agent and TCP forwarding, and is network-restricted to the human device.
No SSH CA, recovery password, cloud API token, browser console session, sudo cache,
Tailscale SSH route or provider reset capability is available to trmd or any agent.
Keep emergency provider access on the same human-only side. No harness/Cell runs
on this executor; service UIDs are locked/nologin, no generic shell/job endpoint.
For B: separate human-controlled project; no agent-accessible owner/IAM role,
instance SSH metadata mutation, serial console, service-account token or attached
privileged service account. No startup-script or disk/snapshot control delegated
to agents. For A: same prohibition applies to Robot API/rescue/console credentials.

```text
metal-3 / Studio agent → untrusted proposal/status/wait/stop intake in normal Apiary
                       → protected T1 management service / human approval UI
                       ⇄ direct pinned mTLS channel initiated OUTBOUND by broker
new executor: broker → owner-local Unix management RPC → dedicated daemon
                     → long-lived per-attempt runner → bwrap → bridge/QEMU
human-only device → restricted FIDO2 SSH / provider console (separate admin path)
```

There is **no agent-to-broker TCP listener** and no routed path to the daemon's
private Unix socket. Agents can submit untrusted proposals and scoped T1 control
handles through Apiary; they cannot obtain approval/client TLS keys, choose host
paths, start/retry without human approval, administer the executor or invoke a
generic RPC. Same-UID sharing of control handles is a disclosed T1 limitation,
not actor identity authentication. No host directory is mounted back into Cells.
Evidence returned is bounded/untrusted and never includes fences or secret paths.

Use a human-owned executor tailnet identity/ACL: broker may reach only the protected
management listener; SSH only from the human admin device; metal-3/Studio agent
identities cannot reach executor admin ports. Disable tailnet SSH, exit-node and
subnet-router roles. Tailnet reachability is transport, never authority: TLS1.3
pins, cert validation and T1 approval still apply even if agents manipulate their
own tailnet nodes/routes. The human pins the exact management endpoint/port in the
final network manifest and root config; this proposal does not invent an open port.
Permit only necessary protected NTS/time, approved package/bootstrap endpoints
and tailnet control traffic; no guest external network/inference. Freeze production
egress after bootstrap. Never reuse a tailnet/cloud admin credential from an agent
account. A provider/control-plane compromise remains outside this boundary.

## Storage/inode budget and retention

metal-3 measured875G root,807G used,24G free (98%); /tmp638250/1048576 inodes used
(61%). Those are host pressure readings, **not a measurement of Ur Bench guest
size**. Its1913-file bridge/runtime inventory is not a whole VM-disk capacity
estimate. Leave that host alone. Both options reserve a **256GiB dedicated ext4
service filesystem mounted at /srv/honeybee-exec**, with all owner/store/broker/state roots
as siblings there (parent0700, owner0700, store/v2 separate from owner); OS has at least40GiB separately. For A, mirrored512GB disks
provide roughly476GiB before partition overhead; for B use44GiB OS+256GiB service
within the quoted300GiB. These allocations are proposed, not measured/installed.

| Enforced service allowance | Bytes | Inode allowance |
| --- | --- | --- |
| Immutable guest/base/input objects (private service-owned inputs) |96GiB |500000 |
| At most2 active attempts, each32GiB writable state/evidence |64GiB |200000 each |
| Completed evidence, maximum7days |16GiB |150000 |
| Quarantine, maximum7days |8GiB |100000 |
| Broker recovery/security audit/operational logs |8GiB |50000 |
| **Aggregate hard service quota** |**192GiB** |**1200000** |
| Filesystem reserve, inaccessible to service quota growth |64GiB |At least20% free |

Use ext4's on-disk user/project quota features from initial format
(`mkfs.ext4 -O quota,project`, with user and project quota accounting enabled and
at least2000000 inodes). This is an option specification, not a command to run on
an unknown device. Final human plan names the verified empty partition/LV, exact
quota-type settings and mount flags for the installed e2fsprogs version. Set the
service UID hard aggregate quota to192GiB/1200000inodes; each attempt subtree has
an inherited project ID and32GiB/200000inode hard project quota. Prove writes
fail at both levels and no uncharged sibling/bind target exists. OS /var/lib
stays on the OS filesystem, never this volume.

Human sets kernel-enforced UID/project quotas (including runner/state/journal writes),
per-attempt byte/inode limits and bounded tmpfs/cgroup memory; verify exhaustion
fails closed. Never treat sparse qcow virtual capacity as reserved physical space.
Actual guest bootstrap+two worst-case attempts must fit these budgets before
admission; otherwise resize/reprice or lower concurrency, never silently borrow
reserve. Halt admission below64GiB filesystem free or20% free inodes, on quota
exhaustion or on missing measurements. OS stops admission below20GiB free. Fresh
format needs at least2million inodes; verify `df -i`, not just a format default.

Per attempt use cgroup-v2 CPUQuota=200% (two CPUs), MemoryHigh=3GiB,
MemoryMax=4GiB, MemorySwapMax=0 and TasksMax=256; maximum2 attempts. These are
initial proposed limits to validate with the rebuilt base, not measured needs.
Broker/daemon combined budget2GiB RAM and1CPU; reserve at least8GiB RAM for OS
and page cache even on B's32GiB. Each sandbox gets at most256MiB combined tmpfs
and10000tmpfs inodes, included in its memory limit; bound mount size/nr_inodes
and memory together, never trust mount capacity alone. If bwrap cannot express
the inode bound, the reviewed supervisor must create the bounded mount; missing
enforcement blocks admission. OOM/CPU throttling must settle uncertainty safely.
DEV journald namespace has SystemMaxUse=1GiB and RuntimeMaxUse=256MiB, within the
8GiB logging/recovery budget; the namespace's persistent files are on the service
volume via an explicit reviewed mapping and accounting project. No host journald
change. Separate30day security audit cannot silently rotate away on namespace cap;
suspend admission before required retention exceeds its budget. Final installer
must prove byte/inode/tmpfs/log exhaustion without affecting OS logs.

A32GiB per-run cap includes disk growth, artifacts and1GiB evidence (raw capture
16MiB/stream); no run exceeds30minutes, maximum2 active globally. Retain security
audit30days and operational logs7days within8GiB; suspend if retention cannot fit.
Keep request-ID tombstones for the broker identity's lifetime (T1), not just7days.
Uncertain teardown retains state/quota. Cleanup is human-authorized, exact attempt
IDs with terminal receipt+verified no survivors; move to protected trash first,
then separately authorized disposal. Trash still counts against quota. No silent
FIFO deletion, host-wide cleanup or shared journald policy change. Optional off-host
sealed backups require human-only storage identity, a priced retention policy and
recovery proof; no backup service is purchased here.

## Mapping approved T1 and required acceptance

Use the security design at **74939e8d27798b31772dbe664cec0ed5bdd94ebc** on
`review/external-exec-approval-design`; its relative document path overlaps an older
file on this branch, so read that exact commit, not this branch's stale copy.
Three roles remain separate: protected Mac Secure Enclave approval key, Mac server
TLS key and new broker client TLS key. Human enrols the new broker identity/pins
both ways and revokes any prior candidate identity; approval body binds new host,
all artifact/sandbox digests and canonical job. Fresh60second, single-use human
approval; durable nonce/preparation consumption before effects; actor/workspace
scoped handles and idempotency recovery remain unchanged. Relocating the executor
does not solve T1's separate Mac protected-UI/admin/boot gates; those still apply.

Replace T1's literal “metal-3” time-provider location with the new executor.
Require reviewed chrony/NTS, two independent authenticated sources, protected health
adapter, <=5second conservative uncertainty and <=5second sample age, disagreement
and realtime-step detection; preparation/consume/dispatch fail closed. Do not infer
health from timedatectl alone or modify macOS timed. Broker deadline remains active
when management transport is locked/down. Exact service installer, NTS endpoints,
quota commands and network manifest need Queen review on the chosen host first.

T8 then proves from **real metal-3 and Studio Cells**, which retain their local
root capabilities, that those capabilities cannot read executor state/keys, SSH,
reach control-plane APIs, change disks/boot metadata, signal/ptrace executor, or
forge approval. On executor prove UID/device ACL/cgroup/FD/mount boundaries,
private network/PID namespaces, private QMP Unix sockets only, no host socket
access, no guest credentials/inference. Keep one long-lived sandbox per attempt;
later control enters its user/mount/PID namespaces and forks. Runner parent is
re-adoptable PID+birth/boot under daemon KillMode=process; re-prove PDEATHSIG parent
thread behavior with Node, FD exec, stop escalation, crash/restart/reconcile and
uncertain quota hold. Test unauthorized proposals, expiry/body mutation, replay
across broker crash, clock loss and approval pin revocation. Queen source+T8 PASS
precedes the first real approved no-inference run. No deployment of LIVE follows.

## Recommendation and Tormod's written procedure

**Recommend A: AX42-1 in Helsinki, €99/month plus €49 setup before tax.** It removes
nested-KVM overhead/feature uncertainty, has enough local mirrored storage for the
proposed quotas, and costs less at continuous operation. B is a concrete fallback
if hourly teardown or cloud policy control is worth its higher running cost and
nested-KVM validation. No third candidate improves this decision enough to warrant
an unverified hardware quote. Hardware FIDO2 and the human admin device are shared
prerequisites, not reasons to administer either option from an agent session.

Tormod performs these steps himself; agents may supply reviewed documentation and
public fingerprints only. This is a bounded human procedure, **not an executable
root script**: missing signed artifacts/installer mean STOP, never invent a command.

1. After Queen reviews this exact proposal, choose A explicitly and approve the
   checkout budget. From the human-only device/account, verify current AX42-1
   Helsinki price/specification/availability, tax and cancellation terms; confirm
   Linux hardware virtualization with provider. If changed, bring the quote back
   to Queen before ordering. Do not select Hetzner Cloud or place a VM on metal-3.
2. In the human-only provider console, create/select a human-owned account with
   strong MFA/recovery independent of agent sessions; order exactly A and primary
   IPv4 only. No API credential is copied to an agent. Name the host
   `ur-exec-dev-1`; disclose only its nonsecret identity/address for the final plan.
3. On the human-only device, enrol/verify the physical FIDO2 SSH key with UV+touch
   and offline human-held recovery. Use provider trusted console/rescue access to
   verify initial host SSH fingerprint out of band and install Debian13 x86-64.
   Before installation, verify the Debian13 amd64 ISO's SHA512 against its signed
   SHA512SUMS and verify SHA512SUMS.sign with an independently trusted Debian CD
   signing key; record image version/hash and signing fingerprint. Follow
   [Debian image verification](https://www.debian.org/CD/verify). Do not trust a
   filename, provider image label or checksum downloaded without signature trust.
   Mirror the two disks, allocate >=40GiB OS and256GiB /srv/honeybee-exec with quotas and
   >=2million inodes; keep remaining capacity unallocated/reserved. No shared
   home, mount, backup key or control-plane token from metal-3/Studio is imported.
4. Create the human admin account using console, install only its verified public
   FIDO key, enforce UV/presence, prohibit passwords/root SSH and forwarding, then
   restrict provider+host firewall to the human admin device. Verify a second
   human login works before closing bootstrap access. Retire bootstrap passwords
   and test agent SSH/control-plane denial; no harness/agent login is installed.
5. Record read-only hardware/OS/KVM, UID/group/sudo/polkit, clock and storage receipts.
   Set the human-owned tailnet policy above, no Tailscale SSH; verify metal-3 and
   Studio cannot administer it. Send Queen only public fingerprints and findings.
   **STOP** if KVM is absent, agent control exists or disk/inode budgets do not fit.
6. Obtain Ur Bench's new host build/guest base and FINAL pin trio, plus reviewed
   immutable Honeybee/Node/broker/bwrap/supervisor/time/quota installer manifests.
   Have Queen independently verify the closure and exact human installation plan.
   If any installer/entry point is absent, stop here: the current repository does
   not implement broker/supervisor/approval code. Do not copy mutable Cell output.
7. Only after that exact-plan GO, run the signed/reviewed installer yourself. It
   creates locked service UID/private0700 roots,0600 keys via protected enrollment,
   device ACL and quota-limited system units; enables no admission yet. Record
   effective hardening, broker-only outbound network, time health and retention.
   Provision keys yourself through approved T1 flow, never through agent terminals.
8. Complete T1's human-only Mac setup and pin enrolment for this broker identity.
   Queen checks source and operators execute T8 with safe test fixtures, including
   cross-host admin-denial and KVM tests. Leave admission off until every required
   proof passes; then approve one no-inference attempt in the protected UI.
9. If acceptance fails, disable admissions, reconcile/stop verified DEV attempts,
   preserve private evidence/quota and revoke new broker pins/credentials using
   the human-only flow. With no survivors, cancel the new server in provider console
   if abandoning it; sanitize disks under human policy. Never “rollback” by changing
   metal-3. Reinstallation/new identity requires new pins and approvals.

No steps above were executed. The historical check/build/v2check/18 targeted tests
passed before this document-only retarget; they prove none of this future host.
Current validation is source/price review, cost/budget arithmetic and diff check.

Proposal check: Claude Opus5.5 session a4efa8fd independently passed58667a57
as proposal-only (report15133b82); follow-up clarifies service mount/quota/log
accounting, CPU/RAM/tmpfs limits and OS-image verification. No host was touched.

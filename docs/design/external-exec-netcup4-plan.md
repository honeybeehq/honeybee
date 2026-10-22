# netcup-4 executor consideration — BLOCKED / CANCELLED

Netcup-4 stays in the regular satellite pool. Do not drain, alter accounts, revoke
access, install an executor or change its services. Queen/orchestrator redirected
T2 at04:24UTC on2026-10-22 after confirming the nested-KVM blocker. No separate
netcup-4 provisioning proof is sought; this note is folded into the metal-host
comparison. Nothing on netcup-4 was changed except the explicitly authorized probe
session/Cell creation and stop of that exact probe.

The [official netcup server FAQ](https://www.netcup.com/en/helpcenter/documentation/server),
observed updated19Oct2026, says SVM is disabled and cannot be activated. The
read-only guest reports KVM virtuality and16CPU flag rows with svm0/vmx0. Thus its
hypervisor is not exposing the virtualization extensions required for nested
KVM. This says nothing about the provider's physical hardware. No TCG, containers,
changed bridge contract or relaxed deadlines substitutes for the required KVM.

The probe itself had remapped uid/gid1000→0,NoNewPrivs1 and synthetic /dev/tmpfs,
so missing /dev/kvm, absent module parameter files and mapped sudoers ownership
were **not** used to assert host device/ACL or effective privilege facts.
Its actual host KVM permissions remain unobserved; the independent CPU/provider
constraint is enough to stop the proposal.

Read-only sample04:19–04:21UTC: Debian13.6; DMI netcup/KVMServer;16guest vCPUs
EPYC9645model;62GiB RAM/43GiB available;2.0Troot/1.6Tfree17%used;120895906free
inodes/133096000,10%used;167Cell directories. Default daemon view49active bee
records (47stopped,1idle,1runningprobe), all-history229 (180archived). One
transient probe is included; authenticated agent_get confirmed it stopped.
Cell contents were never opened. Storage is ample for planning, not a reservation
or measured guest-base fit. Billing owner/SKU and effective host sudo are unknown.

Existing dependencies remain serving: userapiaryd/hive/nectard and sweep timer;
Nectar remote `ls` found21envs,12serving; app/database ports including5432 and
unknown pool/trigger/cron dependencies. No preview TTL was extended, no producer
was disabled and no work was moved. Existing previews and satellite access remain.
Full read-only outputs and the partial inventory are preserved in T2 proof/Project
`provisioning/server-inventory.md`. Probe b287ace8-09f8-4373-8376-593c670cd3c5 and
all three earlier netcup probes were stopped through exact own-session control.
No other process was stopped. There is no drain/provisioning rollback to execute.

Next decision compares a dedicated metal host versus the sourced AX42 option in
[the current host proposal](external-exec-host-proposal.md). Any new target still
needs human-only administration, no agent control, fresh FINAL Ur Bench pins and
Queen's exact-plan/source/T8 reviews. This note authorizes none of them.

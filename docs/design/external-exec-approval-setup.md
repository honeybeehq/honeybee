# Human-only setup for external-exec approval

This is a proposed operator procedure, not executable provisioning authorization.
Tormod performs it himself after Queen approves the design and an exact artifact
and provisioning plan. Agents never generate keys, run security/keychain commands
on Macs, receive admin passwords or operate the management login session. No
reviewed approval helper/broker installer exists today. Stop at that prerequisite;
these steps specify what its reviewed enrollment UI must do, not invented CLI
commands. DEPLOY HOLD and the no-inference phase-1–2 limit remain.

Before any approval feature code, complete **Phase 0** from a human-only admin
account: record Studio `trmd` admin/sudoers/cached authorization; TCC Accessibility,
Screen Recording and Automation lists; Touch ID keyboard presence/pairing; login
and autostart behavior. Tormod exercises one week of actual fast-user switching,
including lock/reboot/password-required cases, and records whether this is usable
without rushed approvals or password prompts in the agent session. Correlate this
with T2 worker `748eb6d2-61c3-480d-bc87-d11556f46b0c`'s privilege matrix on branch
`review/external-exec-metal3-provisioning`. Current metal-3 `trmd` sudo and Cell
NNP=0 are blockers. Queen takes the Studio 6–8-week option versus a dedicated
human-only mini+Touch ID keyboard/Air at 4–6 weeks plus hardware to Tormod.
His explicit cost/topology decision and acceptable admin separation precede code.
No agent performs this privileged audit or removes user rights autonomously.

Read the [mechanism and threat model](external-exec-owner-isolation.md) first.
Use a physical Studio console and human-only admin credentials. Keep all private
material off chat, agent terminals, shared clipboard, screenshots and recordings.
Only public fingerprints, account IDs and nonsecret test results enter the setup
receipt. All paths below are proposed T2 contract names, not installed facts.

1. **Verify the reviewed artifacts.** Obtain the signed, hardened native Apiary
   approval UI, signing helper and management service, plus reviewed broker and
   installer, by the human's trusted distribution path. Verify the Developer ID provisioning profile
   authorizes the helper-only data-protection keychain access group. The release
   signing key must be outside agent reach. Compare artifact cdhashes, file hashes,
   signing Team ID, designated requirements and policy version against Queen's
   approved manifest. Refuse debug entitlements, mutable plugins, ad hoc signing
   or agent-built replacement artifacts. Record exact public identities.
2. **Separate administration.** In macOS System Settings, using the human-only
   administrator account, create a standard local user named `apiary-approve`.
   Confirm a compatible Magic Keyboard with Touch ID is physically paired; the
   Studio has no built-in Touch ID sensor.
   Give it a unique password Tormod retains outside agent-reachable storage.
   Disable automatic login, sharing, remote login and management into this user.
   Through the reviewed human installer, deny PAM `su` and terminal `login` into
   it. Restrict it to a physical console GUI session. Require routine Touch-ID-only
   unlock; never type its password from a `trmd` session. For macOS-required
   post-reboot password entry, disable approvals and use a physical human startup
   ceremony with `trmd` logged out and its processes stopped by the human admin.
   If these controls cannot be enforced, stop and select a separate station.
   Remove `trmd` from administrators and all sudo/privileged service paths,
   invalidate cached privilege authorization and remove reachable admin secrets.
   Record the independently inspected effective privileges, not just group names.
   If removing these rights is unacceptable, stop and ask Queen for the separate
   device decision. Do not call the Studio option isolated.
3. **Establish the protected session.** Physically log into `apiary-approve`.
   Install the reviewed binaries and launchd definitions with the human admin
   installer into root-owned, non-user-writable locations. Do not install an agent
   harness, browser extension, development tools, remote-control or shared clipboard
   software into this account. Audit/revoke existing `trmd` Accessibility, Screen
   Recording and Automation grants that defeat the boundary; grants are per
   app/user, not scoped by target session. Make management-user LaunchAgents,
   login items and all autostart parent paths root-owned/non-writable. Register
   UI/helper designated requirements AND cdhashes in root-owned config. Require
   kernel audit-session ID matching the active management physical-console login;
   UID and approved binary alone are insufficient. T8 verifies actual enforcement.
4. **Create the ur approval key.** Open the native helper's reviewed **Enroll ur
   approval key** screen in this session. It generates a new P-256 Secure Enclave
   key locally, bound to this account and the approved helper, with per-operation
   `privateKeyUsage` and `biometryCurrentSet`, device-only/non-synchronizing storage
   and no password fallback. Key access uses the helper-only entitlement/profile;
   fresh LAContext and zero Touch ID reuse are helper-enforced behavior, not
   guarantees of the key flags alone. Enroll only
   Tormod's biometrics. Check that a fresh signature requires a new biometric
   gesture and that key export is unavailable. Export only public SPKI, SHA-256
   fingerprint and key ID. Bind the public enrollment record to Tormod's approver
   ID, the exact ur workspace ID, broker ID, schemas and policy epoch. Never export
   a private-key archive. If hardware or supported API cannot enforce this policy,
   stop; do not substitute a software key.
5. **Create transport keys separately.** Use the reviewed human-run enrollment
   installer to generate a Studio TLS server key inside the management user's
   private keychain, ACL restricted to the management service. Use a per-user
   launchd LaunchAgent after human login/keychain unlock, not a root LaunchDaemon
   assuming login-keychain access. Test lock behavior; if keychain policy locks
   transport, pause until human unlock. Reboot/logout requires human login before
   transport resumes; never store a password for unattended startup. Transport
   cannot sign approval envelopes.
   Before metal-3 provisioning, remove `trmd` sudo/polkit/service-control rights
   and invalidate cached authorization under Queen's exact T2 plan. Enforce Cell
   NNP and independently prove denial; NNP alone does not fix sudo. If this is
   infeasible, move the verifier to a host agents cannot root.
   Reach the human-only metal-3 admin account only from a non-agent admin machine
   or account with Tormod's hardware-backed FIDO2 `sk-ssh-ed25519` key requiring
   user verification/presence, without an agent-visible SSH agent or forwarding.
   Generate the broker TLS client key only in the protected credential root.
   No agent SSH key or `trmd` terminal counts as that admin path. Do not ask agents
   to generate either key. Issue certificates from the human-controlled private
   trust anchor with exact Studio server and metal-3 broker names, proper EKUs
   and finite validity. No trust-on-first-use, shared certificate or tailnet ID.
6. **Install and compare public pins physically/out of band.** Read the Studio
   TLS SPKI and ur approval-key fingerprints from the protected enrollment screen.
   Compare them character-for-character against the human's metal-3 installation
   receipt, through an independently authenticated admin path. Install Studio TLS
   pin at `/etc/honeybee-exec-dev/management-spki.sha256`; install its trust chain,
   server name and the full approval public-key/ur/approver/epoch binding in
   `/etc/honeybee-exec-dev/broker.json`. Both are root-owned and not writable by
   `trmd` or service children. On the Studio, install the broker client SPKI pin,
   broker ID and chain policy in root-owned management configuration through the
   human installer; compare it with the independently read metal-3 fingerprint.
   Never approve pins copied only from a proposal or this document.
7. **Install protected broker credentials and storage.** The human-run T2 plan
   places `broker-client.key`, `broker-client.crt` and a distinct `recovery.key`
   under `/etc/honeybee-exec-dev/credentials/`, readable only by root at rest.
   systemd `LoadCredential` delivers these basenames only to the broker service.
   The recovery key is generated by the human-run installer, never by an agent.
   The separate roots are `/var/lib/honeybee-exec-dev` (management),
   `/var/lib/honeybee-exec-dev-data` (Honeybee data),
   `/var/lib/honeybee-exec-dev-broker` (journal) and
   `/var/lib/honeybee-exec-dev-state` (attempt state). Confirm owner/mode/ACL and
   encrypted journal recovery policy. Keep sandbox children away from every
   credential, journal and management root. Do not provision until T2's exact
   identities, artifact and permission contract receives Queen GO.
8. **Configure broker time and admission off.** Install reviewed chrony/NTS and
   its protected health adapter on metal-3, two independent authenticated sources,
   5-second uncertainty/freshness bounds and fail-closed checks. Keep workspace
   capability and broker admission switches off. Record broker health and prove
   an unhealthy sample denies preparation/consumption/dispatch. Do not replace
   macOS timed or install NTS there: Studio only displays the broker-issued window
   and never decides expiry. Test wrong Studio time causes no expiry extension;
   certificate checks may fail closed until its clock is corrected.
9. **Perform the enrollment ceremony check.** Start only the approved dev services
   under a separately authorized test plan. Verify direct broker-to-Studio mTLS,
   all three independent key pins and no relay/listener bypass. Physically review
   a harmless no-inference fixture in the protected login session and compare its
   full canonical body/digest with the broker fixture receipt. Approve once;
   observe one consumed preparation and at most one attempt. Return to `trmd` and
   execute T8's authorized negative probes. No enabled external bridge run precedes
   the reviewed safety/test plan; mock/fixture success alone is not enablement.
10. **Collect Queen's implementation/T8 PASS.** Keep admission off until the
    [T8 checklist](external-exec-approval-t8.md) has actual receipts and Queen has
    approved them. Enable only the exact ur workspace, pinned bridge and no-inference
    schema through protected configuration. This does not authorize a live deploy.

For routine start approval, physically switch from `trmd` into the protected
account with Touch ID, open installed native Apiary, select actor/workspace and
inspect the draft at leisure. Click Review to create the broker's frozen 60-second
preparation, check the full body and system biometric sheet's actor/workspace/
operation/digest prefix, and use one fresh biometric gesture. Status/wait and
safe-direction stop use the scoped read/stop handle without another approval;
the human sees that same-user agents may share that limited capability. Lock the account afterwards. A 60-second preparation
that expires during review requires another review; never extend it locally.

For key loss, biometric-set change, suspected helper compromise or restored
journal, disable admission first. Revoke the affected approval key/epoch and TLS
pins where relevant, close existing channels and cancel pending preparations.
Reconcile existing attempts before reenrollment. Generate a new key through the
same human ceremony, compare/install its public pin, then repeat T8. Never restore
an old replay DB under its old epoch or recover private keys through agents.
For planned transport rotation only, install verified new pins at both ends,
confirm them, and remove old pins within 24 hours; compromise has no overlap.

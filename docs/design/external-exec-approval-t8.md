# T8 negative proofs for external-exec approval

T1 specifies these checks; none is claimed to have run. T8 executes them only
after Queen approves the exact provisioning and test plan. Use the actual Studio
`trmd` harness-native tools and metal-3 Cell, the protected approval UI/helper,
direct channel, broker journal and pinned bridge path. Mocks and unit tests are
useful preparation but cannot establish the OS/user/UI isolation boundary.
Before code, Tormod's Phase-0 record must establish Studio privileges/TCC/hardware
and one week of real user switching, plus T2 metal-3 sudo findings and the human's
cost/topology choice. T8 repeats effective isolation checks after implementation;
it does not replace that pre-code gate. An independent human admin performs the
privileged inventory. Agents run only explicitly authorized adversarial probes.

Record fixture/body digest, actor/workspace, host identities, policy/artifact
versions, attempted attack, refusal audit, durable request/attempt counts and
post-restart observations. Redact keys, tokens, fences and protected paths from
published output. Have a human operate the management session and biometrics.

Each row maps to a mechanism in the
[owner design](external-exec-owner-isolation.md). All must pass, together with its
existing sandbox, KVM, FD, lifecycle and teardown checklist. Missing evidence is
an enablement blocker. Expected refusal means **no new accepted operation or
bridge attempt**, not merely an error message at the proposal UI.

| ID | Mechanism and adversarial action | Required evidence/result |
| --- | --- | --- |
| A1 | Inspect Studio and metal-3 `trmd` effective privileges, cached sudo/authorization, groups, reachable credentials, writable privileged files and service-control RPC. | No escalation path. Record actual facts; admin membership and untested paths block Studio selection. Do not expose secrets. |
| A2 | From actual Studio agent tools try helper XPC, fake/forwarded audit token, claimed PID, approved binary under `trmd` or approval UID via `su`/`login`/`launchctl asuser`, replacement/ad hoc binary, debug attachment, library/plugin injection and memory/task-port/keychain access. | Kernel UID plus cdhash/designated-requirement AND active physical console audit-session checks refuse; no key read/use or signing oracle. Include effective helper entitlements and filesystem ACLs. |
| A3 | With existing TCC grants, try Accessibility, AppleScript/System Events, CGEvent, screen capture/overlay, remote desktop and management APIs across the management login session, including when it is active. Simulate a captured management password without exposing it to agents: try su/login/asuser and planting LaunchAgents/login items from an authorized human test harness. Test fake switch/password windows in trmd and post-reboot startup. | No trmd-driven input, window alteration, overlay, read/modify or capture/control path; PAM denies su/login, autostart paths are non-writable, physical console session binding excludes other sessions. Routine unlock is Touch ID; no password typed into trmd; macOS-required password startup uses the human-only ceremony. If any succeeds, stop Studio option and escalate the device decision; no waiver based on biometrics. |
| A4 | Try ordinary Apiary RPC/browser approve calls, URL/deep-link handlers, copied bearer/session tokens, remote phone message and `apiary-phone-unverified` content. | At most untrusted proposals; no consumed preparation, signed token or effect. Pending UI labels untrusted source claims separately from human-selected actor. |
| A7 | Attack management proposal intake directly: malformed/duplicate/unknown fields, oversized/framing corruption, slow writer, queue flood and attempts to invoke sign/file/exec operations. | Only closed proposal.v1 accepted, 16 KiB/20 queued/10 per minute bounds and parse deadline enforced; no signing/transport proxy or authority from intake. Fuzz/saturation receipts show bounded memory and no accepted start. |
| A5 | Have the human decline biometrics; try unlocked keychain, cached LA context, approval double-click, background/session-switch/lock, approve during body change and authenticate for job A then submit B. | No signing without fresh biometric per immutable review; context destroyed on lock/change/expiry. Unsupported biometric policy blocks enablement. Use disposable enrollment to test biometric-set invalidation under human control. |
| A6 | Render long canonical jobs, every default/input/pin, names resembling other actors, bidi/control/HTML content and rapidly arriving proposals. | Full escaped text and stable actor/workspace IDs match broker body; no truncation/hidden defaults, executable content or selection swap. Human approval never migrates to another preparation. System LAContext sheet names selected actorId/workspaceId/start/digest prefix. Review creates the 60-second preparation only after protected selection; body exceeds 16 KiB/200 lines refuses. |
| B1 | Cross-language canonical vectors: reordered object keys, array order changes, escaped-equivalent strings, Unicode composition differences, duplicate keys, lone surrogate, malformed UTF-8, float, -0, oversized integer and unknown fields. | Broker/helper agree exact bytes/digests for accepted vectors; reject invalid ones before preparation. Strings are not Unicode-normalized. All displayed fields map to signed body. |
| B2 | Modify actor, workspace, broker, operation, body, input digest, limit, deadline, mode, install pin, broker/build/dispatch-builder digest, bwrap hash or sandbox profile, key ID, approver, policy epoch, issuedAt or expiry after display/signature. Try another signing key and variable/invalid signature encodings. | Signature/preparation/policy mismatch refuses at real broker. No chosen executable/path/env/fence/auth slot enters dispatch. |
| B3 | Copy one legitimately approved fixture token inside the protected test harness, replay concurrently and after reconnect/process crash/host reboot; try changed signature bytes for the same nonce. | At most one durable consume/effect. Replay key is nonce/preparation, not signature bytes. No token is given to the attacking agent to perform the probe. |
| B4 | Crash at prepare, consume transaction, commit-before-ack, fence persistence, daemon-call-before-reply and result-journal boundaries. | Restart retains consumed nonce/request/handle; reconciles same idempotency key and exact dispatch. No second start on uncertainty. Lost fence/recovery evidence holds admission. |
| B5 | Disk-full/fsync failure, missing/corrupt WAL/DB/key, old DB restore and nonce pruning around expiry/65-second minimum. | No effect before durable commit. Storage failure suspends. Restore cannot reenable old epoch/tokens; consumed preparation tombstones outlive nonce pruning. Record recovery ceremony and reconciliation. |
| B6 | Exercise 60-second boundary, 5-second future skew, backward/forward wall-clock steps, sleep, stale/missing/unsynchronized time samples and malicious claimed time from proposal. | No expiry grace; broker alone enforces approval time. Studio clock changes never extend expiry; no Studio NTS required. Broker suspends preparation/admission/dispatch on lost sync; monotonic bounds include sleep. Pending tokens canceled; recovery needs three healthy spaced samples and fresh human approval. |
| C1 | Replace either TLS certificate, trust root, SPKI, name/EKU; replay via tailnet identity, relay or ordinary Apiary RPC; try TLS resumption/0-RTT and plaintext listeners. | Only direct pinned mTLS accepted, current chain/name/time checks performed; no relay, fallback or inbound broker TCP/abstract listener. Full token signature still required from valid management transport. |
| C2 | Test TLS/approval-key rotation, revoked key on an existing connection, old epoch and >24-hour overlap. | Config changes close/revalidate channels and invalidate preparations. Compromised pins revoked immediately. No old-key approval after removal. |
| C3 | Read credential files, `/proc` environment/memory/FD aliases, systemd credentials and TLS secrets from Cells, bridge and guest. Try transport key to sign approval or approval key for transport. | Private material inaccessible, key roles disjoint, no trmd signing/export oracle. Pin files cannot be rewritten by agent or child. |
| D1 | Supply chosen fence, dispatch paths, request/idempotency IDs, another workspace/actor's handle, guessed handle or same ID with changed body/actor. | Broker rejects caller authority fields, mints fresh 256-bit private fence/IDs, derives length-framed key and binds random handle to actor/workspace. Handle plus its stored scope permits only read/stop for that exact attempt, never start/retry/dispatch changes. Same-user handle theft cannot expand scope; the UI discloses this deliberate capability rather than claiming actor provenance. |
| D2 | Replay a start token to create another start; use read/stop handle for reconcile/retry/dispatch changes; retry a failed attempt, change immutable input after approval or alter bridge package before exec. | Only exact approved start is admitted; read/stop capability cannot produce an effect in the start lane; retries need new approval; recheck at exec refuses changed protected inputs/pins. Existing same-attempt reconciliation never becomes replacement start. |
| D3 | Force actor/workspace revocation, quota exhaustion and ambiguous teardown. | Deny new admission, stop only exact owned generations via existing safety path; uncertainty consumes quota and remains durable. No phase-3 lease/account effect. |
| D4 | Inspect general logs, chat/tool responses, URLs, raw captures and inherited child FDs after success and every refusal/crash. | No token, key, TLS secret, private fence/dispatch or general handle leakage. Security audit records verdict/digest, not secret values. |
| P1 | Human approves a harmless exact no-inference fixture, then repeats the transport request. | One attempt only, one actor/workspace-bound result. Scoped status/wait (at most 30 seconds/call) and safe stop work without another biometric; none extends deadline or starts a replacement. Ordinary live Cell commands and detached runtime survival still pass. |

T8 must also prove that **every** bridge launch route, including owner CLI and
local management RPC, requires the consumed per-attempt approval for this external
integration. A privileged provisioning tool must not become an agent-accessible
approval bypass. If an administrative emergency path exists, it disables admission
and is exercised only by the human; it cannot mint agent-run approvals.

Pass records prove the tested configurations and pinned versions only. No test can
prove security against all future OS bugs or human deception. Changed entitlement,
OS automation policy, key enrollment, artifact, UID/ACL, channel or launcher requires
relevant negative proofs again and Queen's review before reenabling admission.

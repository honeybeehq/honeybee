# T8 negative proofs for external-exec approval

T1 specifies these checks; none is claimed to have run. T8 executes them only
after Queen approves the exact provisioning and test plan. Use the actual Studio
`trmd` harness-native tools and metal-3 Cell, the protected approval UI/helper,
direct channel, broker journal and pinned bridge path. Mocks and unit tests are
useful preparation but cannot establish the OS/user/UI isolation boundary.
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
| A2 | From actual Studio agent tools try helper XPC, fake/forwarded audit token, claimed PID, approved binary run under `trmd`, replacement/ad hoc binary, debug attachment, library/plugin injection and memory/task-port/keychain access. | Kernel UID plus designated-requirement checks refuse; no key read/use or signing oracle. Include effective helper entitlements and filesystem ACLs. |
| A3 | With existing TCC grants, try Accessibility, AppleScript/System Events, CGEvent, screen capture/overlay, remote desktop and management APIs across the management login session, including when it is active. | No trmd-driven input, window alteration, overlay, read/modify or capture/control path. If any succeeds, stop Studio option and escalate the device decision; no waiver based on biometrics. |
| A4 | Try ordinary Apiary RPC/browser approve calls, URL/deep-link handlers, copied bearer/session tokens, remote phone message and `apiary-phone-unverified` content. | At most untrusted proposals; no consumed preparation, signed token or effect. Pending UI labels untrusted source claims separately from human-selected actor. |
| A5 | Have the human decline biometrics; try unlocked keychain, cached LA context, approval double-click, background/session-switch/lock, approve during body change and authenticate for job A then submit B. | No signing without fresh biometric per immutable review; context destroyed on lock/change/expiry. Unsupported biometric policy blocks enablement. Use disposable enrollment to test biometric-set invalidation under human control. |
| A6 | Render long canonical jobs, every default/input/pin, names resembling other actors, bidi/control/HTML content and rapidly arriving proposals. | Full escaped text and stable actor/workspace IDs match broker body; no truncation/hidden defaults, executable content or selection swap. Human approval never migrates to another preparation. |
| B1 | Cross-language canonical vectors: reordered object keys, array order changes, escaped-equivalent strings, Unicode composition differences, duplicate keys, lone surrogate, malformed UTF-8, float, -0, oversized integer and unknown fields. | Broker/helper agree exact bytes/digests for accepted vectors; reject invalid ones before preparation. Strings are not Unicode-normalized. All displayed fields map to signed body. |
| B2 | Modify actor, workspace, broker, operation, body, input digest, limit, deadline, mode, install pin, key ID, approver, policy epoch, issuedAt or expiry after display/signature. Try another signing key and variable/invalid signature encodings. | Signature/preparation/policy mismatch refuses at real broker. No chosen executable/path/env/fence/auth slot enters dispatch. |
| B3 | Copy one legitimately approved fixture token inside the protected test harness, replay concurrently and after reconnect/process crash/host reboot; try changed signature bytes for the same nonce. | At most one durable consume/effect. Replay key is nonce/preparation, not signature bytes. No token is given to the attacking agent to perform the probe. |
| B4 | Crash at prepare, consume transaction, commit-before-ack, fence persistence, daemon-call-before-reply and result-journal boundaries. | Restart retains consumed nonce/request/handle; reconciles same idempotency key and exact dispatch. No second start on uncertainty. Lost fence/recovery evidence holds admission. |
| B5 | Disk-full/fsync failure, missing/corrupt WAL/DB/key, old DB restore and nonce pruning around expiry/65-second minimum. | No effect before durable commit. Storage failure suspends. Restore cannot reenable old epoch/tokens; consumed preparation tombstones outlive nonce pruning. Record recovery ceremony and reconciliation. |
| B6 | Exercise 60-second boundary, 5-second future skew, backward/forward wall-clock steps, sleep, stale/missing/unsynchronized time samples and malicious claimed time from proposal. | No expiry grace; both hosts fail closed. Broker suspends preparation/admission/dispatch on lost sync; monotonic bounds include sleep. Pending tokens canceled; recovery needs three healthy spaced samples and fresh human approval. |
| C1 | Replace either TLS certificate, trust root, SPKI, name/EKU; replay via tailnet identity, relay or ordinary Apiary RPC; try TLS resumption/0-RTT and plaintext listeners. | Only direct pinned mTLS accepted, current chain/name/time checks performed; no relay, fallback or inbound broker TCP/abstract listener. Full token signature still required from valid management transport. |
| C2 | Test TLS/approval-key rotation, revoked key on an existing connection, old epoch and >24-hour overlap. | Config changes close/revalidate channels and invalidate preparations. Compromised pins revoked immediately. No old-key approval after removal. |
| C3 | Read credential files, `/proc` environment/memory/FD aliases, systemd credentials and TLS secrets from Cells, bridge and guest. Try transport key to sign approval or approval key for transport. | Private material inaccessible, key roles disjoint, no trmd signing/export oracle. Pin files cannot be rewritten by agent or child. |
| D1 | Supply chosen fence, dispatch paths, request/idempotency IDs, another workspace/actor's handle, guessed handle or same ID with changed body/actor. | Broker rejects caller authority fields, mints fresh 256-bit private fence/IDs, derives length-framed key and binds random handle to actor/workspace. Neither handle nor claimed actor alone allows status/wait/stop/reconcile/start. |
| D2 | Replay a start approval as stop/status/reconcile, retry a failed attempt, change immutable input after approval or alter bridge package before exec. | Exact-operation binding holds; retries need new approval; recheck at exec refuses changed protected inputs/pins. Existing same-attempt reconciliation never becomes replacement start. |
| D3 | Force actor/workspace revocation, quota exhaustion and ambiguous teardown. | Deny new admission, stop only exact owned generations via existing safety path; uncertainty consumes quota and remains durable. No phase-3 lease/account effect. |
| D4 | Inspect general logs, chat/tool responses, URLs, raw captures and inherited child FDs after success and every refusal/crash. | No token, key, TLS secret, private fence/dispatch or general handle leakage. Security audit records verdict/digest, not secret values. |
| P1 | Human approves a harmless exact no-inference fixture, then repeats the transport request. | One attempt only, one actor/workspace-bound result. Separate fresh status approval works. Ordinary live Cell commands and detached runtime survival still pass. |

T8 must also prove that **every** bridge launch route, including owner CLI and
local management RPC, requires the consumed per-attempt approval for this external
integration. A privileged provisioning tool must not become an agent-accessible
approval bypass. If an administrative emergency path exists, it disables admission
and is exercised only by the human; it cannot mint agent-run approvals.

Pass records prove the tested configurations and pinned versions only. No test can
prove security against all future OS bugs or human deception. Changed entitlement,
OS automation policy, key enrollment, artifact, UID/ACL, channel or launcher requires
relevant negative proofs again and Queen's review before reenabling admission.

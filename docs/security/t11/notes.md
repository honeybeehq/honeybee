# T11 sandbox hardening review

DEPLOY HOLD. Source and fixture evidence only; no service changed or restarted.

This change closes the direct hived.sock operator-authorization escape and the dataDir/tmux.sock escape from confined Cells. Host sockets, account homes, registration keys, stores, logs and sibling Cells are absent. The only host socket is the authenticated, generation-bound per-Cell gateway. Same-uid processes outside Cells retain operator power by design.

## Filesystem and process boundary

The root is an empty tmpfs. Read-only system binds are /usr, /etc, /bin, /sbin, /lib and /lib64 for executables, libraries and CA/config data. A realpath-resolved versioned /opt/node-vX.Y.Z-linux-{x64,arm64} install root is the only extra toolchain leaf. It supplies Node and installed harness executables. The host-side guard rejects symlinks, group/world write and foreign or unmapped owner 65534; production owners are root or daemon euid. Each first-node launch must record path, uid, mode and verdict. No generic /opt, /var, /srv, /mnt, /sys or host home is restored.

Fresh /proc, minimal /dev, private /tmp, /var/tmp and /dev/shm, and empty read-only /run and home views replace host state. Only the Cell's own wrapper and private home are writable. /run/honeybee binds the exact gateway socket, immutable scope helper, code-only bundled CLI and executable shim read-only. The source gateway path is opaque and must already be a nonsymlink socket. No fallback to hived.sock exists. /run/user is empty; bus, systemd/private, ssh-unix-local, openssh_agent, gpg agents, apiaryd, nectard, tailscale, postgres, other runner stdin/control sockets and gh hosts.yml are absent. Account/data roots outside HOME are absent by construction.

Explicit user, PID and IPC namespaces are required. The inner helper verifies its user namespace differs from the launcher's parent namespace. Scope-only Landlock ABSTRACT_UNIX_SOCKET and SIGNAL applies before bwrap and all descendants. ABI below 6, missing/tampered helper, namespace failure or missing gateway refuses launch. Provider networking remains shared. Only test-owned path/abstract sockets were connected; never live manager sockets.

The versioned Node leaf currently exposes these global package names: @anthropic-ai/claude-code, @openai/codex, @xai-official/grok, agent-browser, corepack, npm, opencode-ai, pnpm. This is code exposure, not a credential bind. Narrowing that distribution is a separate packaging decision. The root census prunes node_modules; the separate full /etc plus /opt walk covers it without that prune.

## Credentials and harness compatibility

No credential is copied, provisioned or made writable. Exact existing regular files are bound read-only, with symlink/ancestor checks, into disposable mode-0700 Cell-private homes. Directory entries below these lists are individually enumerated and bound as files; no parent account directory is bound.

| Harness | Existing read-only input leaves | Purpose |
|---|---|---|
| Codex | auth.json; .codex/auth.json | Authentication and legacy mirror |
| Codex | config.toml; AGENTS.md; skills files; prompts files | Authoritative config, instructions and skills |
| Claude | .credentials.json | Existing authentication if present |
| Claude | .claude.json; settings.json; CLAUDE.md; skills, commands and agents files | Authoritative trust/MCP/config/instructions |

Everything else stays private and Cell-scoped. No unconfined process loads private-home config, plugins, hooks or skills, and nothing is copied back. Auth bytes remain readable to their harness, so this is not a credential secrecy boundary. Other shared homes and gh/SSH/GPG credentials are hidden. Git-over-SSH via host keys or agents may stop working; T11d owns a reviewed scoped transport.

Codex 0.156.1 runs and resumes against a deterministic local provider through the real driver, with guard enabled, two generations and one provider session; host-owned stdout transcript contains both turns. Apiary follows Honeybee sessionLogPath, not native account session files. Claude 2.1.280 refused authentication because its existing credential leaf is absent; no credential was provisioned. Claude Cell launches are excluded from rollout until their existing credential projection is independently verified. Other harnesses have no proven leaf/compatibility grant and fail closed. macOS private-harness projection refuses rather than silently broadening permissions; no physical workstation tests ran.

Token refresh is a known operational limit. The observed Codex access-token lifetime was 864000 seconds, with 159537 seconds (about 44 hours) left at observation. The exact UTC observation/expiry timestamp was not retained in the metadata receipt, so an exact earliest expiry is not established by this evidence; it must be re-established by the credential owner before rollout. In-Cell refresh writes to bound auth leaves fail. Every affected bee can become auth_needed when its token comes due unless a host-side owner refreshes first. Separate commit 2bc827e0 classifies token-refresh and read-only auth-file failures as auth_needed; adapter tests verify the explicit condition, not silent waiting. No writable grant is added. Host-side refresh: owner 265af7ab (T11g), plan under Queen review; it is a rollout PRECONDITION and must ship before the shared token expires. Existing host central-account refresh runs about three hours early, but per-file RO mounts retain the old inode across atomic rename, so a fresh projection is required for running Cells; leased accounts are excluded from the early tick. No credential gateway verb is proposed. Forced-expiry was not attempted because it would require changing credential material. Do not claim refresh compatibility.

## Evidence and verification

Root proof at f0596ad7 ran once under Quiet's pinned GO on NC4 using an euid-owned, code-only Node overlay at the unchanged versioned /opt path. No production bypass. root-receipts.json is 4012 bytes, sha256 cda2b7c73606b8ae00057d8701d7b9c404934e450f651fc420b9059b0d1be000. Root walk: 70601 entries, no truncation, one gateway socket. Venue: kernel 6.12.107+deb13-amd64, Landlock ABI 6, child uid map, all protected home paths absent. Full /etc plus /opt walk: 8899 entries, pending 0, no readable named sensitive files and no sockets.

The three errors per walk were independently resolved in one renewed diagnostic GO: /etc/credstore, /etc/credstore.encrypted and /etc/ssl/private are EACCES and X=false in both walks. error-receipts.json is 744 bytes, sha256 e363364e4f08658732c6fdd570b4de4691aa776b1872d4e50386c75e55db5193. A first decode mismatch was caught before execution; the verified diagnostic ran once. Quiet accepted the only-gateway claim. Both scratch roots were removed under the explicit cleanup GO.

Committed root/error receipts and guarded Codex resume are beside this note. sandbox-suites.txt records 49 total, 45 pass, 4 skips (three Darwin-only and one unavailable CoW), zero failures on NC4. refresh-boundary.txt records 24 adapter passes. Gateway .audit/T11-joint.txt and T11-joint-custom.txt prove default and /mnt custom roots, actual isolated tmux server preexisting outside and ENOENT inside, scoped RPC/CLI success and foreign/cwd/inbox refusals. T11-joint-custom-before.txt records the old-root regression red. Owner/userns negative fixtures reject unsafe modes, symlinks, unmapped owner, same userns and missing gateway; abstract fixtures prove own external socket EPERM and own inner socket success; ABI-5 fixture refuses before command execution.

## Open escape and rollout exclusions

OPEN: the Apiary HTTP/service-principal spawn path can request placement outside Cell confinement. Sandbox masks do not fix that delegated authority. T10b/A1-A6 owns original-caller principal forwarding; T11e owns daemon confinement inheritance. This proof does not claim that open path is closed.

metal-1 is excluded: ABI 4 would refuse Cell starts. It stays trusted-only with the separate hotfix until T11b netns plus seccomp passes Quiet review, then T11 and T11b deploy together. No reboot/kernel change is authorized. metal-2 and metal-3 resolve as workstation without nodeKind and remain excluded until T11f provisioning establishes satellite confinement. Missing nodeKind with implicit unsandboxed Cells now refuses unless sandbox:false is explicit; an explicitly configured workstation policy is not registry reconciliation.

Before deployment per node: explicit satellite nodeKind; approved realpath Node/harness locations; ABI >=6; host owner-check log; immutable artifact helper hash; fresh Cell proof; old Cell retirement; credential refresh owner/expiry plan. The node/toolchain inventory in this proof is NC4 fixtures only, not a fleet inventory. Mac Studio and every other node also require explicit policy preflight; no workstation test or deployment is authorized. A source fixture is not a deployed receipt. Queen and Quiet reviews and a separate reviewed hive deploy remain required.

## Read-only NC4 attribution

No systemctl command was run. Quiet withdrew the requested manager query and closed all four unit contents based on independent receipts. This table records received attribution, not independent unit content reads; unavailable full hashes or ExecStart values are not invented.

| Unit | Path | mtime UTC | SHA256 | Attribution |
|---|---|---|---|---|
| nectard.service | ~/.config/systemd/user/nectard.service | 2026-10-28 06:44:33 | prefix 68e352e2 | rollout 5754, result 7056d47a; Quiet content closed |
| dev.apiary.apiaryd.service | ~/.config/systemd/user/dev.apiary.apiaryd.service | 2026-10-28 07:27:47 | c98e28f2473eff9f150207b9620a43e052496291624f42b2c8c9aac0a107c007 | Apiary166b86b, owner2c700c13; after.json386c8071 matches service hash |
| dev.honeybee.hive.v2.service | ~/.config/systemd/user/dev.honeybee.hive.v2.service | 2026-10-27 16:50:54 | prefix442bae95 | content matches Honeybee735e9824; exact invocation unrecorded |
| apiary-tmp-sweep.service | ~/.config/systemd/user/apiary-tmp-sweep.service | 2026-10-15 01:04:03 | f8e20b6eccabf74c668669bec3e21207665bf4a63a3403977dade96cbae2b678 | T1b ownera3248231, proof4376c88d, landed2933585dc; byte-identical template |
| apiary-tmp-sweep.timer | ~/.config/systemd/user/apiary-tmp-sweep.timer | 2026-10-15 01:04:03 | e76c6e14c2bffbba24e9806cac67d030303113914e8c62ce1164dda254961b76 | same T1b; nightly invocation inferred, no per-host receipt |

ExecStart values were not supplied in the accepted attribution receipts. The preliminary unknown-owner incident was withdrawn to all notified parties when ownership was established. No mismatch remains asserted.

## Hotfix composition follow-up

Canonical branch is review/hdm-T11-batch-hotfix, based on approved hotfix 2491e5a0. The earlier beb35f9f branch is retained; no proof was submitted for it. Rebase conflicts unioned RPC option hooks, connection fields and error codes. The hotfix owner independently reviewed both policy owners and provided the same-sandbox-PID dual-endpoint fixture. Its verbatim review is saved in composition-review.txt. On the raw socket bee.transcript is now a known method, so the correct confined result is confined_peer_refused, replacing the old unknown-method invalid_request expectation. Both outcomes deny access; the new explicit refusal is a security-policy decision and is regression tested.

Final source receipts final-*.txt identify the tested source SHA, date, exact command, venue and exit code. Historical .audit/T11-* and sandbox-suites.txt remain older receipts and do not prove the rebased RPC admission. The SHA-to-original mapping is canonical.tsv; two gateway patch IDs changed at the conflict unions and require exact-diff review, not carryover. Every other prior sandbox production patch is identical by stable patch ID.

Root and error receipts are explicitly PRE-REBASE evidence from f0596ad7 under Quiet's one-shot GO, not a claim that a census ran on the final head. git diff f0596ad7 through source4e12ddbd is empty for sandbox.ts, cellScope.ts and native/cell-scope.c, the launcher and scope code exercised by that runner. The harness-home safety fixes change private input preparation and have their own new tests; the metadata runner has no harness projection. Root evidence remains bound to its original SHA and Quiet acceptance.

## Queen credential follow-up

ec2925c7 discards the entire raw Codex authentication error before emitting a persisted flag. Only a constant actionable summary survives, including for synthetic bearer, sk-, JWT and refresh_token strings. The adapter unit test checks emitted flag shape only. End-to-end mid-turn expiry and retry-loop behavior are UNTESTED; do not infer clean retry behavior from that check. The expected operator boundary is auth_needed, but a real daemon/provider expiry check remains required; T11g must verify the end-to-end host recovery before rollout. In particular, an atomic host refresh alone cannot update an already pinned inode.

Private directory preparation opens the Cell root and each descendant using directory handles with O_NOFOLLOW and calls fchmod on handles. A planted symlink cannot chmod its target. Recursive skills/prompts/commands/agents enumeration skips dotfiles and dot-directories, including .git and .env. Explicit allowlisted top-level credential dotfiles are intentional.

NAMED RESIDUAL: existing account input paths are checked before bwrap re-resolves source paths. They are not pinned with ro-bind-fd. A concurrent unconfined host account writer could replace a checked leaf between validation and bind. On the destination side, sandbox-state/<harness> is inside the writable Cell: an already-running bee could swap a checked mount destination for a symlink before bwrap resolves it. A read-only file could consequently land at another location inside that same sandbox. This destination-side race is also disclosed and not claimed solved. Cells have no writable account-home grant, so this race requires a host-side writer; it is disclosed rather than claimed solved. T11g's serialized credential publication/fresh projection must address the expected host writer.

## Trail and attribution provenance

The ten 15:22Z decision rows were reconstructed together from this session's earlier transcript and receipts; those timestamps are recording time, not the original decision times. Earlier SHAs remain historical references and resolve through canonical.tsv, rather than being misrepresented as ancestors of the rebased head. Main rejected alternatives were broad shared writable homes, overlays, path socket denylists and below-ABI fallback. The full-root allowlist replaced denylists after the custom-root red fixture. The global Node distribution scope remains an orchestrator-owned packaging/rollout preflight; this task did not inventory every node.

The systemd unit table above is received, non-evidentiary attribution context. It is not a complete independent forensic table, and prefix-only hashes/unknown ExecStart fields do not become proof by inclusion.

## Common flag sink and terminal gate

Queen required redaction for every adapter, not only Codex. f87bc307 sanitizes evidence once in DaemonCore.applyEvidence before store.setFlag and before the onFlagEvidence hook that calls applyAccountPolicy/statusReason. Every auth_needed SET gets a constant actionable summary; non-auth details receive a BEST-EFFORT scrub of bearer strings, sk- keys, JWT fragments and refresh/access token, API key and client secret assignments. This scrub is not complete: space-separated refresh token labels and unprefixed vendor formats such as ghp_, xai- and ya29. are not comprehensively covered. Authentication SET details are constant rather than relying on this scrub. The generic-driver regression verifies stored flags, audit and account statusReason contain none of the synthetic secret fragments. It does not retroactively scrub old logs or historical records. The 94-loop suite passed.

The two private projection unit tests are Linux-only because directory traversal through /dev/fd/N/part is unsupported on macOS; production Darwin private projection already refuses. They are skipped there rather than passing for an unrelated failure.

R3: bwrap has no --new-session, but production launchers detach before the harness. HsrDriver driver.ts:576-579 spawns the runner host detached with ignored stdio (or one IPC fd). runner-host.ts:208-212 gives the harness three pipes. CellDriver foreground driver.ts:214 and background :589 both use this inner driver. Adoption :369 reuses the same process and session, never attaches a controlling terminal. Retained Cell exec exec.ts:309-313 is detached with ignored stdin and output pipes; secretSupervisor.ts:36-37 inherits only those descriptors. A synthetic launch uses the same HSR host path or has no process at all.

New fixtures walk only their own live runner process trees and assert tty_nr=0 for real foreground/background sandbox launches and after adoption. Retained sandbox exec also reports tty_nr=0. The suite was additionally launched under a TEST-OWNED PTY: parent tty_nr=34816 while detached descendants remained 0. No host terminal was opened or injected. This proves detachment even when the fixture parent has a controlling terminal. No production bwrap change was required.

## Final reviewed source and known supplemental failure

Queen PASSED the credential surface at ef61a37d (message4233). All final check/v2check/build, hotfix, adapter, sandbox, joint, composition and loop receipts now name that tested source. Counts are 57 hotfix passes, 25 adapter passes, 53 sandbox/driver tests with 49 pass and 4 skip, 94 loop passes, plus default/custom joint and composition. final-owned-tty.txt runs the sandbox/driver suite under a fixture-owned PTY and records parent tty_nr=34816; all descendant assertions require zero. These are the requested gates, not a claim that every repository test is green.

SUPPLEMENTARY FAILURE: final-auth-resume.txt records five auth-resume unit passes and seven auth-resume RPC failures. All seven RPC fixtures stop at confined_peer_refused before credential flow. Independent hotfix owner b509dfc7 confirmed source disposition in message4232: default makeDaemonDir is workstation with sandbox off; startup strict mode classifies the unattributed unregistered client as confined, so admitConfined requires a live owning bee. This is the intentional hotfix contract, not evidence of working expiry recovery. Those fixtures need explicit reviewed sandbox/authority setup. They also name a dead port that this task does not authorize; do not rerun them under this task. No weakening of source admission is proposed. The failed run remains visible and is not treated as a green gate. Mid-turn expiry and refresh retry behavior remain untested; T11g owns rollout recovery.

Apiary Project/proof/landing API calls are paused by orchestrator4228 until the Studio is declared healthy. No T11 sandbox proof has been filed. Source review readiness does not lift deployment hold.

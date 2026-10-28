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

Codex 0.156.1 runs and resumes against a deterministic local provider through the real driver, with guard enabled, two generations and one provider session; host-owned stdout transcript contains both turns. Apiary follows Honeybee sessionLogPath, not native account session files. Claude 2.1.280 refused authentication because its existing credential leaf is absent; no credential was provisioned. Other harnesses have no proven leaf/compatibility grant and fail closed. macOS private-harness projection refuses rather than silently broadening permissions; no physical workstation tests ran.

Token refresh is a known operational limit. The observed Codex access-token lifetime was 864000 seconds, with 159537 seconds (about 44 hours) left at observation. The exact UTC observation/expiry timestamp was not retained in the metadata receipt, so an exact earliest expiry is not established by this evidence; it must be re-established by the credential owner before rollout. In-Cell refresh writes to bound auth leaves fail. Every affected bee can become auth_needed when its token comes due unless a host-side owner refreshes first. Separate commit 2bc827e0 classifies token-refresh and read-only auth-file failures as auth_needed; adapter tests verify the explicit condition, not silent waiting. No writable grant is added. A refresh broker or a reviewed host-side refresh schedule needs an assigned owner and Queen review before rollout. Forced-expiry was not attempted because it would require changing credential material. Do not claim refresh compatibility.

## Evidence and verification

Root proof at f0596ad7 ran once under Quiet's pinned GO on NC4 using an euid-owned, code-only Node overlay at the unchanged versioned /opt path. No production bypass. root-receipts.json is 4012 bytes, sha256 cda2b7c73606b8ae00057d8701d7b9c404934e450f651fc420b9059b0d1be000. Root walk: 70601 entries, no truncation, one gateway socket. Venue: kernel 6.12.107+deb13-amd64, Landlock ABI 6, child uid map, all protected home paths absent. Full /etc plus /opt walk: 8899 entries, pending 0, no readable named sensitive files and no sockets.

The three errors per walk were independently resolved in one renewed diagnostic GO: /etc/credstore, /etc/credstore.encrypted and /etc/ssl/private are EACCES and X=false in both walks. error-receipts.json is 744 bytes, sha256 e363364e4f08658732c6fdd570b4de4691aa776b1872d4e50386c75e55db5193. A first decode mismatch was caught before execution; the verified diagnostic ran once. Quiet accepted the only-gateway claim. Both scratch roots were removed under the explicit cleanup GO.

Committed root/error receipts and guarded Codex resume are beside this note. sandbox-suites.txt records 49 total, 45 pass, 4 skips (three Darwin-only and one unavailable CoW), zero failures on NC4. refresh-boundary.txt records 24 adapter passes. Gateway .audit/T11-joint.txt and T11-joint-custom.txt prove default and /mnt custom roots, actual isolated tmux server preexisting outside and ENOENT inside, scoped RPC/CLI success and foreign/cwd/inbox refusals. T11-joint-custom-before.txt records the old-root regression red. Owner/userns negative fixtures reject unsafe modes, symlinks, unmapped owner, same userns and missing gateway; abstract fixtures prove own external socket EPERM and own inner socket success; ABI-5 fixture refuses before command execution.

## Open escape and rollout exclusions

OPEN: the Apiary HTTP/service-principal spawn path can request placement outside Cell confinement. Sandbox masks do not fix that delegated authority. T10b/A1-A6 owns original-caller principal forwarding; T11e owns daemon confinement inheritance. This proof does not claim that open path is closed.

metal-1 is excluded: ABI 4 would refuse Cell starts. It stays trusted-only with the separate hotfix until T11b netns plus seccomp passes Quiet review, then T11 and T11b deploy together. No reboot/kernel change is authorized. metal-2 and metal-3 resolve as workstation without nodeKind and remain excluded until T11f provisioning establishes satellite confinement. Missing nodeKind with implicit unsandboxed Cells now refuses unless sandbox:false is explicit; an explicitly configured workstation policy is not registry reconciliation.

Before deployment per node: explicit satellite nodeKind; approved realpath Node/harness locations; ABI >=6; host owner-check log; immutable artifact helper hash; fresh Cell proof; old Cell retirement; credential refresh owner/expiry plan. A source fixture is not a deployed receipt. Queen and Quiet reviews and a separate reviewed hive deploy remain required.

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

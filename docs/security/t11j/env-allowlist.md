# T11j: Cell runtime environment

Base: review/hdm-T11-batch-hotfix e2a534a9. No deployment or real daemon/socket probe. Project proof submission is paused by the orchestrator's 15:39Z instruction until the Studio all-clear.

Only Cell runtimes change. Host HSR and tmux retain the existing full daemon environment and the same spec → bee → account → stamped identity precedence.

## Inheritance and explicit grants

The inherited daemon set is finite: PATH, LANG, TZ, TERM, HOME, USER, LOGNAME, TMPDIR; GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL; LC_ALL, LC_ADDRESS, LC_COLLATE, LC_CTYPE, LC_IDENTIFICATION, LC_MEASUREMENT, LC_MESSAGES, LC_MONETARY, LC_NAME, LC_NUMERIC, LC_PAPER, LC_TELEPHONE and LC_TIME. An unrecognized name, even LC_UNEXPECTED_SECRET or HIVE_UNKNOWN_SECRET, is not inherited. APIARY, provider tokens, loader variables and unknown HIVE variables are not inherited from hived.

Explicit agent-spec, bee and account environment remains a deliberate per-runtime grant, preserving custom harness settings. This is not an allowlist of operator-configured application variables: it is an allowlist of ambient daemon inheritance. Unknown ambient variables cannot cross by merely sharing a prefix. Operators must configure any required application/provider setting explicitly rather than rely on hived's shell environment.

HOME and build-tool cache paths are assigned to Cell-private state. Ambient XDG paths are not inherited; unset XDG config/data/state follow the private HOME. Explicit spec/bee/account XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_STATE_HOME grants remain intact. No host directory is bound merely because an environment string names it. Linux sandbox TMPDIR is the private /tmp mount; other Cell launches use the Cell-private temp directory. These directories use the existing fd-rooted, O_NOFOLLOW private-directory helper. The existing launcher continues to set its fixed PATH. HOME/TMP-private applies to sandbox:false Cells too, as required by the Cell-only contract; it does not make those unsandboxed processes confined. Confinement-owned HOME/TMP and the pre-existing cache assignments override explicit values, while account config/data/state overrides are preserved.

Host route variables HIVE_SOCKET, HIVE_DATA_DIR, HIVE_V2_SOCKET_PATH, HIVE_V2_DATA_DIR, HIVE_TMUX_SOCKET and HIVE_TMUX_SOCKET_PATH are removed even when explicitly supplied. HIVE_CELL_GATEWAY_SOCKET is set by the Cell driver and launcher to the mounted gateway. The staged CLI gives that gateway priority over explicit socket flags and disables stale-store fallback.

## Source map

| Needed input or boundary | Source |
|---|---|
| Ambient allowlist; no prefix-based secret exceptions | v2/driver-cell/src/runtimeEnvironment.ts:1 |
| Spec, bee, account precedence and Cell-only selection | v2/daemon/src/daemon.ts:5307 |
| Account home and runtime credential sources | v2/daemon/src/accountsService.ts:1936 and :1951 |
| Account home-name table | v2/core/src/import-frozen.ts:43 |
| Account recipe extras | v2/core/src/accountRecipes.ts:972 |
| Runtime-only CURSOR_API_KEY / CURSOR_AUTH_TOKEN derivation | v2/daemon/src/cursorAuth.ts:113 |
| Four Git author/committer metadata variables; no GIT_CONFIG*, GIT_SSH*, GIT_ASKPASS or GIT_DIR inheritance | v2/driver-cell/src/git.ts:164 |
| HIVE_BEE, HIVE_BEE_ID and HIVE_PARENT identity stamps | v2/daemon/src/daemon.ts:562 |
| HIVE_CELL and HIVE_CELL_SPACE; independent driver fallback | v2/driver-cell/src/driver.ts:773 |
| APIARY_GATEWAY_URL, APIARY_SESSION_ID, APIARY_AGENT_TOKEN | Explicit runtime contract in the T11j request; existing gateway env forwarding in src/accounts/gatewayMcpSeed.ts:87 and its HIVE identity additions at :20 |
| Cell-private HOME / temp / XDG and route stripping | v2/driver-cell/src/sandbox.ts:134 |
| Cell-exec already has an explicit inherited set, now also private HOME/routes | v2/driver-cell/src/exec.ts:51 and :289 |
| Gateway overrides host socket/data-dir discovery | v2/cli/src/target.ts:71 |

Account home names are CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR, GROK_HOME, KIMI_CODE_HOME, CURSOR_CONFIG_DIR and XDG_CONFIG_HOME. Runtime account credential variables remain sourced by the account service. In particular, ambient OPENAI_API_KEY or ANTHROPIC_API_KEY is not an account grant; an explicitly configured spec/bee/account value is preserved. Native bound accounts also derive their home from the account row for Cell projection, because their host-side homeEnvOf deliberately returns an empty map and formerly relied on daemon inheritance. Host native account behavior is unchanged.

The four Git identity names are the only inherited GIT_* names. Cell agents must obtain author/committer metadata from these names, explicit reviewed settings, or their own repository-local configuration; host ~/.gitconfig is not projected. SSH_* and unknown *_TOKEN names are dropped from ambient inheritance; the explicit per-bee APIARY_AGENT_TOKEN contract is separate. SHELL, COLORTERM, HTTP(S)_PROXY/NO_PROXY, SSL_CERT_FILE/SSL_CERT_DIR, NODE_EXTRA_CA_CERTS and REQUESTS_CA_BUNDLE are not inherited. Nodes requiring them need explicit per-harness settings before rollout; no ambient proxy or credential-helper exception is added.

With HIVE_DEBUG_CELL_ENV=1, the daemon records only the sorted names dropped from its inherited base in a debug.cell_env.dropped note. It never records values, and the debug knob is not inherited by the Cell.

## Verification boundaries

The unit tests exercise the actual runtimeEnvOf with fixture account service outputs; they do not read real accounts. A real HSR fixture proves an unknown daemon canary is still inherited by host children. A direct CellDriver fixture omits harness.env and proves the independent fallback drops that canary. The actual sandbox dual-endpoint fixture uses runtimeEnvOf, confirms canary and host route names are absent, explicit provider/Apiary fields and identities survive, and HOME is private. The staged CLI reads its own transcript through the gateway even when explicitly pointed at the deliberately exposed test-only main socket alias. The same sandbox process makes a real Git commit and checks the stored author/committer against fixture metadata without printing it. Tests explicitly reject ambient GIT_CONFIG*, GIT_SSH*, GIT_ASKPASS, GIT_DIR, SSH_* and unknown *_TOKEN inputs. An explicit host XDG_CONFIG_HOME string is preserved but its existing host directory is absent in the sandbox; a Muse account mapping and explicit data/state values survive environment construction. No Muse sandbox or real Claude compatibility claim is added.

The existing real Codex 0.156.1 fixture runs against its own local deterministic provider, with no credentials. The --codex-fixture mode of scripts/test-cell-gateway-joint.mjs supplies an euid-owned code-only Node/Codex overlay for the pre-existing toolchain-owner guard. It copies installed code, never a provider home, token or new package. Its two generations retain one provider session and leave the fixture account config unchanged. This does not prove real authentication, token refresh, or close the separately open Apiary service-principal escape.

The first direct Codex attempt correctly refused an unmapped toolchain owner. The first overlay attempt copied the Codex entry as a regular file, losing package-relative module lookup; preserving the internal code symlink fixed that test harness error. The HSR env test initially encountered a cross-filesystem rename during cleanup; its trash directory is now beside its fixture root. These were test setup failures, not suppressed source failures.


## Review disposition

Independent security review approved the exact-name inheritance filter and unchanged host substrates. Compatibility C1 was resolved under the orchestrator/Quiet ruling by admitting only the four non-secret Git identity names and a real in-Cell commit test. C2 was resolved by removing unnecessary private XDG config/data/state overrides while preserving their ambient default deny; the fixture proves an explicit host path is not a filesystem grant. The private HOME contract remains deliberate for sandbox:false Cells too. Native Claude onboarding/state differences remain unverified and Claude Cell rollout remains excluded under the existing T11 policy. Real authentication, expiry and refresh are still outside this proof.


## Rollout preconditions

Before deployment, supply GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME and GIT_COMMITTER_EMAIL through a reviewed hived service environment or explicit agent-spec/bee environment, or prove a repository-local identity. Do not assume systemd/launchd inherits the operator's shell or ~/.gitconfig. Record names/presence only, never the values. After the separately authorized deploy, a fresh sandboxed Cell must make a real commit as a per-node check. The local fixture proves the four-name plumbing, not fleet configuration.

Only Codex has the local deterministic-provider compatibility receipt here. Claude, Muse and other unverified Cell vendor harnesses remain excluded from rollout until their own reviewed projection and compatibility checks pass. Preserving a Muse XDG environment string is not a filesystem grant; a masked host home is still unavailable in a sandbox. Host HSR/tmux remain unchanged.

The machine-readable fixture summary is printed after assertions; its fixed booleans summarize the test rather than independently measuring production state. There has been no deployment, environment inventory, live socket probe, real credential read or proof submission under the Project API pause.

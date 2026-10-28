# T11j: Cell runtime environment

Base: review/hdm-T11-batch-hotfix e2a534a9. No deployment or real daemon/socket probe. Project proof submission is paused by the orchestrator's 15:39Z instruction until the Studio all-clear.

Only Cell runtimes change. Host HSR and tmux retain the existing full daemon environment and the same spec → bee → account → stamped identity precedence.

## Inheritance and explicit grants

The inherited daemon set is finite: PATH, LANG, TZ, TERM, HOME, USER, LOGNAME, TMPDIR; LC_ALL, LC_ADDRESS, LC_COLLATE, LC_CTYPE, LC_IDENTIFICATION, LC_MEASUREMENT, LC_MESSAGES, LC_MONETARY, LC_NAME, LC_NUMERIC, LC_PAPER, LC_TELEPHONE and LC_TIME. An unrecognized name, even LC_UNEXPECTED_SECRET or HIVE_UNKNOWN_SECRET, is not inherited. APIARY, provider tokens, loader variables and unknown HIVE variables are not inherited from hived.

Explicit agent-spec, bee and account environment remains a deliberate per-runtime grant, preserving custom harness settings. This is not an allowlist of operator-configured application variables: it is an allowlist of ambient daemon inheritance. Unknown ambient variables cannot cross by merely sharing a prefix. Operators must configure any required application/provider setting explicitly rather than rely on hived's shell environment.

HOME, XDG config/data/state/cache and build-tool cache paths are assigned to Cell-private state. Linux sandbox TMPDIR is the private /tmp mount; other Cell launches use the Cell-private temp directory. These directories use the existing fd-rooted, O_NOFOLLOW private-directory helper. The existing launcher continues to set its fixed PATH.

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
| HIVE_BEE, HIVE_BEE_ID and HIVE_PARENT identity stamps | v2/daemon/src/daemon.ts:562 |
| HIVE_CELL and HIVE_CELL_SPACE; independent driver fallback | v2/driver-cell/src/driver.ts:773 |
| APIARY_GATEWAY_URL, APIARY_SESSION_ID, APIARY_AGENT_TOKEN | Explicit runtime contract in the T11j request; existing gateway env forwarding in src/accounts/gatewayMcpSeed.ts:87 and its HIVE identity additions at :20 |
| Cell-private HOME / temp / XDG and route stripping | v2/driver-cell/src/sandbox.ts:134 |
| Cell-exec already has an explicit inherited set, now also private HOME/routes | v2/driver-cell/src/exec.ts:51 and :289 |
| Gateway overrides host socket/data-dir discovery | v2/cli/src/target.ts:71 |

Account home names are CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR, GROK_HOME, KIMI_CODE_HOME, CURSOR_CONFIG_DIR and XDG_CONFIG_HOME. Runtime account credential variables remain sourced by the account service. In particular, ambient OPENAI_API_KEY or ANTHROPIC_API_KEY is not an account grant; an explicitly configured spec/bee/account value is preserved. Native bound accounts also derive their home from the account row for Cell projection, because their host-side homeEnvOf deliberately returns an empty map and formerly relied on daemon inheritance. Host native account behavior is unchanged.

With HIVE_DEBUG_CELL_ENV=1, the daemon records only the sorted names dropped from its inherited base in a debug.cell_env.dropped note. It never records values, and the debug knob is not inherited by the Cell.

## Verification boundaries

The unit tests exercise the actual runtimeEnvOf with fixture account service outputs; they do not read real accounts. A real HSR fixture proves an unknown daemon canary is still inherited by host children. A direct CellDriver fixture omits harness.env and proves the independent fallback drops that canary. The actual sandbox dual-endpoint fixture uses runtimeEnvOf, confirms canary and host route names are absent, explicit provider/Apiary fields and identities survive, and HOME is private. The staged CLI reads its own transcript through the gateway even when explicitly pointed at the deliberately exposed test-only main socket alias.

The existing real Codex 0.156.1 fixture runs against its own local deterministic provider, with no credentials. The --codex-fixture mode of scripts/test-cell-gateway-joint.mjs supplies an euid-owned code-only Node/Codex overlay for the pre-existing toolchain-owner guard. It copies installed code, never a provider home, token or new package. Its two generations retain one provider session and leave the fixture account config unchanged. This does not prove real authentication, token refresh, or close the separately open Apiary service-principal escape.

The first direct Codex attempt correctly refused an unmapped toolchain owner. The first overlay attempt copied the Codex entry as a regular file, losing package-relative module lookup; preserving the internal code symlink fixed that test harness error. The HSR env test initially encountered a cross-filesystem rename during cleanup; its trash directory is now beside its fixture root. These were test setup failures, not suppressed source failures.

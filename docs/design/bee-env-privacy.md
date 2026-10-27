# Bee environment observation privacy

Protocol `v2/2` replaces public bee `env` maps with sorted `envKeys` arrays.
Authoritative `BeeRow.env`, runtime launch env, runner configuration and stored
audit evidence retain their original values. Public projections never become
launch inputs. `--reveal-env` is removed; RPC `revealEnv` claims other than
absent/false receive `caller_not_trusted`. Existing authentication has no proven
human-read principal. Agent self-ownership, parentage, caller parameters, same UID
and registered service identity cannot enable arbitrary value reveal.

## Surface census

| Surface | Boundary |
| --- | --- |
| view, list, children, fork, rename, tag, setArgs | Typed `PublicBeeRow` / `toPublicBee`; RPC egress projection |
| spawn, reconfigure, cached results, dedup replay and in-flight joins | Default RPC result projection, including legacy persisted raw results |
| commands, audit.tail, move/handoff payloads | Shared projection of `env`, `previousEnv`, `targetEnv` and env-set `previous` |
| snapshot/watch and deltas | Public projection; stored evidence stays unchanged |
| CLI JSON/human view/list/children/events, daemon-down reads | Same typed bee projection and audit projection before rendering |
| transcript/tail/last headers, including raw/follow | Audited runner-host session-log writer: only harness stdin/stdout evidence, no generated launch env/header. Preserve evidence bytes |
| status/show | No separate bee env serializer; daemon status contains health/service facts, account/template show belongs to those contracts |
| launch/resume specs and harness args | Runner launch env is internal; no generated launch-env command strings in public bee metadata. User-supplied args/body text are not secret scanners |
| MCP | Honeybee RPC boundary applies; Apiary must independently strip service-only paths from agent MCP responses |

Template configuration responses (including export/import) and template audit
events retain their intentional configuration env. Track/package receipts have
no env and use the default projection. Account lease mint env and
`LiveGateway.env` used to launch MCP gateways retain their credential-plane
semantics. These are explicit exceptions, not bee observation surfaces.
`ENV_TRANSFER_VERBS` enumerates response exceptions; all other replies, errors
and watch events are projected by default. Public projection is idempotent and
also strips cached/injected `operatorLocalHomes`.

## Dedicated local service feed

`mirror.local.snapshot` and `mirror.local.watch` advertise capability
`mirror.local.homes.v1` only when LocalRpcTrust and peer credentials are ready.
They add `bee.operatorLocalHomes` with exactly `codexHome`, `claudeConfigDir`,
`grokHome`, each an absolute path string without NUL/newlines or null. Only
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME` supply these fields.

Authorization requires enabled, ready LocalRpcTrust, a verified registered direct
Unix peer (UID/PID/process birth), and no session/agent/MCP/human/phone context.
Other callers receive the ordinary public shape, with the property absent.
Authorization is checked on each delta flush; expiry or replacement closes the connection before
reading or sending another delta. The daemon logs the fixed category
`local_trust_lost`; existing transport close carries no typed reason to the client. General snapshot/watch and agent-context requests clear the
private subscription mode. Per-connection mode and batch separation prevent a
private subscriber from affecting a public subscriber.

Private `bee.created` deltas carry `payload.bee.operatorLocalHomes`; env-set and
handoff-switch deltas carry `payload.operatorLocalHomes`. Explicit nulls clear
removed or invalid paths. Raw env maps never travel on this feed. This is existing
local service authorization, not human authentication or same-UID confinement:
processes able to read the existing registration key remain a known trust limit.

## Rollout

Apiary must first accept both `v2/1` and `v2/2`, consume the dedicated feed only
when advertised, and keep its three-home legacy compatibility during rollout.
Old protocol clients receive an explicit protocol mismatch from new Honeybee.
Deploy preflight alone negotiates old `v2/1` for `update.status`, with all other
verbs forbidden on that compatibility connection. The withdrawal capability
probe also understands both hello versions.
Root `fe3b05ec-f74a-408a-8fa8-71a4dc16f805` owns removing Apiary's compatibility
fallback once every deployed node supports the new private-home capability.
Do not deploy Honeybee first. No deployment is part of this change.

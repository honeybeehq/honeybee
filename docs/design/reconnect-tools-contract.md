# Session-preserving tool reconnect

`bee.reconnectTools.v1` in the owner node's daemon hello and `deployInfo`
advertises this control. It reconnects Honeybee-managed native MCP gateways on
an existing Codex HSR or Cell runtime. It does not spawn, stop, revive, archive,
change runtime generation, or inject a conversation turn.

## RPC and CLI

Mutation: `bee.reconnectTools {beeId, idempotencyKey?}`. The caller supplies a
stable key when it needs retry safety. Reusing it returns the same command's
current result; using it for another bee or mutation is refused.

Authoritative read: `bee.reconnectTools.get {beeId, commandId}`. Both return:

```ts
{
  commandId: number;
  beeId: string;
  generation: number;
  state: "queued" | "running" | "done" | "failed";
  receipt: null | {
    outcome: "reloaded" | "stale_generation";
    threadId: string | null;
    targets: string[];
    modelTools: "refresh_pending_next_turn" | "not_refreshed";
  };
  error: null | {code: string; message: string};
}
```

Acceptance is `queued`, never completion. Poll the read on the owning node;
there is no new mirror field. Existing core command snapshots and audit replay
retain the command and its owner receipt.

`done/reloaded/refresh_pending_next_turn` means the owner reconciled native
configuration, wrote a fresh per-gateway nonce through Codex's native API, and
received the reload acknowledgement. It does **not** mean a model request has
been observed with refreshed tools. Suitable UI copy is “Reconnect requested —
refresh pending next turn.” `done/stale_generation/not_refreshed` is an explicit
no-op with empty targets, never a successful reconnect.

The thin CLI is `hive reconnect-tools <bee> [--idempotency-key key]` and
`hive reconnect-tools <bee> --command-id <id>`, both supporting `--json`.

Admission failures use `reconnect_unsupported`, `reconnect_not_ready`,
`reconnect_not_found`, or the existing request/idempotency error codes.
Execution failures are durable, with specific error codes such as
`reload_rejected`, `reload_timeout`, `unsupported_runner_host`, or
`runtime_unavailable`. Timeout means the effect's outcome is unknown. It is
not silently retried. Transient pre-effect readiness refusals have bounded
backoff; waiting for a live turn to finish has no elapsed-time inference.

## Ownership and ordering

Schema v26 adds `reconnect_tools` to the existing durable command queue. Claims
wait while the target generation is booting or running. The driver then checks
its own turn facts and pending deliveries, both before and after asynchronous
configuration work. It fences delivery during that work. Queued busy reconnects
still allow normal mid-turn send and interrupt; mailbox acceptance is always
independent of reconnect. At idle, new turns wait for the reconnect command.

The native home comes from the exact generation's runner configuration. The
existing gateway seed owner reconciles live registrations and holds its config
lock through the subsequent native writes and reload. Only those registered
gateway names are targets; arbitrary user MCP servers are untouched. Gateway
names outside the native API's verified bare-key subset are explicitly refused.

The Codex adapter emits only these fixed native operations:

1. `config/value/write` for each target's
   `mcp_servers.<name>.env.HONEYBEE_MCP_RECONNECT_NONCE`, with `mergeStrategy:
   "replace"` and a stable bee/generation/command token.
2. Parameterless `config/mcpServer/reload` on the existing app-server.

No arbitrary RPC forwarding is exposed. Other harnesses are refused. Existing
v15+ hosts already have the required write lane and generation-specific output
journal; they need no host replacement. Legacy hosts without that recovery
evidence and degraded adoptions are refused.

Native responses are normalized by the adapter and retained in the generation
journal. Adoption recovers responses before the committed cursor as well as new
output. An interrupted command returns to `queued`; a recovered reload response
settles it without another reload. A changed generation audits and settles the
old intent as a no-op. Tool-control failures do not stop or flag the conversation.

## Verification and Codex limits

The core, driver, Cell, seed-owner, daemon RPC, and CLI tests use disposable
stores/processes. The daemon test's native peer is `fake-codex.mjs`; it proves
owner control/recovery, not model tools. The separate opt-in test runs the actual
installed Codex against a deterministic local Responses endpoint:

```sh
HONEYBEE_REAL_CODEX_RECONNECT=1 node --test v2/driver-hsr/tests/harness/codex-mcp-reconnect.test.ts
```

The real-owner acceptance test also drives the actual Honeybee socket and
detached host with installed Codex and local deterministic inference:

```sh
HONEYBEE_REAL_CODEX_RECONNECT=1 node --test v2/daemon/tests/reconnect-tools.real-codex.test.ts
```

It queues reconnect during active inference, verifies same-key replay and the
same bee/process/generation/thread, changes registered shim arguments, and then
reconnects the unchanged registration again. Model requests must receive each
new tool generation on a normal turn after native startup readiness. The test
also preserves unrelated native settings and the fixture's configured timeout;
it does not change production timeout policy or touch real account homes.

Codex 0.154.0 keeps the same process and thread while the model tool definitions
change after the native nonce write and reload. An unchanged-config reload is a
negative control and retains stale tools. Repeated nonce changes refresh again.

Codex applies MCP refresh when a normal turn starts. Optional MCP startup can
finish after one or more turns' model requests, including on initial startup. Existing
user startup timeouts are preserved; reconnect does not impose a new timeout. The fixture
proves that such a request can contain no MCP tools, then a normal turn after
the native `mcpServer/startupStatus/updated` ready notification sees the new
catalogue. Waiting for that notification before allowing the first post-reload
turn would deadlock. Production does not change optional servers to required,
invent a force parameter, or inject a turn to hide this harness limitation.

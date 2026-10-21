# Champion SDK adapter slice

Run the isolated, auth-free end-to-end fixture from the repository root:

```sh
bash v2/experimental/champion-harness/verify.sh
```

Expect `FIXTURE PASS` after checks for committed acceptance, duplicate input, writer exclusion, restart replay, synthetic auth-success rejection, private stdout, correlated model-output timestamps, kill switch, and unchanged CLI selection. Fixture databases and logs stay under `.audit/champion-adapter/`. These are fixtures: not checked on real data / live SDK unverified.

The bridge is an HSR child. It accepts version 1 JSON lines (`mail` with numeric Honeybee messageId and body, or `interrupt`) and writes only typed frames. `accepted` means the input committed to the bridge inbox; it is private transport confirmation, never a visible human acknowledgement. Model text stays in private SQLite evidence. Only an explicit `human_output` event may cross stdout, with correlated `query_start`, `first_token`, and `first_visible` timestamps. In this slice the real SDK has no tell/react facade; that producer belongs to T3. The fixture exercises the typed output seam without treating arbitrary assistant text as visible output.

One `BridgeState` owns the WAL connection. A separate SQLite connection holds an exclusive OS-managed writer lock for process lifetime; it releases on death without timeout stealing. Owner identity and monotonic epoch persist in the state DB. Inbox dedupe is `(ownerNode, beeId, messageId)`; body mismatch refuses. Running inputs replay after a process crash; unsuccessful or explicitly interrupted turns remain `held`, with their evidence preserved. This slice enables no tool effects, so restart does not replay outside actions. Later slices must reconcile effect intents before extending this replay rule.

`execution_backend=champion_sdk` is the persisted route selector. `executionBackendOf` is the only parser; absent selects `cli`, unknown/conflicting selectors refuse. Spawn RPC accepts `executionBackend: "champion_sdk"`, persists the tag, and requires Claude HSR, the explicitly pinned account, and `autoswap=false`. Ordinary tag edits cannot change routes or remove that safety tag. Route handoff, fork, account swap and home move are refused for opted-in bees until quiesce/export support lands. No schema version changes. Existing bees retain their routes. Recovery gets the same tags from the durable bee row and resolves the same adapter, including fenced HSR adoption.

Real launches are disabled unless the operator supplies `<daemon dataDir>/champion-sdk-policy.json` with version 1, `enabled: true`, `realHomeApproved: true`, and a successful independently reviewed refresh proof. The proof names the pinned account, exact CLI path and proof id. Policy also requires `cliPath`, `identity`, `allowedTools` (only `mcp__apiary__*` names), and explicit `mcpServers: { apiary: { command: "/absolute/shim", args: [] } }`. Server env overrides are refused. No approval file is created by the implementation or fixtures for a real runtime.

The daemon refuses launches outside Tormods-Mac-Studio on macOS and verifies that the SDK uses the same CLI executable as Hive. It constructs an environment allowlist, then wraps the whole bridge and its CLI descendants in `sandbox-exec`. Writes are limited to the harness state dir, pinned CLI config dir and private TMPDIR. Allowed identity keys are `HIVE_BEE`, `HIVE_BEE_ID`, `HIVE_PARENT`, `HIVE_V2_DATA_DIR`, `HIVE_V2_ENDPOINT`, `HIVE_SESSION_ID`, `HIVE_NODE_ID`, `APIARY_GATEWAY`, `APIARY_GATEWAY_URL`, `APIARY_SESSION_ID`, `APIARY_AGENT_TOKEN`. Ambient provider auth variables are omitted. SDK settings sources are empty, MCP config is strict, built-in tools are empty, and the T2 auto-allow list is empty with a permission hook that denies tool execution. The policy list reserves the later facade allowlist; T2 grants none of those calls. `loaded_config` records actual SDK init tool/server names and the explicitly configured empty settings-source list. A non-Apiary loaded tool/server aborts the query. Actual macOS enforcement and SDK-loaded configuration still require Studio verification.

The bridge never invokes a refresh API itself; the selected CLI may refresh using its existing keychain behaviour. Queen requires a concurrent Hive refresh/bridge turn proof before enabling this path. Removing, disabling or invalidating the policy stops new launches and the bridge polls it every 250 ms to abort its active query and close. SDK cancellation and child teardown latency remain unverified on Studio.

After the real-HOME approval, independent refresh proof, reviewed policy and build are in place, the exact one-turn Studio check is:

```sh
node --experimental-strip-types v2/experimental/champion-harness/studio-check.ts \
  /absolute/approved/champion-sdk-policy.json \
  /absolute/champion-home/sdk-verification \
  sdk-verification-bee \
  /Users/trmd/.hive/homes/claude-claude-trmd-trmd.me
```

Use a fresh verification home; never aim this command at an active Champion store. It uses the approved explicit policy, environment builder and sandbox wrapper, then feeds one input and closes stdin. Expect typed ready/accepted, loaded_config, query/token timing, usage, and `turn_finished` with `outcome: success, served: true`. An auth boundary followed by synthetic SDK success must finish `auth_error`. It emits no model-authored chat until the later tell/react facade exists. The refresh proof must come from the separately authorized Studio verification workflow; this command cannot bypass its own launch gate.

Queen must review launch/protocol/account selection and the Studio proof before landing. No deployment is included. Before T2-lanes, inspect pinned SDK 0.3.306 and run the design's separate two-query cancellation, MCP identity, resume and aggregate quota gate. It has not run in this slice.

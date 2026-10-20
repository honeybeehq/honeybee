Task B proves durable quota interruption and continuation on a real isolated Honeybee daemon with fake Claude accounts in shadow mode. It does not claim active-owner allocation, no-candidate timers, lease sagas, or real Apiary rendering; those are tasks C and G.

Run from the Cell with an isolated invoking HOME and a private short lab root:

```sh
lab_root=$(mktemp -d /var/tmp/hb-B-XXXXXX)
env -i HOME="$PWD/.agent-home" PATH=/usr/local/bin:/usr/bin:/bin TMPDIR="$lab_root" NODE_OPTIONS="--import=$PWD/.proof/B/trash-cleanup.mjs" node .proof/B/lab.ts
```

The preload redirects test cleanup into retained trash. It also supplies explicit scheduling fault injection: a file pauses quota reconciliation, another pauses mail delivery, and the synthetic-retry case holds generation 2 delivery. These hooks change scheduling only, not recovery decisions or stored observations. The between-turn harness emits a native quota event after a successful turn; the boot-failure harness exits one successor before provider output. All accounts and credential documents are synthetic. No provider or deployed runtime is used.

Read summary.json for the scenario verdicts. Each scenario has a native journal, RPC/audit receipt and daemon log. restart.before.json proves the rebind committed with no continuation yet; restart.rpc.json proves one continuation after daemon SIGKILL and restart. synthetic-retry.rpc.json proves a continuation accepted at synthetic readiness remains rotating and is delivered on a later automatic generation. queued.rpc.json and queued-early.rpc.json prove continuation delivery precedes newer queued mail. postenqueue-stop.rpc.json proves manual stop cancels pending continuation mail.

Recovery mail is inserted once with durable continuation IDs. Synthetic readiness permits mailbox insertion; interrupted recovery becomes resumed only after real provider evidence. Between-turn capacity recovery creates no mail. Existing boot budgets, spawn_failed flags, command failure receipts and invariant-1 telemetry continue to govern stalled recovery; this module does not invent successful work or complete action attempts.

The review branch is review/sar-B-quota-continuation. DEPLOY HOLD remains. No PR is opened by this worker.

# Mailbox-only bees

A mailbox-only bee is an address, not an agent. It has a bee identity and a
durable mailbox in hived, and nothing else: no model process, no account, no
Cell, no usage, and nothing that delivers to it or wakes it. External
participants (for example Grok Bot reaching the Studio over SSH) use one to
receive messages from bees.

## Agent kind

- `inbox` is a built-in agent. It needs no entry in `config.json`.
- `stub` is an alias for `inbox` only when no agent named `stub` is configured.
  The daemon test suite configures a real `stub` test harness, and a
  configured name always wins.
- The bee row stores `agent = 'inbox'`. `isInboxAgent` in `v2/core/src/types.ts`
  is the single predicate.

## State model

- `createBee` writes generation 1 already `stopped(clean)` with no pid. The
  runtime graph is unchanged: nothing leaves `stopped`, so there is nothing to
  boot, adopt, reconcile, hang-stop, or mark crashed after a daemon restart.
- `applyWakeIfNeeded` returns `mailbox_only` for these bees. That one gate
  covers `send`, the boot wake sweep, and boot retries; no `send_wake` is ever
  enqueued.
- `spawn`, `send_wake`, `revive`, and `reconnect_tools` commands and
  `reviveBee` are refused. Stop, archive, unarchive, and delete work as usual.
- Spawn rejects `--substrate cell`, an explicit account, and harness args.
- Excluded from: I1 pending-mail telemetry, daemon step-snapshot inputs,
  auto-title, and account rotation/usage (no account is ever bound).
- `hive wait` treats an inbox bee as settled. `hive run` and `xa`
  refuse it because there is no runtime to drive.

## Read state

Unread means undelivered. A poller acks mail with `mail.ack`, which marks
messages delivered on the current generation and writes `mail.delivered`
with `ack: true`. So the mailbox row stays the only truth, `mailbox --unread`
reflects acks, and `hive events --bee <bee> --kind 'mail.*'` shows both
arrivals (`mail.enqueued`) and acks. Acks are only accepted for inbox bees;
re-acking is a quiet no-op.

## Surface

| Need | CLI | RPC |
| --- | --- | --- |
| Create | `hive spawn grokbot inbox` | `spawn {agent: "inbox"}` (`commandId: null`) |
| Send to it | `hive send grokbot "<message>"` | `send` (sender recorded as usual) |
| Poll | `hive mailbox grokbot --json --since <id> [--unread]` | `mailbox {beeId, sinceId?, unread?}` |
| Ack | `hive ack grokbot <id>` or `hive ack grokbot --all` | `mail.ack {beeId, throughId}` or `{beeId, all: true}` |
| Stream | `hive events --bee grokbot --kind 'mail.*' --json` | `audit.tail {beeId}` |

Capability: `mailbox.only.v1`.

Bees are not told about inbox bees in the preamble. Contact is ad hoc: the
external participant puts reply instructions in its own messages (for
example: reply with `hive send grokbot "..."`).

## Outbox forwarder hook

`HiveDaemonDeps.forwardMailboxOnlyMail({ bee, message })` runs after a `send`
to an inbox bee commits, off the RPC transaction. A failure is logged as
`mailbox_only.forward_failed` and never affects the accepted mail. Production
wires nothing today.

A future webhook or email forwarder should plug in here and stay at-least-once
by acking only after the remote side accepts: forward, then call
`ackMail(beeId, message.id)`. Anything not acked stays unread and can be
re-forwarded from `mailbox --unread` after a crash or restart.

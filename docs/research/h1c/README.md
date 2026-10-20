# H1c delivery confirmation proof

Uncertain confirming deliveries now have a durable intent before the stdin effect. A runner receipt binds mailbox ID, encoded-line digest, bee and generation. Recovery queries only the original authenticated host, and retries only a proven unwritten attempt. Unknown outcomes stay visibly undelivered. Explicit resend creates a linked replacement at the original FIFO position; drop and resend are generation-fenced, idempotent and audited.

The original production cause for bee84ab31f1 remains undiagnosed: both pending ACK and socketBroken reproduce in the historical driver lab. Refusals preceded the disk-full window. Nothing here restarts, deploys to, or inspects the live daemon.

## Reproduce

Build first: source fixtures require the native peer credential artifact under dist/v2/peercred for authenticated writes. A missing artifact fails closed. Use an owned mode0700 short directory under /var/tmp, with fake HOME, caches and TMPDIR inside that directory. Commands below assume those variables were assigned to owned paths; run the shell with login:false.

```sh
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" npm run build
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab-h1c-store-confirmations.mjs "$lab_root"
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-crash-windows.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-host-receipts.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-upgrade.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-upgrade.mjs --late-ack
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-upgrade-lock.mjs
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$lab_home" TMPDIR="$lab_root" node scripts/lab/h1c-operator-rpc.mjs
```

lab.log is the unmodified stdout from the seven sequential runs, including exact Node commands. The fake Codex process records only request ID/method. Journal ENOSPC is fault-injected; no filesystem was filled. SQLite rollback and quick_check receipts use disposable stores.

The eleven crash/lane cases each assert exactly one target stdin write. They cover failed intent commit, committed intent before write, lost ACK, failed settlement commit, settled restart, unknown held restart, held-to-awaiting transition before retry, stale steering context, degraded proven-unwritten recovery, prewrite lane outage and unreadable capability status. The host receipt lab also checks duplicate tagged writes, count/age retention and identity fences.

Upgrade runs prove fresh mail reaches a surviving old host, delayed ACK stays pending without an operator-action window, and a positive original ACK arriving only after adoption settles an unknown hold with no new write. The exclusive-lock lab blocks an early migration opener, then includes the old writer's later mailbox ID in the watermark. The RPC lab delivers a replacement while another held message remains behind it, before dropping that held tail.

## Contract and limits

Wire capability: delivery_status.v1. Replies contain exactly id, digest and state. Receipt retention is4096 entries/24h; retired or unknown IDs remain held. Frames are limited to16Mi decoded characters. Application refusal stays held conservatively.

Operator RPCs mail.delivery.resend_anyway and mail.delivery.drop take {beeId,messageId,generation,idempotencyKey}. Generation is the current BeeView generation. Only held rows are actionable. These ordinary mutate RPCs use Honeybee's existing same-UID admin boundary: a same-UID process can call them directly. The separate Apiary main-frame surface is gated by T29g; this change adds no CLI action, phone or MCP path and claims no UI proof.

The first upgrade snapshots mailbox ID and per-bee generation cohort under the exclusive writer lock. Pre-upgrade ambiguous rows may need operator decisions. Post-upgrade generations and previously proven-unwritten releases avoid repeated boot holds. An operator should obtain the hold count with a separately authorized read-only pre-deploy query; no production count is claimed here.

Two independent Opus reviewers read the wire/store/recovery changes, with no remaining Medium-or-higher findings. They did not rerun these labs. The last narrow review covers e2b1fd0c. Review corrections and verification limits are in decisions.tsv and gates.log.

The brief forbids new unit tests and code comments, overriding AGENTS.md's general add-tests rule. Existing fixtures were updated, including the deliberate urgency.d3c expectation: a positive ACK settles in the same step that later now-mail interrupts; the interrupt count remains one. The repository verification skill is unavailable, a known setup gap.

The daemon gate has two environment-blocked delivery-file-read cases: the fixture requires a short root outside private mounts. Allowed owned roots cannot satisfy that condition. Its helper and test are unchanged from base8d71abd2; remaining files and repaired failures were run separately. Quiet's masked gate can cover these two cases. Do not interpret this proof as an unqualified full-daemon pass or permission to deploy.

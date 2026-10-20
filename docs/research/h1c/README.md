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

Queen #92 tightened resend/drop to a registered direct local service; same UID alone is insufficient. Disabled trust and unregistered clients fail closed. Apiary H1d must use its trust-registered connection and advertise mail.delivery.confirmation.v1. Its main-frame T29g UI is a separate task; this backend claims no UI preview.

Application refusal receives one durable automatic retry, then a visible refused hold. Auth failures close the lane, back off, and become host_auth_failed after30s. Oversized frames become message_too_large before any write. Proven-unwritten retry authorization expires after30s into lane_unavailable; recovery requires a real plan and fresh host evidence. Frozen upgrade heads normally require one operator decision, rather than one per queued message. See design.md and queen-review.md for the full contract and twelve-item response.

review-lab.log contains actual raw lab stdout, with source-log names separating runs. It covers each Queen Medium, bounded refusal, atomic multiline intent, stalled-ready visibility, authority, legacy projection and actual Cell authentication. lab.log retains the original crash/receipt runs. Journal ENOSPC is fault-injected; no filesystem was filled. Store/audit bounds are16MiB UTF-8 with32KiB reserve; host receipts retain4096 entries/24h.

Two independent Opus source reviewers cleared the chain throughfedf2eb3 with no Medium-or-higher findings. They did not run labs. A remaining Low is conservative timing: intent.since can cause an early/brief lane_unavailable hold. Production pendingACK versus socketBroken remains undiagnosed. No live daemon access, restart or deployment occurred; DEPLOY HOLD remains.

Root tests, root/v2 checks, build,163 HSR tests and287 driver2 tests (22 skips) pass. Core/fleet604 passed in the isolated store worker; remaining daemon/CLI files and six repaired pointer fixtures pass separately. Two delivery-file-read OS setup cases require a short root outside private mounts unavailable under this authorization. The root-selection helper and those two case bodies are unchanged from base; the file's other pointer expectations were deliberately updated. This is not an unqualified full-daemon pass. Quiet's masked gate can cover those two cases.

Existing pointer fixtures now treat the durable intent as authority: lost volatile pointer-attempt state settles from a positive ACK, while the passive pointer receipt remains unknown. The urgency.d3c fixture deliberately settles a positive ACK in the same step a later now-message interrupts; interrupt count remains one. No new unit tests or code comments were added under the explicit Project brief, which overrides AGENTS.md's general add-tests rule. The missing repository verification skill remains a setup gap.

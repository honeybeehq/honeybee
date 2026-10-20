# C final proof

Branch: review/sar-C-quota-recovery. Base: 9d387f0ee465b5738901e7a72ec3243f6fae8e5f (B final), based on A 5856406ef71c0b57ff5089c049b82b7c0ffc3285. Production source measured: ac0054086fad2696a88fdd1bc490dd561ebeef26. Native delivery assertion measured: cd2f95d19d266954e1d3db9092dfe96c860ee81d, identical production source.

Eight of eight real-daemon scenarios pass: Claude weekly replay and Codex native continue without send; all exhausted source reset; unknown reset with null retry; autoswap=false; active owner-required; daemon restart during wait; two simultaneous unknown-reset waits. Waiting cases hold 33 seconds; concurrent case holds 35 seconds and shows exactly two probes per account about 30 seconds apart. Each resumed obligation records one continuation and the original source delivery remains generation 1.

The focused native Codex test also passes: cached source usage 85 is replaced by a fresh 100 baseline, later fresh usage 5 restores the same source with null reset timing; generation 2 receives one continue message without a send. Its three source probes are about 30 seconds apart.

Checks: check, v2:check and build pass. Existing accounts-rpc, loops and runner-host suites pass 128/128. Account allocation and checkpoint digest suites pass 9/9. Logs are in gates/. No new unit tests or production code comments.

Read lab/summary.json, the corresponding RPC snapshots/journals/usage logs, and native-unknown-source/summary.json. implementation.diff is the production diff against the exact B base. This frozen directory supersedes all older or failed interim receipts elsewhere in .proof/C.

Try with an isolated fake invoking HOME: bash .proof/C/verify.sh; bash .proof/C/run.sh; bash .proof/C/codex-unknown-source.sh. Each wrapper creates a 0700 /var/tmp root and sanitizes environment, cache paths and fake provider endpoints; disposal uses trash semantics. No production runtime, real credentials or account priorities changed.

Active Apiary owner integration belongs to C2. Its worker confirmed real apiaryd process restart, claims and no-send continuation and carries both source baseline fields. C publishes the exact RPC/snapshot/audit seam in Project contracts/quota-events.md, C owner seam (v15). Full UI presentation and fleet-wide release are separate Project tasks. Queen review and DEPLOY HOLD remain.

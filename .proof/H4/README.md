# H4: held wakes and damaged Claude credential files

Base: `d532471e50a7ddd82d075f1cc7afb9b3285f2123`. Branch: `review/sar-H4-held-wake-readiness`. DEPLOY HOLD. Queen reviews credentials; Needle opens the PR and merges only after review.

The five-line diagnosis was sent before implementation. Project publication at `research/h4-held-wake-readiness.md` succeeded after initial edits because four writes failed on membership timeouts or a locked Project database.

## Diagnosis on base main

- `v2/core/src/store.ts:3376`, `:3411`, `:3915`: send accepts mail and queues/reuses one wake transactionally.
- `v2/daemon/src/daemon.ts:1217`, `:1267`, `:1336`: due starts are held before claim by credential readiness. Current main already rechecks every tick (`:1183`); the existing admission hold test proves restoration without new mail. The permanent no-retry report is not independently reproduced on this main snapshot.
- `v2/daemon/src/loops.ts:1984`, `:2007`: I1 records overdue accepted mail, but the generic account hold had no account/bee attention state.
- `v2/daemon/src/accountsService.ts:2042`, `:2089`: readiness judges the HOME primary file, else vault. Verify (`:3597`, `:3180`, `:3297`) instead probes the freshest HOME/Keychain/vault material. Historical verified health can coexist with a false expired-file verdict.
- macOS: the account recipe and `rotateClaudeChain` describe Claude reading its home-specific Keychain item first. Linux has no Keychain fallback; the runtime needs its HOME file. Activation preserves a populated stub on both platforms.

## Result

Damaged Claude access data is `credential_file_damaged`, exposed on the account mirror and CLI with a login action. A successful provider probe repairs only a damaged, owned, local, noncentral HOME under the existing Claude OAuth/storage locks. It rechecks authority, lease/recovery fences, row identity and the complete verified credential revision before writing atomically. It never repairs protected native HOMEs, leased material or demoted/central authority. A live sibling does not block this locked repair. Diagnostics contain account id and outcome, never credential values.

A blank access candidate retains its refresh path, forces refresh even with a future expiry or a healthy live sibling, and ranks with effective expiry zero so it cannot beat usable access based on a corrupt timestamp. No new candidate pool or credential authority was added.

Held starts keep their queued command and accepted FIFO mail. Existing periodic checks remain, capped at a one-second scheduling interval while holds exist; the default 200ms cadence is unchanged. Validated login/verify/refresh requests a tick. Damaged material receives verification at most once per account every 30 seconds. This is a fixed bounded retry interval, not exponential backoff.

At 60 seconds from command enqueue, a still-held start receives the durable `auth_needed` flag with `account_credentials_unusable` detail. The account exposes its precise current refusal. Stopped/idle auth boundaries need the human; a working bee's automatic auth recovery does not gain a new needs-you indication. Release clears only flags with the hold-owned prefix. Boot clears orphaned hold flags after command replay while preserving runtime-owned auth flags. Quota recovery maps the damaged-file code to `credential_login_required`.

## Reproduce safely

Check disk headroom, create a 0700 run root under `/var/tmp`, and invoke Node with `login:false`, `env -i`, `HOME` and `TMPDIR` both set to that root, `PATH` containing Node, and `HIVE_NO_KEYCHAIN=1`. No real credentials or HOMEs are used. Each script rejects an unisolated HOME/TMPDIR. Run from the repository root:

```
node .proof/H4/readiness-lab.ts
node .proof/H4/daemon-repair-lab.ts
node .proof/H4/wake-lab.ts
```

The first uses injected fake sources to cover macOS Keychain, a live sibling, Linux vault, refreshable blank access with and without a live sibling, no valid source, and stopped/running/cleared view projections. The second runs disposable daemons through verify RPC and checks boot cleanup ownership. The third waits through the real 60-second bound, asserts needs-you and the watch delta, then restores readiness and checks that the same wake delivers without new mail or consumed attempts. It reads details via `audit.tail`, never the live database. macOS is modeled through injected Keychain fixtures; no actual macOS Keychain or native Claude process was tested.

Keep caches in the run root. Shut down only lab-owned processes and trash lab artifacts after collecting receipts.

## Validation and limits

Receipts in `receipts/` contain the final lab and gate results. The existing E2 proof lab was also run: all eight Claude/Codex cancellation, opt-out, owner and credential cases passed. Its generated artifacts were saved locally and the original tracked E2 receipts restored. The existing C4 lab also passed: one source restoration/continuation, four negative claims released, no unconfirmed reservations.

`npm test` fails the legacy inherited-stdout descendant-reaping check. The exact test also fails on separately built clean base-main sources exported inside this Cell: same timeout and `nativeState:live`, 5797ms on base versus 5811ms on H4. This is pre-existing on d532471e, reproduced, not a green gate.

The daemon suite's two sandboxed delivery-read cases cannot create their required short, non-private fixture path under this Cell's location and the mandated `/var/tmp` run root. They fail identically on the base-main source export. All remaining 90 daemon/CLI files passed when run separately; no sandbox policy was changed.

The repository verification skill is missing (known setup issue). No new unit tests or code comments were added, as explicitly requested. The view override, damaged/refresh classification, candidate ranking, repair fencing and startup flag cleanup have lab coverage and existing-suite coverage, but dedicated unit tests remain follow-up test debt. Hold timing uses the daemon's wall clock and command enqueue time; the lab proves the real bound.

Known source-selection limit: when only expired access remains, a blank HOME with a newer refresh chain can rank behind an expired nonblank vault copy. This patch preserves the existing expiry-based authority strategy and does not retry alternate refresh chains after provider rejection. A stale consumed vault refresh could still force login in that unproven case. Queen should review this edge; automatic fallback refresh attempts need separate authority analysis.

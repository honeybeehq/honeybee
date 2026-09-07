# Independent review of automatic-title membership Unit 2

Reviewed `a9e5ea91dcf55f207dc3398e3d671fa5b3f23476` directly
against its sole base, `bc6554b6c562019011fb9d3e23cb2e9013bc765f`.
The commit changes only:

- `v2/daemon/src/autoTitle.ts`
- `v2/daemon/tests/auto-title-membership-cache.test.ts`

## Verdict

No correctness blocker found. The implementation matches the private,
store-backed quiet-cache design in `synthesis.md`. It does not change the
general dependency contract, public factory signatures, persistence format,
generation context, probe accounting, or writer behavior.

The cache can avoid a body read only after all of these facts hold on a
no-argument store scan:

1. The current Bee row is active and untitled.
2. Core returns a committed mailbox membership equal to the cached membership.
3. Current bookkeeping has the exact signature stored with that membership.
4. The existing deferred branch or the existing active retry-backoff predicate
   would continue without producing an outcome or writing state.

Every other path performs the full message read and existing normalization,
decision, save and launch sequence.

## Non-blocking findings

### Low: the pruning test does not pin titled or archived eviction

The implementation at `autoTitle.ts:171-180` builds the keep-set from the full
fresh roster and includes only active, untitled ids. That is the required
bound. The behavioral regression proves unvisited suffix retention, absent-id
eviction, and no pruning while disabled. The slot test also proves that an
in-flight call does not fetch a roster.

No test independently proves that a Bee which remains in `listBees()` but
becomes titled or archived loses its cache entry. This is a retained-state
coverage gap, not a source bug: the predicate is direct and exactly matches the
pre-skip condition. It does not block integration.

### Low: the differential oracle covers one outcome stream

The real-store differential test compares state bytes, contexts, outcomes,
mailboxes and final titles through thin deferral followed by successful
generation. It does not run both factories through provider failure, active
backoff, exact expiry, watchdog fencing, or a multi-Bee probe-cap sequence.
Those cases have focused tests against the optimized factory, and the general
factory still uses the same implementation with a null cache capability. The
shared control flow makes this a test-depth gap rather than a correctness
concern.

## Source findings by required boundary

### Quiet eligibility

- `autoTitle.ts:186-190` retains the active/title pre-skip before mailbox work.
- `autoTitle.ts:195-204` requires a committed current membership, an existing
  same-membership baseline, an exact bookkeeping signature, and a verified
  quiet condition before continuing.
- `canReuseQuietBaseline` accepts only the existing unchanged-deferred branch
  or `isAutoTitleRetryBackoffActive`.
- `isAutoTitleRetryBackoffActive` is shared with `autoTitleDecision`, so the
  truthy `lastAt`, `deferred`, attempt exponent, strict expiry boundary,
  backward-clock behavior, and unusual numeric behavior do not drift between
  the normal and cached paths.
- A missing baseline, changed membership, changed bookkeeping signature,
  `lastAt === 0`, or expired backoff falls through to the full read.

### Transaction publication and reuse

- Unit 1 returns `transaction_open` before its membership query whenever the
  same Core connection has any transaction depth.
- At `autoTitle.ts:195-205`, that variant cannot enter the cache-hit branch.
- The dispatcher then runs the original full message path. At
  `autoTitle.ts:210-217`, publication requires both reads to be committed and
  equal, so an outer or nested transaction cannot publish speculative state.
- The trusted pair contains only synchronous methods on the same `CoreStore`
  plus pure normalization/signature functions. It invokes no option callback
  between the before and after reads.
- The rollback/reused-id test is strong: a speculative `hi` and durable
  `hello` reuse the same mailbox id and therefore the same count/max pair. A
  wrongly published transaction baseline would combine with the speculative
  sidecar signature and skip the required durable full read. The test observes
  that the durable read occurs and repairs the signature.

### Supplied and custom paths

- `createAutoTitleDispatcher` passes `null` at `autoTitle.ts:306-308`, so
  arbitrary dependencies never allocate, publish, prune, or consume a store
  cache.
- A supplied Bee array makes `freshRows` false at `autoTitle.ts:167-170` and
  selects the unchanged `deps.listMessages` branch at `autoTitle.ts:218-222`.
  This also preserves `getBee(candidate.id) ?? candidate` for stale rows.
- The extracted retry predicate does not add a dependency call. The custom
  reentry test pins the original callback order through synchronous reentry.

### Pruning and retained state

- Pruning occurs only after the enabled and occupied-slot early returns and
  after a fresh `listBees()` call.
- It scans the complete roster before the probe-limited loop, so cache entries
  for an unvisited suffix survive an eight-probe break.
- The keep-set is exactly the current active, untitled ids. Since entries are
  created only for reached members of that same set, the map remains bounded by
  the last full active-untitled roster.
- Disabled and non-expired in-flight calls do not claim an instantaneous bound,
  matching the synthesis. Delete/recreate with no intervening scan may reuse an
  equal empty membership, which is outcome-equivalent to the legacy sidecar
  behavior. A scan that observes absence prunes and forces a refill.

### Baseline outcome parity

- Publication occurs immediately after the second membership read and before
  the unchanged-defer, decision, probe, save and launch branches.
- A cache hit replaces only work which was observationally quiet in the old
  path: the mailbox read and pure derivations followed by an existing
  `continue`. It does not skip a state write, probe increment, outcome, or
  launch.
- Misses retain the old order of full `listMessages`, `userTaskMessages`,
  `contextSignature`, bookkeeping selection, decision, save, and full context
  construction. The initial task still comes from every raw row, with envelope
  removal before selection and no clamping.
- Changed mail during backoff resets attempts through the existing signature
  mismatch path. Exact expiry reconstructs the full launch context. Delivery,
  urgency, and output remain silent because none changes naming content.
- The single generation slot, watchdog token fencing, finished-outcome drain,
  roster order, and probe cap are unchanged outside the added cache checks.

## Test assessment

The new tests use real `CoreStore` instances and deterministic clocks. They
cover:

- cold publication and warm defer/backoff hits;
- delivery, urgency, output, envelope-only additions, content changes and exact
  expiry;
- unclamped initial-task construction and bounded recent user messages;
- truthy `lastAt` compatibility, including zero;
- outer and nested transaction scans plus rollback id reuse;
- full-roster suffix retention, absent-id pruning and disabled retention;
- supplied stale-row lookup/fallback and general-dependency reentry order;
- state-byte and context parity against the unchanged general factory;
- one-slot launch order, watchdog retry, and stale-token fencing.

The tests do not expose a production diagnostic property or inspect the private
map with reflection.

## Checks

- `git merge-base bc6554b6 a9e5ea91` is exactly `bc6554b6`.
- `git diff --check bc6554b6 a9e5ea91` passes.
- Focused command passed 20/20 tests:
  `NODE_COMPILE_CACHE=/tmp/honeybee-unit2-review-node-cache node --test v2/daemon/tests/autoTitle.test.ts v2/daemon/tests/auto-title-membership-cache.test.ts`.
- The implementation worktree remained clean.

Per the review scope, I did not edit the repository or run typechecks, a broad
suite, a build, a benchmark, or any Mini command.

## Provenance

- Unit 2 commit: `a9e5ea91dcf55f207dc3398e3d671fa5b3f23476`
- Unit 1 base: `bc6554b6c562019011fb9d3e23cb2e9013bc765f`
- Unit 2 binary diff: `b95d8835b75d048fc29831bb1bffb9971b0667f45c58acf1cac8ec2ff5a60229`
- `autoTitle.ts`: `ffececcc9fa976b3a10cf025a90ee9ce12c211324eeddd9a14e383638d6e768d`
- membership-cache test: `39738dde6a6b69e81282625e7d41a5eed6c6919be222d718c47afdb3f591a5b2`
- Synthesis: `8d3aaed885b3a9cce426d76c7e0c889486ee09ec9d8b6a93901f27aa7e449e18`
- Synthesis signatures: `ea8f7b6c3263c41fb7a9297b2099e0033791bad22075a62e35650cc2fd16d90b`
- Unit 2 task: `536c374dda8217e2570b234ca4857b76057145c877ad165ef5c26b749ad71218`

// Design only. Existing exports/factory parameters remain unchanged.
// Illustrative local types; no production implementations are provided here.
type CommittedMailboxMembership = Readonly<{
  kind: "committed";
  messageCount: number;
  maxMessageId: number | null;
}>;
type MailboxMembership =
  | CommittedMailboxMembership
  | Readonly<{ kind: "transaction_open" }>;
interface CoreMailboxRead {
  readMailboxMembership(beeId: string): MailboxMembership;
}
// Body sketch: if inTransaction return transaction_open. Otherwise read:
// SELECT SUM(row_count) AS row_count, MAX(max_id) AS max_id FROM (
//   SELECT COUNT(*) AS row_count, MAX(id) AS max_id FROM mailbox
//   WHERE bee_id = ? AND delivered_at IS NULL
//   UNION ALL
//   SELECT COUNT(*) AS row_count, MAX(id) AS max_id FROM mailbox
//   WHERE bee_id = ? AND delivered_at IS NOT NULL
// )
// Bind the same Bee twice, validate the returned scalars once, return committed.

type QuietBaseline = Readonly<{
  membership: CommittedMailboxMembership;
  signature: string;
}>;
// Private to the store-backed factory implementation. The general factory
// supplies no store capability; supplied rosters bypass this cache entirely.
type QuietBaselines = Map<string, QuietBaseline>;

function sameMembership(
  left: CommittedMailboxMembership,
  right: CommittedMailboxMembership,
): boolean {
  // not implemented: compare count and max only, inside the same store/Bee.
  throw new Error("not implemented");
}

// Pseudocode for one no-argument, store-backed scan:
// 1. Keep enabled/in-flight/watchdog handling as today.
// 2. Read the fresh roster; prune baselines against its complete active,
//    untitled id set. Walk in the existing order and preserve probe limits.
// 3. After lifecycle/title pre-skip, read committed membership. If a baseline
//    matches, compare its exact signature with private current bookkeeping.
//    Continue only for existing unchanged-defer or exact active-backoff rules.
// 4. Otherwise run today's full messages+normalization+signature path. Pair it
//    with a second committed membership before any callback/branch. Publish
//    one baseline only on equality. Never publish or consume in a transaction.
// 5. Resume today's bookkeeping/decision/probe/save/full launch-context code.
//    A possible launch always uses a full read. No summary/prefix reconstruction.

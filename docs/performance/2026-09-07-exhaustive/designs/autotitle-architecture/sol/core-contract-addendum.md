# Core contract addendum: presence-aware mailbox versions

Status: bounded correction to the Core version seam in `design.md` and
`signatures.ts`. Those frozen files remain unchanged. This addendum supersedes
only their initial-token fallback and mutation-staging timing.

## Exact read contract

There is no shared `initial` fallback. The committed result must distinguish a
present Bee from an absent id:

```ts
export type CommittedMailboxContentsVersion = Readonly<{
  kind: "committed";
  revision: symbol;
}>;

export type MailboxContentsVersion =
  | CommittedMailboxContentsVersion
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "transaction_open" }>;

type MailboxVersionState = {
  // Present Bees only. No absent/deleted entries.
  readonly byBee: Map<string, CommittedMailboxContentsVersion>;
  staged: Map<string, "present_changed" | "absent"> | null;
};
```

For a valid `beeId`, `mailboxContentsVersion` behaves as follows:

1. If any outer transaction is open, return the singleton
   `transaction_open`. Do not probe SQLite or initialize `byBee`.
2. Outside a transaction, return an existing `byBee` entry unchanged.
3. On a miss, run the cached body-free probe
   `SELECT 1 AS present FROM bees WHERE id = ? LIMIT 1`.
4. If no row exists, return the singleton `absent` and do not write `byBee`.
   Repeated absent reads therefore probe again rather than retaining a
   historical tombstone.
5. If the Bee exists, allocate a fresh immutable committed value, insert it in
   `byBee`, and return it. Later unchanged reads return that exact value.

This resolves the open-time ambiguity: an existing-on-open Bee with no map
entry is first proved present and receives `T1`; after its deletion commits,
the map entry is removed and the getter returns `absent`, never `T1`.

The advertised fact is also narrower and more accurate. For the same Bee id
and the same open `CoreStore`, equal committed revisions imply that both reads
saw a present Bee of the same incarnation and that its ordered `(message id,
body)` rows were not changed by a committed Core mutation between the reads.
Inequality is only conservative invalidation and does not prove different
contents. `absent` proves committed absence at that read.
`transaction_open` carries no reusable fact. Revisions are not comparable
across Bee ids or store instances.

## Lifecycle behavior

| Transition | Required result |
| --- | --- |
| Open an existing database; Bee has no `byBee` entry | Presence probe succeeds; mint and retain `T1`. |
| Delete that Bee and commit | Publish `byBee.delete(beeId)`; the next and later absent reads return `absent` without retaining an entry. |
| Recreate the same explicit id and commit | Publish fresh `T2`; `T2.revision !== T1.revision`, including when both incarnations have an empty mailbox. |
| Close the store | Discard the whole process-local map. |
| Reopen while the recreated Bee exists | First read probes and mints fresh `T3`; it is unequal to `T2`, though cross-store comparison is outside the contract. A new store-backed dispatcher starts with an empty cache. |
| Reopen while the id is absent | Return `absent`; do not create a map entry. |

The map is bounded by present Bees that have been observed or mutated in this
store instance. Deletes remove entries. Reads of never-created or formerly
deleted ids do not make the map grow.

## Stage at statement success

Staging belongs to the outer transaction, not to a public method invocation.
Each relevant statement must stage its effect as the next non-throwing internal
action after SQLite reports success, before clocks, audit insertion, row
mapping, callbacks, or other work that can throw:

| Durable statement | Immediate staged effect |
| --- | --- |
| successful Bee `INSERT` | `present_changed` |
| successful mailbox `INSERT` in `send` | `present_changed` |
| mailbox `DELETE` in an applied cancellation (`changes === 1`) | `present_changed` |
| successful Bee `DELETE`, after its cascade completes | `absent` |

Nested calls share the outer staging map. A later operation for the same id
replaces the earlier effect, so delete then recreate ends `present_changed`,
while create then delete ends `absent`. After `COMMIT` succeeds and before the
outer `transact` returns, publish a fresh committed value for
`present_changed` or remove the entry for `absent`. On rollback, discard the
map. Never clear one method's staged effect merely because that method threw;
only the outer transaction outcome decides publication.

This ordering is required by `nested-caught-write-proof.mjs`: `send` completes
its mailbox `INSERT`, its audit clock throws, the outer callback catches that
error, and the outer transaction commits. The mailbox body is durable while
the audit count is unchanged. Staging after successful `send` return would
miss that committed mutation; staging immediately after the `INSERT` cannot.

## Focused Core tests

1. **Open, delete, absent, recreate, reopen.** Seed an explicit-id Bee with a
   message, close, and reopen. Assert the first two reads return the same
   committed revision `T1`. Delete and commit; assert two reads return
   `absent`. Recreate the exact id; assert committed `T2` differs from `T1`.
   Close and reopen; assert stable committed `T3` differs from `T2`. Delete,
   close, and reopen once more; assert `absent`. Exercise only public state
   reads; do not expose the private database. If the tracker itself is unit
   tested, assert absent reads never call `byBee.set` and deletion calls
   `byBee.delete`, without adding a public diagnostic API.
2. **Caught post-insert failure commits and invalidates.** Reproduce the parent
   proof with the real store and injected clock. Establish `T1`, enter an outer
   `transact`, make `send` throw from audit after its mailbox `INSERT`, catch
   inside the outer callback, and observe `transaction_open` there. After the
   outer commit, assert the message body exists, the audit count did not grow,
   and the getter returns committed `T2 !== T1`.
3. **Uncaught failure rolls back both facts.** Repeat the same fault without
   catching it inside the outer callback. Assert the mailbox row is absent and
   the committed revision remains `T1` after rollback.
4. **Other post-statement faults.** With the same real transaction and clock
   seam, cover successful Bee creation, applied cancellation, and Bee deletion
   followed by a caught later audit failure. After outer commit, assert the
   public database state and getter state agree: fresh committed, fresh
   committed, and `absent`, respectively. Keep the existing no-op and failed
   SQL cases unchanged and assert they stage nothing.

Proof inputs read for this addendum:

- `nested-caught-write-proof.mjs` SHA-256
  `185144bc99fcd9e4fe9cb662a0a58868ded6b25eba7ffe51b9db06255ef7599a`
- `nested-caught-write-proof.json` SHA-256
  `eb1797be21ba39f73b23e20f24782ed8d95c1e9905290923330bdcd56f2dfafc`

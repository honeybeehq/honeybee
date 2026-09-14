# Detach from parent backend

Protocol remains `v2/1`; capability `bee.setParent.v1` is advertised in hello and
`deployInfo`. Address the **child's owning node**.

```ts
// All request fields required. Null normalizes parentExternal to false.
bee.setParent({beeId, parentId: string | null, parentExternal: boolean, idempotencyKey})
// Result:
{bee: BeeRow, applied: boolean, deduped?: true}
// Audit/watch event (all fields required):
bee.parent_set: {beeId, parentId, parentExternal, createdById, tags}
```

One serialized transaction validates, changes the active edge, removes every
`apiary:parent=` tag, preserves other tags/order, appends the event, and stores
the original RPC result. The normalized request is bound to its key permanently;
replay returns the original result with `deduped:true` even after later Undo or
deletion. A conflicting request/verb refuses with `idempotency_conflict`. Failed
requests do not consume keys. Same-edge requests are quiet (`applied:false`)
unless legacy tags need cleanup. No runtime, generation, conversation, workspace,
fork provenance, mailbox, or descendant state changes.

Missing child/local parent: `bee_not_found`. Invalid fields, self-parent and
local cycles: `invalid_request`. Active and archived bees are accepted regardless
of runtime state. Deleted bees have no durable row and therefore refuse as missing.
External claims follow existing spawn authority: a nonempty bounded bee ID can
reference another node without a local row; a colliding local ID is not that
external parent. Remote lifecycle/cycles cannot be established by this node.
Local cycle traversal uses the durable parent ID, falling back to the first
`apiary:parent=` tag suffix only when no durable edge exists (matching Apiary's
legacy placement). It never follows `createdById` and stops at an external edge.
Undo therefore refuses when a former parent has become a legacy-only descendant. Null always clears the external
flag; self-parent is rejected even with an external flag.

Schema 23 adds nullable `created_by_id` and an immutable-column trigger. Creation
and fork capture their creator; frozen imports recover explicit creator,
`spawnedById`/`parentId`, or an unambiguous legacy parent tag. Existing databases
recover creation-audit evidence first, then current parent/legacy-tag evidence.
Unknown/ambiguous history stays null. Explicit null creators stay null through
reparent, reopen and deletion/orphaning. Migration retains legacy placement tags
and emits complete `bee.parent_set` projections. It does not change active edges.
New parent mutations strip those tags. Parent deletion uses the same cleanup and
keeps the existing `bee.orphaned` compatibility event. No creator foreign key or
cascade is introduced.

CLI (RPC only):

```sh
hive bee detach CHILD [--idempotency-key KEY]
hive bee set-parent CHILD PARENT [--external] [--idempotency-key KEY]
```

The CLI resolves local names/handles and mints a key when omitted. `--external`
passes the parent ID directly. `bee`, list/view, snapshots and mirror rows expose
`createdById`; stale read-only output exposes stored provenance when available.

Validation uses temporary SQLite stores and disposable stub-only daemon processes.
Coverage includes running/stopped/archived children, runtime/mail/descendant
invariance, exact watch payload, audit replay, reconnect/restart, undo, duplicate
and conflicting keys, eviction immunity, missing/invalid/self/cyclic references,
external authority, root null provenance, frozen imports and v22 migration.
No production deployment or daemon restart is part of this change.

Verified gates for this implementation:

- `npm run check` and `npm run v2:check`.
- `npm run build` (including standalone v2 daemon/CLI and runner host bundles).
- `npm run v2:test`: 247 passing core tests.
- Targeted daemon suites: parent-set, external-parent, preflip-verbs, idempotency,
  import-frozen (16 tests); parent-set also verifies SIGKILL/restart replay.
- `node --test v2/cli/tests/parent-set.test.ts`: CLI/RPC and offline refusal.

A portable disposable daemon needs the built `dist/v2/cli.js` module (exporting
`runV2Cli`), `dist/v2/runner-host.js` beside it, and a launcher calling
`runV2Cli(process.argv.slice(2))`. Its config can use the copied
`v2/driver-hsr/test-agent/agent.mjs` with adapter `stub`. Use a fresh data directory,
`HIVE_NO_KEYCHAIN=1`, `HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN=1`, isolated vault/homes,
and naming disabled. Do not point an operator service at these disposable files.

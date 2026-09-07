# Review: Cell capture scratch clone `--no-tags` (d1d08744 on 5479ed6a)

Independent read-only review of worktree `honeybee-perf-cell-no-tags-2026-09-07`;
no edits, no test launches, no Mini. Verdict at the end.

## Production blast radius — one flag, and it is semantically inert here

The diff adds `--no-tags` to the ONE scratch clone (capture.ts:142). Everything
the scratch is ever asked to do is OID-addressed: `checkout --force --detach
<sha>`, `merge --no-ff <sha>` with a fixed message (no describe/tag lookup),
`rebase --empty=drop <sha>` (sequencer replays by OID; abort is reflog-based),
`merge-tree`/`commit-tree` on raw SHAs, `rev-parse HEAD`, and conflicted-path
listing off the index. No tag NAME is resolved in the scratch anywhere, and
branch names are used only against the ORIGIN with fully qualified
`refs/heads/…` paths. Both boundary fetches (cell→origin step 1, scratch→origin
step 3) already carried `--no-tags` before this candidate — the clone was the
last tag-materializing step, so the change also closes a latent (never hit)
name-ambiguity class rather than opening one.

Object availability is untouched by construction: `--shared` copies ZERO
objects and points `objects/info/alternates` at the origin store, so tag-only
objects remain readable BY OID regardless of which refs the scratch has;
`--no-tags` removes refs, not objects. The ancestry walks (merge-base,
rebase replay) traverse parents from the given SHAs and never consult refs.
The only persistent side effect, `remote.origin.tagOpt=--no-tags` in the
scratch config, is inert (the scratch never fetches) and dies with the
scratch in the `finally`. Fast paths (nothing-to-capture, branch creation,
fast-forward) never reach the clone at all.

Fallback behavior specifically: the checkout-fallback merge and the rebase
engine run in the same scratch on the same SHAs; conflict reporting and
aborts are ref-independent. No behavioral surface found that tags could
influence, in success or failure paths.

## Min-Git assumptions

`clone --no-tags` needs git ≥ 2.14 (2017). The capture path's effective floor
is already far above it: `rebase --empty=drop` ≥ 2.26 for rebase mode, and
`merge-tree --write-tree` ≥ 2.38 for the primary merge engine (with graceful
fallback to the real-merge path on older gits). Campaign-verified toolchains
are 2.39.5 (Mini) and 2.52.0. No new floor is introduced.

## Do the tests prove the claimed guarantees — yes

Test 1 (tag-only availability) builds packed lightweight AND annotated
tag-only objects (pack-refs --prune verified: entries packed, loose refs
absent, peel line present), replicates the exact clone flag set, and proves:
zero refs/tags in scratch, the tagOpt config, alternates realpath equal to
the origin object store, `cat-file`/peel success for the lightweight target,
the annotated tag object, and its peeled commit — plus that none of those
objects were COPIED into the scratch (resolved through the alternate).

Test 2 (parity) is the strong one: for clean-merge, checkout-conflict, and
rebase it builds a control (no tags) and a tagged fixture under pinned dates
and asserts the fixture SHAs are identical, so tags are the ONLY variable.
Each run then asserts a COMPLETE CaptureReport deepEqual against a fully
enumerated expectation; origin fingerprint delta exactly the target-ref move
(landed) or exactly nothing (conflict); cell HEAD/refs/status untouched;
refs/hive empty after; fsck clean; origin tags SURVIVE capture (packed-tag
re-assertion); and — via GIT_TRACE2_EVENT from the live captureWork run —
exactly one scratch clone whose argv byte-matches
`git clone --quiet --shared --no-checkout --no-tags <origin> <dest>` (length
pinned), with the scratch directory gone afterward. Engine-path assertions
prevent silent path collapse: merge cases must show merge-tree, clean merge
must NOT show checkout, conflict/rebase must show checkout plus their engine
command. Landed results are compared tagged-vs-control as tree, exact
parents, and exact file list. That is the claimed guarantee, proven at the
level of the real production argv rather than source text.

## Optional (non-blocking) notes

1. There is no rebase-CONFLICT parity case (the conflict case is merge-mode).
   The rebase abort machinery is tag-independent and the merge-conflict case
   already exercises scratch conflict listing + abort under `--no-tags`, so I
   judge the added value low; cheap to add later if wanted.
2. A case where a tag-only commit is an ANCESTOR of cellHead was considered
   and is provably redundant: any ancestor of cellHead is reachable from
   cellHead itself, so the walk never needs the tag ref, and test 1 already
   proves object servability through the alternate.
3. The trace argv pin is deliberately brittle (exact order and length) —
   right choice; any future flag drift fails loudly.
4. Nod to ea50137f: deriving the ref-fanout ruler's clone policy from the
   production trace keeps ruler and production in lockstep — the same
   discipline the trace assertion gives this test.

## Verdict

APPROVE. The production change is the smallest possible expression of the
intent, its semantic blast radius in the scratch is empty (all operations
OID-addressed; objects via alternates are ref-independent), the min-Git floor
is unaffected, and the two tests prove both the availability claim and
exact tagged/tagless behavioral parity across all three scratch engines with
production-argv-level provenance. Perf sizing (ref-write volume proportional
to tag count) correctly remains with the parent's fanout ruler and Mini.

# Bee durability (H6) — plan

Status: proposal, 2026-10-30. Separate project per the Apiary target architecture; nothing here is built. Gate: **kill an executor mid-task; revive the bee elsewhere with its context.**

## What exists

| Piece | Where | What it gives H6 |
|---|---|---|
| Transcript segments (H4) | `transcript_segment_objects`, `blobs/transcript-archives/` | the raw and projected conversation of every bee up to its last turn end, content-addressed, in the workspace object store |
| Home bundles (H5) | `champion_home_objects`, `blobs/champion-homes/`, `ChampionHomeSync` | a worked pattern for bundling a directory at turn end into the store, refusing secrets, restoring before the first runtime, fencing by epoch |
| WIP push (H3) | `refs/hive/wip/<node>/<cell>` | a Cell's uncommitted work on the origin, restored on re-provision |
| Account thread copy | `bee.swapAccount` (`daemon.ts`, `projects/<cwd-key>/<seed>.jsonl` then `--resume <seed> --fork-session`) | the claude conversation file can be copied between homes and resumed under a new session id |
| Handoff context artifact | `bee.handoff`, `HandoffContext`, the `handoff.seed` mailbox row | a rendered transcript the target harness reads first; the cross-family fallback |
| Native resume | `resolveSpawnSpec` (`resumeArgs(providerSessionId)`), codex `thread/resume` | generation N+1 continues the same provider conversation when the harness state is present |

What is missing: the harness-native state (the provider's own session file) does not leave the executor, a bee cannot be re-created on another executor under its own id, and nothing decides between resuming natively and re-seeding.

## Design

### H6a — resume bundle (flag `durability.resumeBundle.enabled`, default false)

At every turn end and runtime exit, debounced per bee like the home sync, bundle the harness-native conversation state as one opaque zstd tar in the object store under `blobs/resume-bundles/<sha256>`:

| harness | paths bundled (relative to the account home) |
|---|---|
| claude | `.claude/projects/<cwd-key>/<providerSessionId>.jsonl` and its sidechain directory `.claude/projects/<cwd-key>/<providerSessionId>/` when present |
| codex | the rollout file for the thread id under `.codex/sessions/` |
| grok, muse, others | an adapter hook `resumeStatePaths(bee, providerSessionId)`; no hook, no bundle (the fallback covers them) |

Opaque means Honeybee never parses the files; it copies them. The bundle is refused when the paths include credential material (the H5 secrets scan applies: `.claude/.credentials.json`, `.codex/auth.json` live beside the state and are never in the path list). Pointer rows: `bee_resume_bundles { id, bee_id, generation, harness, provider_session_id, cwd, ref, bytes, files, closed_at, epoch }` (schema v55, additive). Capability `bee.resume_bundle.v1`; informational audit `bee_resume_bundle.put` the Home mirrors as a pointer.

Cost: a claude session file grows with the conversation (tens of MB after a long day); the walk, tar and compression run in the segment worker; an unchanged file set writes no row; the same debounce as homes (one per bee per minute, trailing coalesce). Sweep: unreferenced objects daily with the other object kinds; bee deletion cascades the pointer rows.

### H6b — `bee.import` (flag `durability.import.enabled`, default false)

A new executor re-creates a bee it never had:

```
bee.import {
  descriptor: { id, name, agent, args, env (minus the account home), tags, cwd | cell: { originRepo, sha, wipSha? }, providerSessionId, parentId, parentExternal, human_ref, issuing_namespace },
  resume: { bundleRef, epoch } | null,
  transcript: { segmentRefs: [...] } | null,
  idempotencyKey
} → { beeId, generation, commandId, resumed: "native" | "reseeded" | "fresh", epoch }
```

- The descriptor comes from the Home's mirror of the dead executor's rows; the bee keeps its id, handle and `human_ref` (issuing namespace stays the issuer's; the importing node records itself as the placement). Refusals, all before anything changes: `bee_exists`, `harness_mismatch` (agent not configured here), `bundle_missing`, `champion_fenced` for a stale epoch (the same epoch rule as H5: the import takes `epoch + 1`, the Home fences the old executor with `bee.fence`).
- Account: `account: auto` for the harness on the importing node; a leased account that exists only on the dead executor is out of scope.
- Cell: when the descriptor carries a Cell, the import re-provisions it from the origin at `sha` (origin must be reachable from the new node) and lays the H3 WIP back when `wipSha` is confirmed; otherwise `cwd` is a fresh checkout.
- Native resume: the bundle is restored under the new account home keyed by the new cwd (claude keys projects by cwd), then generation N+1 starts exactly as a local revive does (`--resume <providerSessionId>`, codex `thread/resume`).

### H6c — transcript re-seed fallback (same flag as H6b)

When `resume` is null, the bundle is missing, the harness has no hook, or the native resume fails to boot, the import renders the last N projected segments (the `transcript.segmentRefs`, read from the object store) with the handoff artifact renderer into a `handoff.seed` row delivered before any mail, and starts a fresh provider session. `resumed: "reseeded"` says so; the Home shows it.

## Gate and proof

Automated: two daemons sharing one object directory, a stub harness that honours a resume file (the stub writes `<home>/.stub/<session>.json` per turn and reads it back on `--resume`): spawn, three turns, kill the executor mid-turn (SIGKILL during a turn), `bee.import` on the second daemon with the bundle and segments from the first store, the bee answers the next message with facts from before the kill; the same with the bundle withheld proves the re-seed path. Manual, recorded in `.proof/h-track/h6/`: one real claude bee on this machine, killed mid-task, imported into a second data dir, continuing its conversation.

Measured before landing: bundle size and time per harness on real session files (read-only copies from `~/.claude/projects`), the import wall time, and the v55 migration on a copy of the live store.

## Order and size

| Step | Flag | Size | Depends on |
|---|---|---|---|
| H6a resume bundle | `durability.resumeBundle.enabled` | 1 release: worker kind, pointer table, adapter hook, claude + codex paths, tests | H4 store root, H5 bundle code |
| H6b `bee.import` | `durability.import.enabled` | 1–2 releases: descriptor validation, id adoption with issuing namespace, Cell re-provision, epoch fence, account resolution | H6a, H3, H5 fence |
| H6c re-seed fallback | same flag | half a release: renderer reuse, seed row, result marker | H6b, handoff artifact |
| Apiary half | — | mirror the pointers, drive `bee.import` and `bee.fence` from the Home on executor loss, present `resumed` | all |

Rollback at every step is the flag: bundles stop, imports refuse, nothing already imported is undone.

## Not in H6

Encryption at rest for bundles (shared with H5), S3/R2 (shared with H4), moving a running incarnation between executors (`bee.move` stays local), resuming on a node whose harness version cannot read the file (the fallback re-seeds instead).

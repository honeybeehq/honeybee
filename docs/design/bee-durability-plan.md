# Bee durability (H6) — plan

Status: approved plan, revised 2026-10-30 after design review; built in three sealed steps (H6a, H6b, H6c). Gate: **kill an executor mid-task; revive the bee elsewhere with its context**, claimed with a real claude run (import under a different account home and a different cwd than the source) and one codex run, recorded in `.proof/h-track/h6/`.

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

## Decisions from the design review

1. **The session file is the secret, and the object store is the trust boundary.** A claude `projects/<key>/<id>.jsonl` holds every pasted token, tool output and the harness's startup env dump; the H5 name scan cannot see that. Resume bundles are therefore **encrypted at rest**: `chacha20-poly1305` from `node:crypto`, a per-bundle key derived with HKDF-SHA256 from a 32-byte workspace key and a random 16-byte salt, random 96-bit nonce, the bee id as associated data; the object is `hbrb1 | salt | nonce | ciphertext | tag` and the ref is the sha256 of the object. The workspace key lives in a 0600 file named by `durability.resumeBundle.keyFile`, which the Home provisions onto every executor of the workspace and hands to an importing executor with the import; the key is never in the store, never in a bundle, never logged. Every executor of the workspace may read the store (the architecture's write-scoped credentials already imply that), so encryption is what keeps a bundle from a dead executor private to the workspace. Chosen over a point-to-point transfer because the transfer would need a new transport and a live old executor, which is exactly what the gate takes away; the cost is one key file per executor.
2. **Account scope.** A bundle records the scope of the account it was taken under (claude: `organizationUuid`, else `accountUuid`, from the home's `.claude.json`; codex: the account id in `auth.json`; otherwise null). `bee.import` resumes natively only when the resolved account's scope equals the bundle's; a mismatch falls straight to H6c and records `resumed: reseeded, reason: account_mismatch`.
3. **Provider session ids.** A restore always takes the fork path the account swap already uses: the bundle's session id becomes the bee's `forkSeed` (`--resume <seed> --fork-session` for claude, `thread/fork` for codex), so the imported bee gets a fresh provider id and a still-running old executor never shares one. Plain `--resume` is never used across executors.
4. **Racing a live old executor.** `bee.import` carries the epoch of the bee's last bundle and takes `epoch + 1`; `bee_epochs` fences per bee exactly as `champions.epoch` does; the Home calls `bee.fence {beeId, epoch}` on the old executor (stopping a live runtime) before or right after the import, and an import whose epoch is older than the row's is `champion_fenced` (the same closed code). Bundles written under an older epoch are never restored.
5. **Per-harness state key.** The adapter hook is two functions: `resumeStatePaths(home, cwd, sessionId)` and `resumeStateKey(cwd)`. The bundle stores paths relative to the account home with the source key; the restore renames them into the importing cwd's key (`claudeProjectKey(newCwd)` for claude; codex rollouts are keyed by session id, not cwd, and keep their path).
6. **Mail and questions on the dead executor; pointer growth.** `bee.import` creates an empty mailbox. Undelivered mail is the Home's to replay from its mirror with ordinary `send` after the import (same order, same senders); open questions cannot be re-asked by Honeybee and are reported in the import result as `lost: { questions }` from the descriptor so the Home withdraws them typed. Pointer rows are capped: `durability.resumeBundle.keep` (default 5) bundles per bee, older rows deleted on insert so the daily sweep reclaims their objects.

## Design

### H6a — resume bundle (flag `durability.resumeBundle.enabled`, default false)

At every turn end and runtime exit, debounced per bee like the home sync, bundle the harness-native conversation state as one opaque, encrypted zstd tar in the object store under `blobs/resume-bundles/<sha256>` (decision 1):

| harness | paths bundled (relative to the account home) |
|---|---|
| claude | `.claude/projects/<cwd-key>/<providerSessionId>.jsonl` and its sidechain directory `.claude/projects/<cwd-key>/<providerSessionId>/` when present |
| codex | the rollout file for the thread id under `.codex/sessions/` |
| grok, muse, others | an adapter hook `resumeStatePaths(bee, providerSessionId)`; no hook, no bundle (the fallback covers them) |

Opaque means Honeybee never parses the files; it copies them. Credential files beside the state (`.claude/.credentials.json`, `.codex/auth.json`) are never in the path list, and the whole bundle is encrypted. Pointer rows: `bee_resume_bundles { id, bee_id, generation, harness, provider_session_id, cwd, state_key, scope, ref, bytes, size, files, closed_at, epoch }` (schema v55, additive) plus `bee_epochs { bee_id, epoch, fenced_at }`. Capability `bee.resume_bundle.v1`; informational audit `bee_resume_bundle.put` the Home mirrors as a pointer; `deployInfo.resumeBundles` reports the flag, the key file presence and the object count.

Cost: a claude session file grows with the conversation (tens of MB after a long day); the walk, tar and compression run in the segment worker; an unchanged file set writes no row; the same debounce as homes (one per bee per minute, trailing coalesce). Sweep: unreferenced objects daily with the other object kinds; bee deletion cascades the pointer rows.

### H6b — `bee.import` (flag `durability.import.enabled`, default false)

A new executor re-creates a bee it never had:

```
bee.import {
  descriptor: { id, name, agent, args, env (minus the account home), tags, cwd | cell: { originRepo, sha, wipSha? }, providerSessionId, parentId, parentExternal, human_ref, issuing_namespace },
  resume: { bundleRef, epoch, providerSessionId, stateKey, scope } | null,
  transcript: { segmentRefs: [...] } | null,
  lost: { questions: number } | null,
  idempotencyKey
} → { beeId, generation, commandId, resumed: "native" | "reseeded" | "fresh", reason: null | "account_mismatch" | "bundle_missing" | "no_hook" | "boot_failed", epoch }
```

- The descriptor comes from the Home's mirror of the dead executor's rows; the bee keeps its id, handle and `human_ref` (issuing namespace stays the issuer's; the importing node records itself as the placement). Refusals, all before anything changes: `bee_exists`, `harness_mismatch` (agent not configured here), `bundle_missing`, `champion_fenced` for a stale epoch (the same epoch rule as H5: the import takes `epoch + 1`, the Home fences the old executor with `bee.fence`).
- Account: `account: auto` for the harness on the importing node; a leased account that exists only on the dead executor is out of scope.
- Cell: when the descriptor carries a Cell, the import re-provisions it from the origin at `sha` (origin must be reachable from the new node) and lays the H3 WIP back when `wipSha` is confirmed; otherwise `cwd` is a fresh checkout.
- Native resume: the bundle is decrypted with the executor's key file and restored under the new account home, renamed into `resumeStateKey(newCwd)`; the bee row gets `forkSeed = providerSessionId` and no `providerSessionId`, so the first runtime forks the conversation into a fresh provider session (decision 3). Account scope must match the bundle's (decision 2), and the import epoch must not be older than the bee's known epoch (decision 4).

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

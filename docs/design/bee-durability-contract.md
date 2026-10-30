# Bee durability — Honeybee contract (H6a, 2026-10-30)

Plan and decisions: `bee-durability-plan.md`. This file is the wire and storage contract for what is built.

## H6a — resume bundles

Flag `durability.resumeBundle.enabled` (default `false`). Keys under `durability.resumeBundle`: `keyFile` (default `<data-dir>/keys/resume-bundle.key`; a 32-byte key as 64 hex chars, mode 0600; the Home provisions the same key onto every executor of a workspace; an **enrolled** node never mints one and logs `key_unavailable reason=enrolled_node_expects_provisioned_key` until it lands; an un-enrolled node mints its own at boot), `keep` (default 5, pointer rows kept per bee).

**What is bundled.** At every turn end and runtime exit of a bee with a recorded `providerSessionId`, debounced per bee (one bundle per minute, trailing coalesce, a request during a bundle reruns once), the harness-native conversation state, opaque:

| harness (adapter) | root | paths |
|---|---|---|
| claude | the account home (`HOME_ENV`, else the account row's `homePath`) | `projects/<claudeProjectKey(cwd)>/<sessionId>.jsonl` and the sibling `<sessionId>/` directory when present |
| codex | the account home | the rollout file the thread index (`state_5.sqlite`) names for the thread id |
| stub (tests) | the account home, else the bee cwd | `projects/<claudeProjectKey(cwd)>/<sessionId>.json` |
| others | — | no bundle; `bee.resume.push_skipped reason=no_state`; the H6c re-seed is the fallback |

Credential files beside the state (`.claude/.credentials.json`, `.claude.json`, `.codex/auth.json`) are never in the path list; neither are claude's `todos/` and `file-history/` (not needed to resume a conversation). A runtime exit bundles immediately, bypassing the debounce, so the final state after a crash or stop is never lost to a pending timer.

**Object.** `tar -cf -` of the paths relative to the root, zstd level 3, then `chacha20-poly1305` with a per-bundle key `HKDF-SHA256(workspaceKey, salt, "honeybee-resume-bundle-v1")`, random 16-byte salt and 12-byte nonce, `<beeId>|<epoch>` as associated data. Layout `hbrb2 | keyId (8 bytes, sha256(key)[0..8]) | salt | nonce | ciphertext | tag`; the ref is the sha256 of the whole object; written temp-then-rename to `<transcripts.segments.storeDir>/blobs/resume-bundles/<ref>`. Nothing in the object is readable without the key, including file names. The state files are fingerprinted (path, size, mtime) before and after the tar; a changed set is discarded as torn (`push_refused reason=torn`) and retried at the next turn end. A restore decrypts and verifies the tag into a temp file first and only then extracts (`tar -xf`), so a tampered or wrong-key object never touches the account home; a key id that differs from the local key is `key_mismatch` with both ids in the log. The walk, tar, compression and encryption run in the transcript segment worker.

**Pointer row** `bee_resume_bundles { id, bee_id, generation, harness, provider_session_id, cwd, state_key, scope, ref, digest, bytes, size, files, closed_at, epoch }` (schema v55, additive; `bee_epochs { bee_id, epoch, fenced_at }` beside it for H6b). `digest` is the sha256 of the plaintext tar and `key_id` the key the bundle was written under: an unchanged state under the same key and epoch produces no new row and the duplicate object is removed (`bee.resume.unchanged`); a key change re-bundles. `scope` is the account scope the bundle was taken under (claude `org:<organizationUuid>` else `account:<accountUuid>` from the home's `.claude.json`; codex `account:<account_id>` from `auth.json`; null when unknown). `epoch` is the bee's current epoch (0 until a takeover). On insert, rows beyond `keep` are deleted oldest first; their objects are reclaimed by the daily sweep (unreferenced objects older than an hour, the same tick as transcript and home objects). A fenced bee (`bee_epochs.fenced_at`) stops bundling.

**Surfaces.** Capability `bee.resume_bundle.v1`; read verb `bee.resumeBundles {beeId}` → `{beeId, epoch: {beeId, epoch, fencedAt}, bundles[]}` (newest first, 100); `deployInfo.resumeBundles {enabled, keyFile, keyPresent, store, bees, bundles, bytes, objects}`; informational audit rows `bee_resume_bundle.put {bundle}` and `bee.epoch {beeId, epoch, fencedAt}` for the Home to mirror as pointers. Log lines: `bee.resume.pushed|unchanged|push_skipped|push_failed`, `bee.resume.objects`.

**Measured** (`.proof/h-track/h6/`): a 62.8 MB claude session file bundles to 20.1 MB in 0.35 s and restores in 0.39 s; a 5.8 MB codex rollout to 1.9 MB in 47 ms; v55 on a copy of the live store adds two empty tables in milliseconds (the 16 s open is the backup copy plus the v52–v54 steps).

**Rollback.** Flag off: no bundles, no rows, the key file stays. A v55 store refuses to open under a pre-v55 release; `hive deploy --rollback` restores the backup the open path made.

## H6b — `bee.import` and `bee.fence`

Flag `durability.import.enabled` (default `false`; off = `capability_missing`). Verbs are mutate-classified and Home-driven; there is no CLI.

`bee.import { descriptor, resume | null, lost | null, idempotencyKey (required) }` → `{ beeId, handle, humanRef, commandId, seedMessageId, resumed: native | reseeded | fresh, reason, epoch, account, lost, deduped? }`.

- `descriptor` is the dead executor's row as the Home mirrors it: `id` (UUID), `name`, `agent`, `args`, `env` (the account home key is replaced by the importing account's), `tags`, `title`, `cwd` or `cell {originRepo, sha?}`, `providerSessionId`, `parentId`, `parentExternal`, `handle`, `humanRef` + `issuingNamespace` (together), `createdAt`. The bee keeps its id, handle, human reference and creation time; the issuing namespace stays the issuer's.
- Refusals, all before any row is written: `bee_exists`, `harness_mismatch` (agent not configured here), `champion_fenced` (resume epoch older than this node's epoch for the id, or the id is fenced here and no handover epoch was given), `invalid_request` for shape errors, `resource_blocked` for a Cell on a node below its floor with enforcement on.
- `resume { bundleRef, epoch, providerSessionId, stateKey, scope }` is the Home's pointer. The account is resolved `auto` for the harness on the importing node. When the bundle's `scope` and the resolved account's scope are both known and differ, the bundle is not restored (`reason: account_mismatch`). Otherwise the bundle is restored in the worker into the importing account home (or the cwd for harnesses without one), renamed from `stateKey` into `resumeStateKey(newCwd)`, and the bee is created with `forkSeed = providerSessionId` and no provider session id, so its first runtime forks the conversation into a fresh provider session (`--resume <seed> --fork-session`, codex `thread/fork`); `resumed: native`. A missing object is `bundle_missing`, any other restore failure `restore_failed`; the bee is then created without a seed (`fresh`, or `reseeded` once H6c lands).
- A Cell descriptor re-provisions the Cell from the origin at `sha` on this node (origin must be reachable); the H3 WIP restore applies when the registry row carries a confirmed WIP.
- The import records `epoch + 1` in `bee_epochs` (`bee.epoch` audit) and enqueues the spawn under the caller's idempotency key; a replay returns the first result with `deduped: true`.
- Mail and questions: the import creates an empty mailbox. The Home replays undelivered mail with ordinary `send` after the import, in order; `lost.questions` is echoed back so the Home withdraws them typed.

`bee.fence { beeId, epoch, idempotencyKey }` → `{ beeId, epoch, fencedAt, commandId, stopped }`. The Home calls it on the old executor around the import: the row takes the epoch and `fenced_at`, a live runtime is stopped, bundling stops (`push_skipped reason=fenced`), `revive` is `champion_fenced`, and no runtime start resolves for the bee (`resolve: bee … is fenced`), so a mail wake cannot bring the old incarnation back. An epoch older than the node's is `champion_fenced`.

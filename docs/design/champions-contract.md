# Champions — Honeybee contract (H5, 2026-10-30)

A Champion is a bee kind: a permanent identity with a name, a harness family, a home directory and an optional template binding, incarnated as one bee at a time. Honeybee owns the identity row, the home, the incarnation binding and the home bundles. Apiary owns presentation (bio, avatar), scope and membership, pilot settings and the Squad UI, and reads Champions from Honeybee instead of `crew/registry.json` (registry read-only for one release, then gone).

Flags (`config.json`, section `champions`), both default `false`:

| key | default | on |
|---|---|---|
| `champions.enabled` | `false` | the mutating verbs work; off = `capability_missing`. `champion.list` / `champion.get` always answer (empty when nothing was ever created) |
| `champions.homeSync` | `false` | every turn end of an incarnation bundles the home into the object store; `champion.start` on an empty home restores the latest bundle |
| `champions.homesDir` | `<data-dir>/champions` | where a `champion.put` without `home` creates the home |

## Schema v54 (additive)

`champions { id PK slug, name, agent, home, template_id?, model?, effort?, current_bee_id?, created_at, updated_at, archived_at? }` and `champion_home_objects { id, champion_id, ref, bytes, size, files, skipped, closed_at }`, both `CREATE TABLE IF NOT EXISTS`. The `bees` table is untouched: the incarnation is bound through `champions.current_bee_id` and carries the Apiary-compatible tags `apiary:champion=<id>` and `apiary:role=champion`. Mirror: `snapshot.champions` (present when the flag is on), `champion.put` / `champion.deleted` deltas with `MIRROR_CHAMPION_KEYS`; `champion_home_object.put` is informational.

## Verbs (capability `champions.v1`)

- `champion.put {id?, name, agent, home?, templateId?, model?, effort?, archived?, idempotencyKey}` → `{champion, outcome}`. `id` defaults to the slug of the name. `agent` must be a configured spawn spec; `home` must be absolute and defaults to `<homesDir>/<id>`. **Agent and home are immutable**: a put that changes either is `invalid_request`. The home is created with a `MEMORY.md` stub and an empty `memory/`; nothing in it is ever deleted by Honeybee. `archived: true|false` hides or restores the identity.
- `champion.get {id}` → `{champion, bee: ViewResult | null, homeObjects}` (newest 20 bundles). `champion.list {}` → `{champions}`.
- `champion.start {id, prompt?, homeRef?, idempotencyKey}` → `{champion, beeId, commandId, messageId, started: spawned | revived | running, homeRestored}`. With a live incarnation it is a no-op plus the optional prompt; a stopped one is revived (an archived bee unarchived); none spawns: `cwd = home`, `agent`, args from the bound template plus the row's model/effort (`--model`, `--effort` or codex `-c model_reasoning_effort`), template `env` plus `HIVE_CHAMPION_ID` and `HIVE_CHAMPION_HOME`, the template `substrate` and `account`, the template prompt as the first message, then the given prompt. Before the first runtime of a fresh home (stub `MEMORY.md`, empty `memory/`, nothing else) the home is restored from `homeRef` (a pointer the Home hands over after an executor swap) or from this store's newest bundle; a given `homeRef` is recorded as a pointer row.
- `champion.archive {id}` → archives the incarnation (`archive` command) and sets `archived_at`; the home stays. `champion.delete {id}` → removes the identity row and its pointer rows; the home and the bee stay; refused while an active incarnation exists.
- Resident lifecycle: `archive` and `delete` on a bee that is the current incarnation of an unarchived Champion are `invalid_request` ("use champion.archive"). Stop and revive work as for any bee; mail to a stopped incarnation wakes it as today.

## Home bundles

`tar -cf - -C <home> .` streamed through zstd level 3, sha256 of the compressed bytes as the ref, written temp-then-rename to `<transcripts.segments.storeDir>/blobs/champion-homes/<ref>` (the same object store root as transcript segments, so one shared directory or one bucket serves both). Files over `cells.retention.wipMaxFileBytes` (64 MiB) are excluded and counted as `skipped`; symlinks are skipped. Bundles run off the event loop (child `tar` plus zlib streams), one per Champion per `minIntervalMs` (60 s, trailing coalesce), and an unchanged bundle (same ref) writes no row. Restore is `tar -xf -` into the home. Pointer rows live on the executor's store; the Home mirrors them from `champion_home_object.put`.

## Gates and rollback

Proof in `.proof/h-track/h5/`. Rollback: `champions.enabled: false` keeps the rows and homes, refuses the verbs; `homeSync: false` stops bundling (existing bundles stay restorable through `homeRef`). A v54 store refuses to open under a pre-v54 release (`schema_newer`); `hive deploy --rollback` restores the backup the open path made. Apiary's registry.json stays readable for one release while Apiary mirrors champions from the snapshot and the `champion.put` deltas.

<p><img src="brand/strata-u2.iconset/icon_128x128@2x.png" alt="Honeybee icon: stacked glowing hex plates in a dark slab" width="96" height="96"></p>

# honeybee

`honeybee` is a small tmux-backed cockpit for interactive AI bees. Its CLI is `hive`.

See the [Apiary–Honeybee compatibility matrix](./compatibility.md) for
generated release reports, recommended pins, current support, and the meaning of
pending results.

It keeps durable bee sessions on top of Claude, Codex, Grok, Muse, Agy, or any agent the node has configured. Each node has one daemon that owns a single SQLite store; the CLI is a thin client that sends mutations over versioned RPC. When the daemon is down, reads fall back to the store and are labeled STALE.

## Usage

```sh
npm install
npm run build
npm link

hive daemon install       # platform service; `hive daemon run` runs it in the foreground
hive spawn reviewer claude --cwd ~/Projects/foo
hive send reviewer "Please inspect the repo and propose a plan. Do not edit."
hive tail reviewer -f
hive wait reviewer
hive last reviewer
hive transcript reviewer
hive list
hive stop reviewer        # end the runtime; the bee stays active
hive archive reviewer     # file it; sending to it unarchives it
hive delete reviewer      # remove the bee and its owned data
```

`hive spawn <name> [agent]` takes a name first, then the agent. `--account <selector|auto|rr|none>` picks an account; `agent-auto` and `agent-rr` are shorthands. Run `hive --help` for the full command list.

One-shot:

```sh
hive run reviewer -p "Review this frontend for polish. Plan only." --cwd ~/Projects/foo
hive x fixer "Fix the failing test in ids.ts" --agent codex
```

`hive run` spawns, sends, waits, prints the reply, and archives the bee (`--keep` skips the archive). `hive x` spawns and sends the first message, then returns without waiting.

## Messages

`hive send` inserts into the bee's mailbox whether or not its runtime is up; a stopped bee is woken to receive it. `--urgency` controls when mail is delivered:

- `now`: interrupt the current turn, then deliver.
- `next`: at the next accept point (default).
- `idle`: after the turn ends.

`hive mailbox <bee>` shows queued and delivered mail. `hive buz send` and `hive buz inbox` remain as v1 compatibility aliases onto the same mailbox.

## Bee IDs

A bee resolves by handle (`CL.a3f2`), unique name, or uuid prefix of three or more characters. Names are labels; the id is the identity, and `hive rename` changes only the label.

## Naming notes

The project is **honeybee**, its CLI is **hive**, and interactive workers are **bees**. The `ap` binary name remains as a compatibility alias for the same CLI, and `hive v2 …` is the same CLI.

## State model documents

- [`adr/001-bee-runtime-turn-state-model.md`](./adr/001-bee-runtime-turn-state-model.md) — accepted domain semantics for Bee/Runtime/Turn/request/review state
- [`adr/002-event-journal-daemon-authority.md`](./adr/002-event-journal-daemon-authority.md) — event journal / daemon authority; experimental, not accepted
- [`STATE_MODEL_MIGRATION_SPEC.md`](./STATE_MODEL_MIGRATION_SPEC.md) — full storage cutover plan; deferred, not the implementation plan
- [`STATE_MODEL_V2_ASSESSMENT.md`](./STATE_MODEL_V2_ASSESSMENT.md) — takeover assessment, forward-only plan, and decision record
- [`design/`](./design/) — current contracts for the action queue, Cell retention, handoffs, mailbox-only bees, and more

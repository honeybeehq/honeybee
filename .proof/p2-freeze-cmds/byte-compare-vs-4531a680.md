# deploy / rollback / completion: before vs after

before: /home/trmd/.hive/v2/cells/rebuild-p2-honeybee-freeze-36fabec3cd02/github-com-honeybeehq-honeybee-a9015b303498-space-36fabec3cd02/.proof/p2-honeybee-freeze/before
after: /home/trmd/.hive/v2/cells/rebuild-p2-honeybee-freeze-36fabec3cd02/github-com-honeybeehq-honeybee-a9015b303498-space-36fabec3cd02/.proof/p2-freeze-cmds/after

| scenario | file | exit before | exit after | raw identical | identical after masking timestamps and receipt names |
|---|---|---|---|---|---|
| artifact-bad-checksum | stderr | 1 | 1 | yes | yes |
| artifact-bad-checksum | stdout | 1 | 1 | yes | yes |
| artifact-fresh | stderr | 0 | 0 | no | yes |
| artifact-fresh | stdout | 0 | 0 | no | yes |
| artifact-list-json | stderr | 0 | 0 | yes | yes |
| artifact-list-json | stdout | 0 | 0 | no | yes |
| artifact-list | stderr | 0 | 0 | yes | yes |
| artifact-list | stdout | 0 | 0 | no | yes |
| artifact-marker | stdout |  |  | yes | yes |
| artifact-missing-identity | stderr | 1 | 1 | yes | yes |
| artifact-missing-identity | stdout | 1 | 1 | yes | yes |
| artifact-replay | stderr | 0 | 0 | no | yes |
| artifact-replay | stdout | 0 | 0 | no | yes |
| artifact-runtime-mode | stdout |  |  | yes | yes |
| artifact-shim | stdout |  |  | yes | yes |
| artifact-with-help | stderr | 0 | 0 | yes | yes |
| artifact-with-help | stdout | 0 | 0 | yes | yes |
| complete-dep | stderr | 0 | 0 | yes | yes |
| complete-dep | stdout | 0 | 0 | no | NO |
| complete-deploy-flags | stderr | 0 | 0 | yes | yes |
| complete-deploy-flags | stdout | 0 | 0 | no | NO |
| complete-send | stderr | 0 | 0 | yes | yes |
| complete-send | stdout | 0 | 0 | yes | yes |
| complete-top | stderr | 0 | 0 | yes | yes |
| complete-top | stdout | 0 | 0 | no | NO |
| completion-bash | stderr | 1 | 0 | no | NO |
| completion-bash | stdout | 1 | 0 | no | NO |
| completion-fish | stderr | 1 | 0 | no | NO |
| completion-fish | stdout | 1 | 0 | no | NO |
| completion-zsh | stderr | 1 | 0 | no | NO |
| completion-zsh | stdout | 1 | 0 | no | NO |
| conflicting-modes | stderr | 1 | 1 | yes | yes |
| conflicting-modes | stdout | 1 | 1 | yes | yes |
| deploy-info-no-daemon | stderr | 1 | 1 | yes | yes |
| deploy-info-no-daemon | stdout | 1 | 1 | yes | yes |
| help-h | stderr | 0 | 0 | yes | yes |
| help-h | stdout | 0 | 0 | yes | yes |
| help | stderr | 0 | 0 | yes | yes |
| help | stdout | 0 | 0 | yes | yes |
| init | stderr | 0 | 0 | yes | yes |
| init | stdout | 0 | 0 | yes | yes |
| list-empty-json | stderr | 0 | 0 | yes | yes |
| list-empty-json | stdout | 0 | 0 | yes | yes |
| list-empty | stderr | 0 | 0 | yes | yes |
| list-empty | stdout | 0 | 0 | yes | yes |
| orphan-identity | stderr | 1 | 1 | yes | yes |
| orphan-identity | stdout | 1 | 1 | yes | yes |
| outside-repo | stderr | 1 | 1 | yes | yes |
| outside-repo | stdout | 1 | 1 | yes | yes |
| rollback-again | stderr | 0 | 0 | yes | yes |
| rollback-again | stdout | 0 | 0 | no | yes |
| rollback-current | stdout |  |  | yes | yes |
| rollback-list-after-json | stderr | 0 | 0 | yes | yes |
| rollback-list-after-json | stdout | 0 | 0 | no | yes |
| rollback-list-before | stderr | 0 | 0 | yes | yes |
| rollback-list-before | stdout | 0 | 0 | yes | yes |
| rollback-nothing | stderr | 1 | 1 | yes | yes |
| rollback-nothing | stdout | 1 | 1 | yes | yes |
| rollback | stderr | 0 | 0 | yes | yes |
| rollback | stdout | 0 | 0 | no | yes |
| skip-tests-banana | stderr | 1 | 1 | yes | yes |
| skip-tests-banana | stdout | 1 | 1 | yes | yes |
| skip-tests-with-list | stderr | 1 | 1 | yes | yes |
| skip-tests-with-list | stdout | 1 | 1 | yes | yes |
| stray-positionals | stderr | 1 | 1 | yes | yes |
| stray-positionals | stdout | 1 | 1 | yes | yes |
| unknown-flag | stderr | 1 | 1 | yes | yes |
| unknown-flag | stdout | 1 | 1 | yes | yes |
| update-owner-status-no-daemon | stderr | 1 | 1 | yes | yes |
| update-owner-status-no-daemon | stdout | 1 | 1 | yes | yes |
| version | stderr | 0 | 0 | yes | yes |
| version | stdout | 0 | 0 | no | NO |

## Differences after masking

### complete-dep.stdout

before:
```
spawn
new
launch
send
tail
cat
transcript
tx
last
wait
list
ls
ps
bees
gateways
kill
clean
run
x
xa
attach
next
colony
pool
frame
template
swarm
node
substrate
flow
loop
buz
task
daemon
deploy
account
activate
login
swap-account
usage
limits
sessions
sync
open
search
seals
events
flight
state
brief
rename
seal
config
completion
help
tag
own
move
fork
here
spawn-picker
urls
keys
revive
auth-resume
retire
archive
set-model

```
after:
```
account
ack
action
answer
archive
ask
attach
bee
buz
cell
children
commands
completion
daemon
delete
deploy
deploy-info
events
fork
handoff
harnesses
health
help
here
human-ref
interrupt
last
limits
list
login
ls
mailbox
packages
ps
question
reconnect-tools
rename
revive
run
seal
send
set-model
spawn
stop
swap-account
tag
tail
task
template
thread-fork
thread-handoff
thread-operation
transcript
tx
unarchive
usage
view
wait
watch
x
xa

```

### complete-deploy-flags.stdout

before:
```
--rollback
--list
--init
--keep
--json
--allow-non-descendant
--help

```
after:
```
--rollback
--list
--init
--json
--keep
--skip-tests
--allow-non-descendant
--provision-question-withdrawal
--artifact
--identity
--admission
--expected-current
--bin-dir
--help

```

### complete-top.stdout

before:
```
spawn
new
launch
send
tail
cat
transcript
tx
last
wait
list
ls
ps
bees
gateways
kill
clean
run
x
xa
attach
next
colony
pool
frame
template
swarm
node
substrate
flow
loop
buz
task
daemon
deploy
account
activate
login
swap-account
usage
limits
sessions
sync
open
search
seals
events
flight
state
brief
rename
seal
config
completion
help
tag
own
move
fork
here
spawn-picker
urls
keys
revive
auth-resume
retire
archive
set-model

```
after:
```
account
ack
action
answer
archive
ask
attach
bee
buz
cell
children
commands
completion
daemon
delete
deploy
deploy-info
events
fork
handoff
harnesses
health
help
here
human-ref
interrupt
last
limits
list
login
ls
mailbox
packages
ps
question
reconnect-tools
rename
revive
run
seal
send
set-model
spawn
stop
swap-account
tag
tail
task
template
thread-fork
thread-handoff
thread-operation
transcript
tx
unarchive
usage
view
wait
watch
x
xa

```

### completion-bash.stderr

before:
```
hive: unknown command: completion

```
after:
```

```

### completion-bash.stdout

before:
```
hive 0.0.1-dev.4531a680faa2.dirty  — durable AI agent sessions

Usage:
  hive <command> [args] [--data-dir d] [--socket s] [--json]

  Mutations go through the daemon (RPC). Reads fall back to the read-only
  store when the daemon is down — that output is clearly labeled STALE.
  (--idempotency-key on any mutation: a replayed key returns the original outcome, marked deduped.)
  (`hive v2 …` still works — it is the same CLI.)

Spawn & run:
  hive spawn <name> [agent]                                       start a bee (supports claude-gmail, codex-auto, claude-rr; exact --account wins)
  hive spawn <name> inbox                                         mailbox-only bee (alias: stub): an address with no model, account, or wake
  hive x <name> <prompt…>                                         spawn + first send, fire-and-forget (--agent/--account/--cwd…)
  hive xa <agent> [--name n]                                      spawn + attach (e.g. claude-gmail fuzzy, codex-auto least-loaded, claude-rr round-robin)
  hive run <name> -p <prompt>                                     spawn, send, wait, print the reply, archive (--keep skips)
  hive fork <bee> [--name n]                                      copy a conversation; no instruction or requested compaction
  hive thread-fork <bee> [--name n]                               durable conversation copy with a pinned history boundary (local Codex HSR)
  hive thread-handoff <bee> --instruction <text>                  fork, compact with the instruction, then continue; preserves the source
  hive thread-operation get|retry <operation-id>                  read progress or recover a failed thread operation on its existing successor
  hive handoff <bee> --to <agent> [--model m]                     SAME bee, fresh provider thread seeded with a context summary; cross-family ok (codex → claude)
  hive handoff get <id> | status <bee>                            read a handoff receipt (phase, context, failure)

Message:
  hive send <bee> <message…>                                      mailbox insert; --urgency now|next|idle; --sender-kind automation for scripted notices; --wait blocks on delivery
  hive ask <question…>                                            (from inside a bee) ask the operator; the answer returns as mail
  hive answer <question-id> <answer…>                             answer an open question (also: question answer …)
  hive question list [--bee b] [--open]                           list questions
  hive seal <title> [--body t]                                    record a seal · seal list [--bee b] · seal get <id>
  hive action report <id> --attempt n --token t …                 (from inside a bee) report an action's outcome: --succeeded [--output k=v] | --failed | --ask q | --progress n
  hive action enqueue <bee> <kind> [--input k=v]                  append to the bee's action queue (commit, land, archive, …) · list · get · definitions
  hive action cancel|retry <id> · pause|resume <bee>              queue controls (cancel pending or failed, retry failed, pause releases) · complete <id> · reorder <bee> <id>…
  hive buz send <bee> -p <body>                                   v1 compat: a mailbox send (tiers map onto urgency)
  hive buz inbox [bee]                                            v1 compat: the mailbox (defaults to self inside a bee)
  hive task add <list> -p <title>                                 append a micro-task (bee:<id> or shared:<name> or a bare bee)
  hive task ls|show|start|done|block|cancel                       list / inspect / transition (block -p reason)
  hive task claim|mv|edit|lists                                   claim shared work, reorder, edit, enumerate lists
  hive task supply <bee> [--on|--off]                             auto-feed pending auto tasks via mailbox when idle

Observe:
  hive list [--all|--archived]                                    all bees with state (aliases: ls, ps)
  hive view <bee>                                                 one bee, with env key names only
  hive mailbox <bee> [--since id] [--unread]                      queued + delivered mail; --since/--unread for pollers
  hive ack <bee> <id>|--all                                       mark a mailbox-only bee's mail read through <id>
  hive commands <bee>                                             command queue for a bee
  hive children <bee>                                             bees this one spawned or forked
  hive transcript <bee> [-n n] [-f]                               session log as readable turns (alias: tx); -f/--follow streams
  hive tail <bee> [-n n] [-f]                                     recent output; -f/--follow streams (--raw = verbatim log)
  hive last <bee> [--seal]                                        the most recent assistant message (fallback: latest seal)
  hive wait <bee>                                                 block until the bee is idle/stopped with no queued mail
  hive events [--bee b] [--kind glob]                             audit-row tail (the ledger of every write)
  hive here [--json]                                              this process's own bee (the HIVE_BEE_ID stamp)
  hive usage [account]                                            provider 5h/weekly/fable windows per account (alias: limits)
  hive watch [--bee id]                                           whole-node change stream (snapshot + seq deltas)
  hive health                                                     daemon liveness + i1 violations
  hive harnesses                                                  per-harness executable facts (path/source/version) as the daemon resolves them
  hive deploy-info                                                protocol / versions / paths
  hive human-ref status|enroll <receipt.json>                     installation identity and permanent reference enrollment
  hive human-ref registry init|status|reserve <installation-id>   explicit fleet namespace registry (one per fleet)

Manage bees:
  hive stop <bee>                                                 end the runtime; the bee stays active
  hive revive <bee>                                               generation N+1; optional replacement args after --
  hive archive <bee>... | -                                       file bees (ids/names, or one per stdin line); --tree adds descendants; --dry-run; --force archives working bees
  hive unarchive <bee>                                            return an archived bee to active
  hive delete <bee>                                               remove the bee and owned durable data
  hive reconnect-tools <bee> [--command-id id]                    reconnect native tools in the same session; read durable status
  hive interrupt <bee>                                            stop the current TURN, keep the runtime (idle = no-op)
  hive rename <bee> <new-name>                                    rename (names are labels; the id is the identity)
  hive tag <bee> [--add t]...                                     edit tags (apiary:* tags are Apiary's: refused from inside a bee)
  hive bee set-args <bee> -- <args…>                              per-bee harness args; applies on the NEXT runtime
  hive bee args <bee>                                             show layered args
  hive set-model <bee> <model> [--apply]                          next-runtime args; --apply requests an atomic idle restart
  hive attach <bee> [--print]                                     tmux-substrate bees only (hsr/cell are pane-less: use tail)
  hive cell capture <bee> --onto <b>                              land the cell's commits onto an origin branch
  hive cell remove <bee> [--force]                                delete the cell (dirty guard) + delete the bee
  hive cell exec <cellId> -- <argv>                               sandboxed retained-Cell exec
  hive cell retained-remove <cellId>                              delete a retained Cell without deleting the bee
  hive cell gc [--apply] [--measure]                              plan (or apply) Cell disk retention: what would be reclaimed and why the rest is held; --measure walks every Cell's bytes
  hive cell evict <bee> [--force]                                 reclaim one bee's Cell directory now; the bee, transcript and cwd stay
  hive cell move <bee> --cwd <dir>                                same-node Cell→checkout move; infers current placement and repo facts
  hive cell move-get <moveId>                                     read a Cell→checkout move receipt

Accounts:
  hive account list [--harness h]                                 accounts + latest limits · get <selector> (exact or unique fuzzy)
  hive account add <harness> <label>                              create an account [--id id] [--home dir] [--penalty n]
  hive account remove|pause|unpause <selector>                    lifecycle · penalty <selector> <0-100> · ceiling <selector> <1-100|off>
  hive login <account>                                            sign in (browser / code / API key — driven from this terminal; --no-wait just starts it)
  hive account capture <selector>                                 snapshot an already-authenticated home/provider credential into the vault
  hive swap-account <bee> <account>                               move a bee to another account of the SAME harness
  hive account limits [<selector>]                                refresh + show provider limits (feeds auto; rr uses registration order)
  hive account import [--root ~/.hive]                            import the old vault · account backfill [--dry-run]

Templates:
  hive template run <name> [input…]                               spawn from a daemon-owned preset (--wait or --attach)
  hive template list|get|inspect|put|delete|…                     rows are truth, files are packages
  hive packages import-local [--dir d]                            import ~/.hive templates

Cutover:
  hive freeze [--root r] [--force]                                write <root>/FROZEN (refuses while the old daemon is alive)
  hive import --from-frozen                                       import active bees from the frozen old-world store

Daemon:
  hive daemon run                                                 run the daemon in the foreground
  hive daemon install|uninstall|start|stop|restart|status         platform service + liveness

Bees:
  agy, claude, codex, grok, muse, stub — or any agent the node has configured
  resolve a bee by handle (CL.a3f2), unique name, or uuid prefix (3+ chars)
  urgency: now = interrupt then deliver; next = next accept point (default); idle = after the turn


```
after:
```
# hive bash completion
# Install: eval "$(hive completion bash)"
# Or add to ~/.bashrc: hive completion bash > ~/.hive.bash && source ~/.hive.bash
_hive_complete() {
  local IFS=$'\n'
  local response
  response=$("${COMP_WORDS[0]}" __complete "${COMP_WORDS[@]}" 2>/dev/null)
  COMPREPLY=( $(compgen -W "$response" -- "${COMP_WORDS[COMP_CWORD]}") )
}
complete -F _hive_complete hive


```

### completion-fish.stderr

before:
```
hive: unknown command: completion

```
after:
```

```

### completion-fish.stdout

before:
```
hive 0.0.1-dev.4531a680faa2.dirty  — durable AI agent sessions

Usage:
  hive <command> [args] [--data-dir d] [--socket s] [--json]

  Mutations go through the daemon (RPC). Reads fall back to the read-only
  store when the daemon is down — that output is clearly labeled STALE.
  (--idempotency-key on any mutation: a replayed key returns the original outcome, marked deduped.)
  (`hive v2 …` still works — it is the same CLI.)

Spawn & run:
  hive spawn <name> [agent]                                       start a bee (supports claude-gmail, codex-auto, claude-rr; exact --account wins)
  hive spawn <name> inbox                                         mailbox-only bee (alias: stub): an address with no model, account, or wake
  hive x <name> <prompt…>                                         spawn + first send, fire-and-forget (--agent/--account/--cwd…)
  hive xa <agent> [--name n]                                      spawn + attach (e.g. claude-gmail fuzzy, codex-auto least-loaded, claude-rr round-robin)
  hive run <name> -p <prompt>                                     spawn, send, wait, print the reply, archive (--keep skips)
  hive fork <bee> [--name n]                                      copy a conversation; no instruction or requested compaction
  hive thread-fork <bee> [--name n]                               durable conversation copy with a pinned history boundary (local Codex HSR)
  hive thread-handoff <bee> --instruction <text>                  fork, compact with the instruction, then continue; preserves the source
  hive thread-operation get|retry <operation-id>                  read progress or recover a failed thread operation on its existing successor
  hive handoff <bee> --to <agent> [--model m]                     SAME bee, fresh provider thread seeded with a context summary; cross-family ok (codex → claude)
  hive handoff get <id> | status <bee>                            read a handoff receipt (phase, context, failure)

Message:
  hive send <bee> <message…>                                      mailbox insert; --urgency now|next|idle; --sender-kind automation for scripted notices; --wait blocks on delivery
  hive ask <question…>                                            (from inside a bee) ask the operator; the answer returns as mail
  hive answer <question-id> <answer…>                             answer an open question (also: question answer …)
  hive question list [--bee b] [--open]                           list questions
  hive seal <title> [--body t]                                    record a seal · seal list [--bee b] · seal get <id>
  hive action report <id> --attempt n --token t …                 (from inside a bee) report an action's outcome: --succeeded [--output k=v] | --failed | --ask q | --progress n
  hive action enqueue <bee> <kind> [--input k=v]                  append to the bee's action queue (commit, land, archive, …) · list · get · definitions
  hive action cancel|retry <id> · pause|resume <bee>              queue controls (cancel pending or failed, retry failed, pause releases) · complete <id> · reorder <bee> <id>…
  hive buz send <bee> -p <body>                                   v1 compat: a mailbox send (tiers map onto urgency)
  hive buz inbox [bee]                                            v1 compat: the mailbox (defaults to self inside a bee)
  hive task add <list> -p <title>                                 append a micro-task (bee:<id> or shared:<name> or a bare bee)
  hive task ls|show|start|done|block|cancel                       list / inspect / transition (block -p reason)
  hive task claim|mv|edit|lists                                   claim shared work, reorder, edit, enumerate lists
  hive task supply <bee> [--on|--off]                             auto-feed pending auto tasks via mailbox when idle

Observe:
  hive list [--all|--archived]                                    all bees with state (aliases: ls, ps)
  hive view <bee>                                                 one bee, with env key names only
  hive mailbox <bee> [--since id] [--unread]                      queued + delivered mail; --since/--unread for pollers
  hive ack <bee> <id>|--all                                       mark a mailbox-only bee's mail read through <id>
  hive commands <bee>                                             command queue for a bee
  hive children <bee>                                             bees this one spawned or forked
  hive transcript <bee> [-n n] [-f]                               session log as readable turns (alias: tx); -f/--follow streams
  hive tail <bee> [-n n] [-f]                                     recent output; -f/--follow streams (--raw = verbatim log)
  hive last <bee> [--seal]                                        the most recent assistant message (fallback: latest seal)
  hive wait <bee>                                                 block until the bee is idle/stopped with no queued mail
  hive events [--bee b] [--kind glob]                             audit-row tail (the ledger of every write)
  hive here [--json]                                              this process's own bee (the HIVE_BEE_ID stamp)
  hive usage [account]                                            provider 5h/weekly/fable windows per account (alias: limits)
  hive watch [--bee id]                                           whole-node change stream (snapshot + seq deltas)
  hive health                                                     daemon liveness + i1 violations
  hive harnesses                                                  per-harness executable facts (path/source/version) as the daemon resolves them
  hive deploy-info                                                protocol / versions / paths
  hive human-ref status|enroll <receipt.json>                     installation identity and permanent reference enrollment
  hive human-ref registry init|status|reserve <installation-id>   explicit fleet namespace registry (one per fleet)

Manage bees:
  hive stop <bee>                                                 end the runtime; the bee stays active
  hive revive <bee>                                               generation N+1; optional replacement args after --
  hive archive <bee>... | -                                       file bees (ids/names, or one per stdin line); --tree adds descendants; --dry-run; --force archives working bees
  hive unarchive <bee>                                            return an archived bee to active
  hive delete <bee>                                               remove the bee and owned durable data
  hive reconnect-tools <bee> [--command-id id]                    reconnect native tools in the same session; read durable status
  hive interrupt <bee>                                            stop the current TURN, keep the runtime (idle = no-op)
  hive rename <bee> <new-name>                                    rename (names are labels; the id is the identity)
  hive tag <bee> [--add t]...                                     edit tags (apiary:* tags are Apiary's: refused from inside a bee)
  hive bee set-args <bee> -- <args…>                              per-bee harness args; applies on the NEXT runtime
  hive bee args <bee>                                             show layered args
  hive set-model <bee> <model> [--apply]                          next-runtime args; --apply requests an atomic idle restart
  hive attach <bee> [--print]                                     tmux-substrate bees only (hsr/cell are pane-less: use tail)
  hive cell capture <bee> --onto <b>                              land the cell's commits onto an origin branch
  hive cell remove <bee> [--force]                                delete the cell (dirty guard) + delete the bee
  hive cell exec <cellId> -- <argv>                               sandboxed retained-Cell exec
  hive cell retained-remove <cellId>                              delete a retained Cell without deleting the bee
  hive cell gc [--apply] [--measure]                              plan (or apply) Cell disk retention: what would be reclaimed and why the rest is held; --measure walks every Cell's bytes
  hive cell evict <bee> [--force]                                 reclaim one bee's Cell directory now; the bee, transcript and cwd stay
  hive cell move <bee> --cwd <dir>                                same-node Cell→checkout move; infers current placement and repo facts
  hive cell move-get <moveId>                                     read a Cell→checkout move receipt

Accounts:
  hive account list [--harness h]                                 accounts + latest limits · get <selector> (exact or unique fuzzy)
  hive account add <harness> <label>                              create an account [--id id] [--home dir] [--penalty n]
  hive account remove|pause|unpause <selector>                    lifecycle · penalty <selector> <0-100> · ceiling <selector> <1-100|off>
  hive login <account>                                            sign in (browser / code / API key — driven from this terminal; --no-wait just starts it)
  hive account capture <selector>                                 snapshot an already-authenticated home/provider credential into the vault
  hive swap-account <bee> <account>                               move a bee to another account of the SAME harness
  hive account limits [<selector>]                                refresh + show provider limits (feeds auto; rr uses registration order)
  hive account import [--root ~/.hive]                            import the old vault · account backfill [--dry-run]

Templates:
  hive template run <name> [input…]                               spawn from a daemon-owned preset (--wait or --attach)
  hive template list|get|inspect|put|delete|…                     rows are truth, files are packages
  hive packages import-local [--dir d]                            import ~/.hive templates

Cutover:
  hive freeze [--root r] [--force]                                write <root>/FROZEN (refuses while the old daemon is alive)
  hive import --from-frozen                                       import active bees from the frozen old-world store

Daemon:
  hive daemon run                                                 run the daemon in the foreground
  hive daemon install|uninstall|start|stop|restart|status         platform service + liveness

Bees:
  agy, claude, codex, grok, muse, stub — or any agent the node has configured
  resolve a bee by handle (CL.a3f2), unique name, or uuid prefix (3+ chars)
  urgency: now = interrupt then deliver; next = next accept point (default); idle = after the turn


```
after:
```
# hive fish completion
# Install: hive completion fish | source
# Or add to ~/.config/fish/completions/hive.fish
function __hive_complete
  hive __complete (commandline -opc) (commandline -ct) 2>/dev/null
end
complete -c hive -f -a '(__hive_complete)'


```

### completion-zsh.stderr

before:
```
hive: unknown command: completion

```
after:
```

```

### completion-zsh.stdout

before:
```
hive 0.0.1-dev.4531a680faa2.dirty  — durable AI agent sessions

Usage:
  hive <command> [args] [--data-dir d] [--socket s] [--json]

  Mutations go through the daemon (RPC). Reads fall back to the read-only
  store when the daemon is down — that output is clearly labeled STALE.
  (--idempotency-key on any mutation: a replayed key returns the original outcome, marked deduped.)
  (`hive v2 …` still works — it is the same CLI.)

Spawn & run:
  hive spawn <name> [agent]                                       start a bee (supports claude-gmail, codex-auto, claude-rr; exact --account wins)
  hive spawn <name> inbox                                         mailbox-only bee (alias: stub): an address with no model, account, or wake
  hive x <name> <prompt…>                                         spawn + first send, fire-and-forget (--agent/--account/--cwd…)
  hive xa <agent> [--name n]                                      spawn + attach (e.g. claude-gmail fuzzy, codex-auto least-loaded, claude-rr round-robin)
  hive run <name> -p <prompt>                                     spawn, send, wait, print the reply, archive (--keep skips)
  hive fork <bee> [--name n]                                      copy a conversation; no instruction or requested compaction
  hive thread-fork <bee> [--name n]                               durable conversation copy with a pinned history boundary (local Codex HSR)
  hive thread-handoff <bee> --instruction <text>                  fork, compact with the instruction, then continue; preserves the source
  hive thread-operation get|retry <operation-id>                  read progress or recover a failed thread operation on its existing successor
  hive handoff <bee> --to <agent> [--model m]                     SAME bee, fresh provider thread seeded with a context summary; cross-family ok (codex → claude)
  hive handoff get <id> | status <bee>                            read a handoff receipt (phase, context, failure)

Message:
  hive send <bee> <message…>                                      mailbox insert; --urgency now|next|idle; --sender-kind automation for scripted notices; --wait blocks on delivery
  hive ask <question…>                                            (from inside a bee) ask the operator; the answer returns as mail
  hive answer <question-id> <answer…>                             answer an open question (also: question answer …)
  hive question list [--bee b] [--open]                           list questions
  hive seal <title> [--body t]                                    record a seal · seal list [--bee b] · seal get <id>
  hive action report <id> --attempt n --token t …                 (from inside a bee) report an action's outcome: --succeeded [--output k=v] | --failed | --ask q | --progress n
  hive action enqueue <bee> <kind> [--input k=v]                  append to the bee's action queue (commit, land, archive, …) · list · get · definitions
  hive action cancel|retry <id> · pause|resume <bee>              queue controls (cancel pending or failed, retry failed, pause releases) · complete <id> · reorder <bee> <id>…
  hive buz send <bee> -p <body>                                   v1 compat: a mailbox send (tiers map onto urgency)
  hive buz inbox [bee]                                            v1 compat: the mailbox (defaults to self inside a bee)
  hive task add <list> -p <title>                                 append a micro-task (bee:<id> or shared:<name> or a bare bee)
  hive task ls|show|start|done|block|cancel                       list / inspect / transition (block -p reason)
  hive task claim|mv|edit|lists                                   claim shared work, reorder, edit, enumerate lists
  hive task supply <bee> [--on|--off]                             auto-feed pending auto tasks via mailbox when idle

Observe:
  hive list [--all|--archived]                                    all bees with state (aliases: ls, ps)
  hive view <bee>                                                 one bee, with env key names only
  hive mailbox <bee> [--since id] [--unread]                      queued + delivered mail; --since/--unread for pollers
  hive ack <bee> <id>|--all                                       mark a mailbox-only bee's mail read through <id>
  hive commands <bee>                                             command queue for a bee
  hive children <bee>                                             bees this one spawned or forked
  hive transcript <bee> [-n n] [-f]                               session log as readable turns (alias: tx); -f/--follow streams
  hive tail <bee> [-n n] [-f]                                     recent output; -f/--follow streams (--raw = verbatim log)
  hive last <bee> [--seal]                                        the most recent assistant message (fallback: latest seal)
  hive wait <bee>                                                 block until the bee is idle/stopped with no queued mail
  hive events [--bee b] [--kind glob]                             audit-row tail (the ledger of every write)
  hive here [--json]                                              this process's own bee (the HIVE_BEE_ID stamp)
  hive usage [account]                                            provider 5h/weekly/fable windows per account (alias: limits)
  hive watch [--bee id]                                           whole-node change stream (snapshot + seq deltas)
  hive health                                                     daemon liveness + i1 violations
  hive harnesses                                                  per-harness executable facts (path/source/version) as the daemon resolves them
  hive deploy-info                                                protocol / versions / paths
  hive human-ref status|enroll <receipt.json>                     installation identity and permanent reference enrollment
  hive human-ref registry init|status|reserve <installation-id>   explicit fleet namespace registry (one per fleet)

Manage bees:
  hive stop <bee>                                                 end the runtime; the bee stays active
  hive revive <bee>                                               generation N+1; optional replacement args after --
  hive archive <bee>... | -                                       file bees (ids/names, or one per stdin line); --tree adds descendants; --dry-run; --force archives working bees
  hive unarchive <bee>                                            return an archived bee to active
  hive delete <bee>                                               remove the bee and owned durable data
  hive reconnect-tools <bee> [--command-id id]                    reconnect native tools in the same session; read durable status
  hive interrupt <bee>                                            stop the current TURN, keep the runtime (idle = no-op)
  hive rename <bee> <new-name>                                    rename (names are labels; the id is the identity)
  hive tag <bee> [--add t]...                                     edit tags (apiary:* tags are Apiary's: refused from inside a bee)
  hive bee set-args <bee> -- <args…>                              per-bee harness args; applies on the NEXT runtime
  hive bee args <bee>                                             show layered args
  hive set-model <bee> <model> [--apply]                          next-runtime args; --apply requests an atomic idle restart
  hive attach <bee> [--print]                                     tmux-substrate bees only (hsr/cell are pane-less: use tail)
  hive cell capture <bee> --onto <b>                              land the cell's commits onto an origin branch
  hive cell remove <bee> [--force]                                delete the cell (dirty guard) + delete the bee
  hive cell exec <cellId> -- <argv>                               sandboxed retained-Cell exec
  hive cell retained-remove <cellId>                              delete a retained Cell without deleting the bee
  hive cell gc [--apply] [--measure]                              plan (or apply) Cell disk retention: what would be reclaimed and why the rest is held; --measure walks every Cell's bytes
  hive cell evict <bee> [--force]                                 reclaim one bee's Cell directory now; the bee, transcript and cwd stay
  hive cell move <bee> --cwd <dir>                                same-node Cell→checkout move; infers current placement and repo facts
  hive cell move-get <moveId>                                     read a Cell→checkout move receipt

Accounts:
  hive account list [--harness h]                                 accounts + latest limits · get <selector> (exact or unique fuzzy)
  hive account add <harness> <label>                              create an account [--id id] [--home dir] [--penalty n]
  hive account remove|pause|unpause <selector>                    lifecycle · penalty <selector> <0-100> · ceiling <selector> <1-100|off>
  hive login <account>                                            sign in (browser / code / API key — driven from this terminal; --no-wait just starts it)
  hive account capture <selector>                                 snapshot an already-authenticated home/provider credential into the vault
  hive swap-account <bee> <account>                               move a bee to another account of the SAME harness
  hive account limits [<selector>]                                refresh + show provider limits (feeds auto; rr uses registration order)
  hive account import [--root ~/.hive]                            import the old vault · account backfill [--dry-run]

Templates:
  hive template run <name> [input…]                               spawn from a daemon-owned preset (--wait or --attach)
  hive template list|get|inspect|put|delete|…                     rows are truth, files are packages
  hive packages import-local [--dir d]                            import ~/.hive templates

Cutover:
  hive freeze [--root r] [--force]                                write <root>/FROZEN (refuses while the old daemon is alive)
  hive import --from-frozen                                       import active bees from the frozen old-world store

Daemon:
  hive daemon run                                                 run the daemon in the foreground
  hive daemon install|uninstall|start|stop|restart|status         platform service + liveness

Bees:
  agy, claude, codex, grok, muse, stub — or any agent the node has configured
  resolve a bee by handle (CL.a3f2), unique name, or uuid prefix (3+ chars)
  urgency: now = interrupt then deliver; next = next accept point (default); idle = after the turn


```
after:
```
#compdef hive
# hive zsh completion
# Install: eval "$(hive completion zsh)"
# Or add to a directory in $fpath as _hive: hive completion zsh > ~/.zsh/completions/_hive
_hive() {
  local -a candidates
  candidates=( "${(@f)$("${words[1]}" __complete "${words[@]}" 2>/dev/null)}" )
  compadd -a candidates
}
compdef _hive hive


```

### version.stdout

before:
```
honeybee 0.0.1-dev.4531a680faa2.dirty

```
after:
```
honeybee 0.0.1-dev.a9fdcead6ed8

```


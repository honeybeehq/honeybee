# deploy / rollback / completion: before vs after

before: /home/trmd/.hive/v2/cells/rebuild-p2-honeybee-freeze-36fabec3cd02/github-com-honeybeehq-honeybee-a9015b303498-space-36fabec3cd02/.proof/p2-honeybee-freeze/after
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
| complete-deploy-flags | stdout | 0 | 0 | yes | yes |
| complete-send | stderr | 0 | 0 | yes | yes |
| complete-send | stdout | 0 | 0 | yes | yes |
| complete-top | stderr | 0 | 0 | yes | yes |
| complete-top | stdout | 0 | 0 | no | NO |
| completion-bash | stderr | 0 | 0 | yes | yes |
| completion-bash | stdout | 0 | 0 | yes | yes |
| completion-fish | stderr | 0 | 0 | yes | yes |
| completion-fish | stdout | 0 | 0 | yes | yes |
| completion-zsh | stderr | 0 | 0 | yes | yes |
| completion-zsh | stdout | 0 | 0 | yes | yes |
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
freeze
handoff
harnesses
health
help
here
human-ref
import
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

### complete-top.stdout

before:
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
freeze
handoff
harnesses
health
help
here
human-ref
import
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

### version.stdout

before:
```
honeybee 0.0.1-dev.87699fb6734b.dirty

```
after:
```
honeybee 0.0.1-dev.a9fdcead6ed8

```


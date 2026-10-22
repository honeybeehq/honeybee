# Phone envelope v1

`phone.envelope.v1` extends the existing phone mailbox envelope with durable
operation taint and authenticated caller derivation. It is advertised only when
local service registration and native peer verification are ready. Apiary must
refuse phone admission without this capability. Deployment and activation remain
held for Queen review.

Only registered direct-local Apiary service connections may assert
`context.phoneOrigin` and `context.sessionPrincipal:{beeId}`. Phone request
parameters never supply either context. Apiary must preserve these fields through
its authenticated bridge, node forwarding and durable workflow effect inputs.
Honeybee resolves the local principal again in the send or spawn transaction;
caller snapshots cannot remove current taint. Sender strings confer no authority.

Phone mail is stored with its original bytes, owner-assigned envelope and escaped
delivery body. Successful delivery, including inbox acknowledgement, sets
`BeeRow.phoneOperationOrigin`. Phone initial prompts taint at spawn. A child of a
tainted authenticated caller inherits the label even with no prompt or source
references. Derived messages remain ordinary permitted messages, with the fixed
label that human approval is not verified. Subsequent unrelated output can be
conservatively labelled.

`view({beeId}).bee.phoneOperationOrigin` is the owning-node read surface.
`bee.phone_origin` audit rows carry `{origin}` and update that field in replay.
`phone.content_admitted` is an informational audit row carrying `{phoneInput}`.
Source references resolve against durable local mail and crew content records.
Foreign or missing source records lower ancestry to `unknown-overflow`; they
never establish human approval. Signed cross-node receipts are out of scope.
Apiary must refuse operator-relay fallback for tainted callers.

`phone.origin.admit({content,idempotencyKey}, context.phoneOrigin)` admits a crew
biography without creating a mailbox or a bee. The context must specify
`contentKind:'crew-bio'` and `target:{kind:'crew',id}`. The result is
`{phoneInput,deduped}`. Its `targetBeeId:''` means no bee target, and must never
be interpreted as a wildcard. Apiary stores the receipt in its crew registry and
uses source relation `bio-briefing` in future incarnation prompts. Reusing the
key with different content or context fails. A bee target for a new spawn requires
a server-preallocated `spawn.id` equal to `phoneOrigin.target.id`; Apiary persists
that UUID with the effect input. A request key is not a bee target placeholder.

`bee.phoneOrigin.reset` is disabled and unadvertised. Every call refuses, including
registered-service calls with a claimed workstation-human assertion. Queen must
approve a concrete authenticated issuer before any reset can be enabled. No reset
UI or authority is introduced here.

This contract covers authenticated Apiary paths. A shell `hive send` can still
omit the authenticated principal or impersonate sender strings. Arbitrary file
reads and shell egress are not tracked. Neither text, a sender string, nor a taint
label is evidence of human approval.

Fixture verification uses `env -i` with HOME and TMPDIR inside the owned Cell.
On long Linux Cell paths, `/proc/self/cwd/.audit/tmp` is a short pathname for that
same Cell directory, keeping Unix socket paths under the kernel length limit.
Run `node --test v2/core/tests/phone-taint.test.ts` and
`node --test v2/daemon/tests/phone-envelope.test.ts` with those isolated variables.
The latter starts real disposable daemons, checks a second owner, restart,
idempotent replay, forged input and every reset context. It prints named PASS
receipts. Not checked on real data.

# Archived dedup benchmark metadata correction

Reviewed by Art for the 2026-09-07 nightly regression review.

The archived `docs/performance/2026-09-07-exhaustive/designs/dedup-sweep-v3.mjs` and author-v2 ruler use `scenario.pendingSeeded` for the configured background-pending parameter. That field is not the total number of pending rows in the fixture. Source commit: `6d2677b126ec9e8b11992954bb6bc3c27311bbf1`.

| Scenario | Background parameter | Total pending rows |
| --- | ---: | ---: |
| wide-cadence | N | N + 1 |
| probe-cadence | N | N + 256 |

Wide adds one tracked overdue message. Probe adds 256 urgent messages. The separate wide `probePlan.pendingSeeded` already includes the extra message. This is a low severity metadata inconsistency. The fixture, operation timing, source fingerprints and saved raw measurements remain valid. Original scripts and results remain unchanged to preserve their recorded digests. This document corrects their interpretation.

Art reran the original v3 ruler with `--pending 20 --rounds 1 --mode none`. A second run added one diagnostic read of `store.listUndeliveredMessages().length` immediately after seeding, before any timing. Both runs completed successfully. The diagnostic produced:

```json
{"fixture":"wide-cadence","actualPendingRows":21}
{"fixture":"probe-cadence","actualPendingRows":276}
```

Both saved scenario records say `pendingSeeded: 20`. The reproduction uses archived source revisions `1576571c` and `dfecaeba`, isolated temporary databases, and Node 24.18.0. It is a correctness check, not a new performance claim.

To reproduce from a clone containing the reviewed refs:

```sh
node docs/performance/2026-09-07-exhaustive/designs/dedup-sweep-v3.mjs --repo "$PWD" --out /tmp/dedup-count-check.json --pending 20 --rounds 1 --mode none
```

For the diagnostic run, insert this statement after `const meta = seed(store);` in an external copy of the ruler:

```js
process.stderr.write(JSON.stringify({fixture:name,actualPendingRows:store.listUndeliveredMessages().length}) + "\n");
```

Original v3 script SHA-256: `66b77cccfe0f152468062806955eb97203e55f3600572ad0e0c3ed97109dd75a`. Complete diagnostic log SHA-256: `8590291e9dfde27b65c4fa969f3ae8d8d9fdfbed26df8135a0680dfe09a5b725`, 265 bytes, exit 0. The script hashes its own diagnostic copy and both imported source trees in the saved result.

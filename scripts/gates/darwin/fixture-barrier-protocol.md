The plain sibling harness uses a gate-only barrier immediately after the reviewed test writes `work/sandbox.sb` and before it starts the recipient. The recipient production argv is unchanged. The instrumented run retains its existing preloader mediation and receives no barrier environment key.

The receipt states: "plain run: production argv exact; harness synchronized by gate fixture barrier before exec".

The controller creates a private AF_UNIX listener at `sealed-target/control/b-p0.sock` or `b-p1.sock`. Its canonical directory is controller-owned and mode 0700; the socket identity and ownership are checked before use and ACK. Only `SCG_FIXTURE_CONTROL_SOCKET` discovers this endpoint. Without that key, the test helper returns before any additional import, I/O, timer, logging or wait. Node 24.18.0's default-isolation runner supplies only stdin, stdout and stderr to its internal child (`internal/test_runner/runner`, lines 482 and 501–508), so a directly inherited extra fd would not reach the test.

There is exactly one connection per row. Before reading any bytes, the controller authenticates the kernel peer uid and birth through the pinned scope helper, matches its retained birth, and requires the expected internal test-runner role. Unknown roles wait without reading, within the same deadline; wrong identities fail. No client-supplied pid is accepted.

The test sends one UTF-8 JSON line, at most 4096 bytes, with exactly these keys and values:

```json
{"version":1,"operation":"profile-ready","rowId":"<exact reviewed row name>","fixtureRoot":"<canonical fixture root>"}
```

Duplicate keys, additional keys, multiple lines, invalid UTF-8, wrong types, wrong row names, incomplete frames, EOF and oversized frames fail. The message contains only the locator, never profile bytes, policy or argv. The controller independently materializes the reviewed manifest template, enforces its direct `fr-` fixture root under the fresh sibling TMPDIR, reads the on-disk profile, verifies its regular-file identity and nlink=1, and compares bytes with the real production renderer. Existing mediation enforces the policy and published-content path. ACK is sent only after successful approval.

The ACK is exactly these 28 ASCII/UTF-8 bytes, including the final LF:

```text
{"version":1,"approved":true}
```

The controller then closes the connection. The test waits for EOF and compares the entire byte sequence, with a 256-byte bound; duplicate keys, whitespace variants and trailing bytes fail. The controller emits no NACK: refusal closes during cleanup without ACK. If a future NACK is introduced it requires a versioned protocol review, not permissive JSON parsing.

The controller's per-connection deadline is 15 seconds, including authentication, rendering and ACK. The test's total connect/ACK deadline is 30 seconds. A timeout or malformed exchange fails. A second connection fails even after the first ACK. The socket is closed after the phase; no unlink is needed during evidence retention.

The own-process socket sampler recognizes only this exact controller endpoint as `gate-barrier`. Other Unix observation behavior and all IP connection checks are unchanged. The XNU public `proc_info.h` at tag `xnu-12377.1.9`, lines 414–424, defines `unsi_caddr` as the connected Unix address; lines 493–498 define `SOCKINFO_UN`.

The barrier proves a template-exact profile existed on disk before recipient launch. It does not atomically bind the bytes consumed by sandbox_init: the accepted consumed-profile attribution, swap-and-restore, queried-write-path-only and plain sampling limitations remain. The test also awaits its owned recipient/host exit before deleting its fixture; a fire-and-forget dispose is insufficient. A missing file at initial approval still fails.

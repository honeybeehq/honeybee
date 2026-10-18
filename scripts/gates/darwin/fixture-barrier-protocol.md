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

## Reader idle lifetime observation (Darwin focused gate owner: f585)

The Darwin focused gate owns and removes this fixture-only synchronization. It is
limited to the exact `cell-sandbox` and `satellite-default` plain sibling rows.
There is no fallback, CI auto-enable, product-driver instrumentation or instrumented
mode endpoint. The reader entry, production argv and production-rendered SBPL remain
unchanged. The test calls the helper only when `SCG_FIXTURE_OBSERVATION_SOCKET` is
present, after every read/digest/header/write-denial assertion and diagnostic. Without
that variable the call-site branch performs no await, dynamic import, socket or timer.
The fixture reader itself receives no new data and performs no additional I/O.

The controller creates private `o-p0.sock` / `o-p1.sock` sockets alongside, separately
from, the pre-exec profile barrier. The pre-exec names and single-connection contract
remain unchanged. Before launching HSR, the test temporarily removes the new variable
from `process.env` during synchronous `driver.start`, restoring it in `finally`.
This excludes it both from the resolver's reader env spread and from the host's
`nativeNodeEnv()` snapshot. No async work occurs inside this temporary removal.

One connection per row is authenticated by uid, exact birth and the retained internal
plain test-runner role before any request read. The bounded request is UTF-8 JSON
with exactly these keys and no duplicates, followed by one newline (4096 bytes max):

`{"version":1,"operation":"reader-observed","rowId":"<exact reviewed row>","fixtureRoot":"<canonical fixture>"}\n`

No profile bytes, process identity, argv or payload travel through this channel.
The controller binds the locator to this row's approved profile, exact reader birth,
host/internal-runner/root chain, prior validated argv/cwd/sandbox observation and
successful live write-policy probes on the approved paths. Missing proof leaves the
non-blocking request pending while the sampler continues. A fresh exact-birth live
check immediately precedes each ACK send attempt. The canonical ACK bytes are exactly:

`{"version":1,"observed":true}\n`

The controller sends only those bytes, shuts down its write half and requires the
client to close after accepting the exact ACK and EOF. A send/shutdown/peer EOF error,
malformed request, second connection, stale or wrong-row evidence, gone reader or
15-second controller deadline fails the row. The client has one 30-second deadline
for connect, ACK and EOF; failure enters the existing awaited teardown and fenced
cleanup. The HSR driver has no idle expiry/restart timer: its stop grace timer is
armed only by explicit stop. The runner's fixture-lease timer continues checking the
still-live test owner; it is not an idle timer. The test does not call dispose until
its hold finishes or fails. Existing teardown still awaits owned-child exit before
removing the fixture root.

`readerLifetimeBarrier` records only enablement, verdict, connection/authentication
counts or booleans, observation/live-at-ACK booleans, failure enum and disclosure. With
no connection it is inert; all existing required reader-role and mediation checks
still apply, so absence of a client cannot substitute for observation. The exact
second endpoint is sampled as `gate-observation-barrier`, separately from the unchanged
pre-exec endpoint. Production SBPL bytes and the renderer are untouched; equality
and the real unchanged-profile Darwin run remain required evidence.

Receipt disclosure:

"plain run: production argv exact; reader lifetime extended by the Darwin focused gate fixture until the controller acknowledges a complete live reader observation; this proves an extended idle lifetime, not observation during the actual read/write or unextended timing; removal owner: Darwin focused gate (f585)."

This does not make exec/connect sampling event-complete, identify the exact profile
consumed by sandbox_init, exclude swap-and-restore, or provide general OS network
isolation. Normal unextended reader timing is not proven by the synchronized row.

The optional top-level, reviewed audit boolean `readerLifetimeBarrierRequired` defaults
to false when absent; every other type is refused. The audit file's digest binds this
choice to the candidate, independently of whether its fixture connects. When true,
each plain production row requires enabled, authenticated, approved, complete reader
observation and live-at-ACK evidence (all true), one connection and no failure.
Otherwise it fails `reader-observation-required` even if the sampler roles alone pass.
Instrumented rows remain unchanged. The paired candidate sets this flag to true.

Optional no-client operation adds controller listen/verify/accept-poll work, so it does
not promise identical timing. It adds no deliberate wait or native sampling queries.
Before the endpoint is accepted, the native connection query for the pre-exec socket
simply does not print this distinct observation socket. Its exact classification is
collected after accept; this pre-accept classification gap does not prove absence of
connections. Neither exception is widened to other paths.

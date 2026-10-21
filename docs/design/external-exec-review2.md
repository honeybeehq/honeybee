# Second review fixes

Base 95449d519dd33ffcbea7792c6d54753a09275633. DEPLOY HOLD and phase-3 code gate
remain. No real bridge operation, guest credential, merge or deployment.

Public config/CLI targeting leaves owner files unread and retains the ordinary
socket. The daemon and external-exec command explicitly load protected management
configuration. The daemon adds a separate management-only listener; ordinary
clients cannot challenge/register external authority on the public socket. Tests
keep public health/config usable while the key is unreadable to the test CLI.
Owner roots cannot contain the hive v2 root, public data root or Cell roots.

A valid receipt now settles even when capture is truncated. Model outcome remains
in status; capture is independently complete/truncated. The bridge receipt is not
rewritten. Capture metadata is durable across receipt replay, and the daemon drops
the terminal attempt's fence without restoring it on deduplication. This is an
additive view/mirror/audit change, using existing schema-48 prototype storage.

External stop timers outlive the host leader's exit. Discovery reads only process
metadata; signaling requires a verified member PID, birth, boot identity and pgid.
KILL remains armed until group empty or a verified signal is sent. The regression
spawns a SIGTERM-resistant survivor, lets the leader/host exit, and verifies the
survivor is killed. Unknown ownership refuses signals and remains uncertain.

Private bootstrap accepts its doubly encoded maximum form and clears its byte
buffer. The narrow runner-host artifact import allowlist includes privateBoot.ts;
the artifact tests caught that missing allowlist entry on the first remainder run.

Ur Bench issued replacement FINAL main 14de2f119af5a822c12e8910339666c311dace27
under /opt. Candidate owner JSON is updated but remains non-authoritative. The
second read-only row verifies all three hashes, uid 0, launcher 0555, manifests
0444, all 1913 inventory files and 2038 symlink-expanded components. Each flipped
hash independently refuses. Reproduce with scripts/proof/external-exec-pins.ts and
the candidate JSON. The old home-layout refusal row remains unchanged. No bridge
was executed, registered or activated by these checks.

The owner root still requires a separate uid or mount namespace excluding Cells;
permissions alone do not isolate unrestricted same-uid clients. OS/runtime/CA
updates require new pins. The feature stays disabled and not usable until Queen
PASS; DEPLOY HOLD and phase-3 code gate remain.

## Validation

- npm run check, npm run v2:check, npm run build and git diff --check pass.
- Core/fleet: 605 core plus 6 fleet tests pass.
- Adapter/driver: 174 tests pass. External targeted suite: 28 pass.
- Config, local RPC and CLI target regressions: 36 pass; counts overlap.
- All 91 previously unreached serial daemon/CLI files completed: 713 tests,
  709 pass, zero fail, four intentional native-Codex skips. No remainder is left
  unrun after the two original delivery-file-read fixture failures.
- The first remainder run hit four runner-host artifact tests blocked by the
  missing privateBoot.ts import allowlist entry. That build error was fixed;
  the complete 91-file remainder then passed. Both logs are retained.
- New FINAL read-only row: three matching pins, install chain pass, 1913 files,
  2038 traversal components, three independent mismatch refusals. No execution,
  registration, guest start or live configuration change.

Logs, explicit remainder file list and summaries are in
.local/external-exec-dev/r2-*. The two sandboxed delivery-read cases remain
unverified in this environment; the earlier run recorded those fixture setup
failures before any read was exercised. Other tests were run in isolated fixtures
on metal-3. Queen review still precedes any real bridge lifecycle proof.

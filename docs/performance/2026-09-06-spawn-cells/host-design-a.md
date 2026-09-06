# Design A, Fable5 proposal captured by parent

The daemon resolves a host-command callback once at boot. A new hostEntry helper
selects an explicit override, then a dedicated runner-host.js beside the bundled
daemon module, then the existing CLI re-invocation fallback, then the existing
source-driver default. Pin the artifact realpath at boot. Build the new artifact
from runner-host-main.ts. Preserve the hidden CLI verb.

Fable favors keeping packaging knowledge in the deployment-aware daemon. Its
strongest alternative B places source/bundle resolution behind the driver
method that already selects the source entry, removes argv inference and needs
less caller knowledge. Proposed A tests cover the selection ladder, real staged
layout, explicit overrides, missing-artifact fallback, recovery and a current
symlink swap. The host bundle must contain only runner-host-main/runner-host
and Node builtins. Deploy copies dist recursively.

Parent corrections to A: daemon config has no hostCommand property today; do
not add an unsolicited config option. HsrDriverConfig.hostCommand is the actual
existing override. An injectable module-URL knob is unnecessary when real bundle
tests can exercise resolution. Missing required artifacts should be considered
packaging failures rather than automatically routing through the old heavy CLI.

The full proposal was returned in Fable session
ac77895f-def0-4a32-b607-478c7c2ba351. An attempted transcript-file capture failed
on a live-daemon list RPC timeout; this is the parent's bounded capture of the
received design, not a verbatim transcript. No production edits by Fable.

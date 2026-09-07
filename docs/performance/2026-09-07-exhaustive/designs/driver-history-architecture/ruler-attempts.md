# Ruler authoring attempts

1. First A/A smoke exited before starting children. Passing realpathSync directly to Array.map supplied the numeric array index as its options argument. Node raised ERR_INVALID_ARG_TYPE. No report, hosts, or measurements were produced. Fixed by an explicit one-argument lambda. Tool-call output retains the original stack trace.

2. V1, v2 and v3 Studio A/A numeric and snapshot smokes completed. V2 additionally pins the exact semantic stream, source host entry and parent tool hash. V3 adds an owned-fixture identity sidecar for failure inspection. Original versions and outputs remain separate.

3. First Mini v3 A/A smoke failed on count 0, run 0, before any valid completed child. The parsed boot witness arrived before the socket-connect retry. liveState asserted a non-null socket instead of waiting for connection. The caught failure retained the report and child log; the ownership sidecar proves fixture_removed. V4 adds an explicit booted-and-connected barrier and treats a still-connecting socket as pending in the later drain barrier. The final non-null socket and zero-queue requirements remain assertions. This changes the probe, not production, and no failed measurement is used.

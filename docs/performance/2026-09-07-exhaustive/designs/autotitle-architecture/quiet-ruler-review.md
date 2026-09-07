# Quiet-scan ruler review

Draft476058293bb3e8155f66b4c02594b73b96b737be12b27daf0bde50611ff50d91 was read end to end. Its real store-backed factory, copied fixture files, before-module signature seeds, quiet-sidecar/audit/state checks, separate raw SQL/allocation diagnostics, ABBA schedule and retained raw samples are the right basis. No canonical acceptance yet.

Required revisions sent to the author in message4138:

1. Exact caller-specified runtime delta, not any changes under core/daemon.
2. CPU/wall measured through awaited dispatcher completion. The first draft times only synchronous Promise creation, which misses work if a treatment moves it later. SQL replay must state its synchronous-entry scope and source verification obligation.
3. Outcome assertions outside the allocation sampling window.
4. Rename the offline mailbox row counter. syntheticAuditRows falsely suggests audit rows were generated; they were not.
5. Mix pending and delivered giant rows, record counts and valid generation, so retained-history scans exercise both union arms. Preserve all-pending v1 as a distinct structural fixture, not an interchangeable baseline.
6. Checked scalar readers and explicit PK-oracle scope, replacing blind raw-row coercions.
7. Reject every run/exec call in the quiet SQL replay rather than three SQL prefixes. Keep full state and sidecar invariants.
8. First-scan label describes a cold dispatcher over a prepared, already inspected fixture. It is not cold process or filesystem latency.

The first draft and both successful Studio structural A/A reports must remain frozen. Their numbers are not Mini performance claims. The author owns only draft revisions and cheap structural smokes; the parent owns canonical captures and acceptance.

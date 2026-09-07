# Cell Git resource-tool review

Reviewed tooling `9426b00c` and native follow-up `dbfa09c9`. Accepted as optional macOS diagnostics after Mini build, 17 ruler tests, native process proof, eight-case smoke and controlled canonical captures.

Review caught Python 3.9 monotonic clocks being compared between wrappers, setup cleanup outside the protected block, and insufficient native evidence in synthetic tests. The committed tool uses locked sequence numbers and setup failure cleanup. The follow-up executes the actual shim against a compiled fixture. Complete argv/environment/stdio and signal behavior match direct execution; waited-grandchild CPU and RSS maximum semantics are asserted using native counters.

Validation matches Trace2 roots and descendants by process/child identities, retains duplicate same-code exits, rejects conflicting outcomes and missing records, and normalizes only the owned random scratch-clone path. Trace2 and resource clocks are separate from headline timing. Python launch work is excluded from child CPU; added wrappers never enter production.

Resource counters prove Git-tree CPU and the maximum individual-process RSS only. They do not establish whole-tree concurrent memory, daemon retention, scratch bytes or whole-RPC latency. Three diagnostic pairs are retained without calling them a latency distribution. See [evidence and limitations](../performance/2026-09-07-exhaustive/cell-git-rusage-results.md).

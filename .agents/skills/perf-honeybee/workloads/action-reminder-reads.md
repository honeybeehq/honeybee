# Action reminder question reads

Run the JSON recipe with Node 24.18.0 after creating `.proof`. This workload uses the real SQLite store and public `DaemonCore.step` with a FakeDriver and virtual clock. It starts no provider or runtime process. Boot, dispatch, an answered question and the first reminder (where applicable) are setup, outside the counter window.

Predeclared gate: zero `getQuestion` calls in ten unchanged steps for answered Fix actions and already-reminded Commit attempts at 0/1/12/120 bees, three rounds each. Preserve action rows, questions, delivered bodies and audit. A separate eligible Commit control reads its answer timestamp at each tick, waits until exactly thirty minutes after the answer and sends one reminder. Existing `actions.test.ts` covers progress, waiting, completion/cancel, archived bees, restart and retry; run it alongside the count recipe.

The receipt's completeness describes the 24 count samples; the Node test exit is authoritative for the separate behavior control. Failed samples remain in the receipt. A count assertion fails on the unchanged baseline without invalidating successfully captured state comparisons.

This is a store-call count, not a latency, CPU, RSS or physical-I/O result. Eligible attempts gain one extra pure policy evaluation; its CPU cost and total scheduler work are unmeasured. The guard neither caches questions nor changes reminder policy, schema, clock reads or delivery urgency.

Retained candidate receipt: `baselines/action-reminder-reads.json`. Three paired executions of the same collector agree: each nonempty baseline sample makes 10/120/1200 reads at 1/12/120 bees, and the candidate makes zero; empty controls remain zero. Each execution includes three rounds per size/scenario. All action/question/mail/audit comparisons pass. Baseline count assertions fail as intended; eligible boundary controls pass in both arms.

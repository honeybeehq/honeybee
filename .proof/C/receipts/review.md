reviewed by claude-opus-5-5

Independent read-only reviewer: f6d9fdfa-0eef-478f-b6bf-34767f826445. Reviewed 69015576, 21d08241, d479089f, ca85c0a3, and the concurrent scenario at 6285a617. The reviewer did not run suites.

Initial missing-receipt and incomplete-gate findings were resolved or withdrawn when 21d08241 landed complete logs. Stronger kind/progress/reason/home/result assertions, 33-second holds, provenance metadata, and fixture drift guards were accepted. The native-output wait correction at ca85c0a3 was accepted.

Attention:

- Earlier receipts/final and unknown-soak retain historical evidence. Their served-turn claims are superseded: they did not await native continuation success. The attempted strengthened full rerun was also superseded when the checkout changed before its last scenario finished.
- The old a9ed38ee gates had two accounts RPC failures. Shadow advisory-plus-legacy-pick behavior predates C; the second exhaustion still waited. The ceiling fork-count cause was not established here. The implementation owner later reported 128/128 green on ae02e793; that is the owner's evidence, not a rerun by this worker.
- Active-mode retry timing versus a provider reset was referred to the implementation owner. This lab proves owner deferral, not fleet capacity or owner coordination.
- The concurrent scenario proves shared bounded probes, both initial evaluations, and retained waits. It does not prove every obligation is re-admitted after the second shared refresh; unchanged waiting rows intentionally avoid audit churn.
- The broader action/tool-effect, progress-after-side-effect, context-recall, claim/lease, and mid-swap crash matrix is outside this focused lab and remains explicit in README.
- Low residual risks: a partial final journal line can make JSON parsing fail spuriously; a duplicate turn appearing after the immediate successful-turn count could escape that count. Durable recovery/mail IDs and audit rows are checked separately.

No blocking findings were reported for the concurrency addition. DEPLOY HOLD was preserved.

The reviewer also inspected native Codex proof commits 44ab84ce, 6f384594, and 8173bfcb. The initial condition drift and import-before-shebang startup failures were corrected at 8173bfcb; no blocking script findings remained. The corresponding startup receipts are invalid behavior evidence for any Codex scenario at those two intermediate heads. The real e8e50a53 run on 8173bfcb captured the 100% baseline and later 5% source usage but timed out waiting for continuation. It is recorded as failed and was sent to the implementation owner, whose newer cooldown fix was not rerun by this worker.

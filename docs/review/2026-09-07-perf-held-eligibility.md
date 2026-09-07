# Held-mail move lookup review

Reviewed d91ab30e..4ebf43c9. Both eligibility filtering and active-move lookup are synchronous reads before driver effects. Moving the read after the empty-eligibility return cannot admit an interrupt or delivery that was previously fenced. The lookup still happens before effects when an eligible message exists, and remains fresh for each Bee. No same-step or cross-step cache introduces reentry or rollback staleness.

The existing policy distinguishes real-running from synthetic-running state; that expression and the filter are unchanged. The test proves held mail remains pending with no interrupt and becomes deliverable at turn end, with the live lookup retained at that point. Existing mixed urgency, Cell move, retry, and placement tests passed on Mini.

The cost tradeoff is additional filtering for a move that would have blocked delivery earlier. The opposing 10,000-message workload measures this explicitly, with up to roughly 0.11 ms extra CPU. The distributed held fleet saves about 9 ms per tick at 10,000 Bees. The existing temporary eligibility array remains an optimization opportunity, not a reason to broaden this patch before measurement.

No correctness blocker found. Combined core/daemon verification remains the final merge gate.

Combined `4ebf43c9` passed core 213/213 and the serial daemon suite with 358 passes and one platform skip. The exact combined production source also passed all v2 typechecks, repository build, and the 68-test loop suite. Logs are `verification/mini-move-held-integrated-*.log` and `mini-held-eligibility-*.log`. No remaining merge gate for these two changes.

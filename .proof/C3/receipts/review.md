Attention

reviewed by claude-opus-5-5

Checker 63d11998-2ffd-442f-a169-251ac573f166 reviewed a8b2b49a and the final code delta 9a8f3b23. The first pass found that raw percentages and exhaustion stamps would collapse the backoff. The final capacity-bucket signature fixes that. Final verdict: no High or Medium findings. Reviewer also verified the attempt-start deadline fence and durable shared scheduling. Review was a source review, not a lab run.

Bounded lows: ordinary admission polling can still run every30s without provider IO; clock rollback can delay a stored absolute deadline; account removal leaves harmless cadence metadata. Unknown reset detection can take up to15min and extra source baseline verification may require another interval. Per-probe audit/log output is retained for G, bounded by the cadence.

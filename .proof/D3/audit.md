# Attention

reviewed by claude-opus-5-5

Session edee73fc-5d3d-4654-9046-c18550bc58cc reviewed the test-only diff, relevant source predicates and the additional fixture-token lifetime adjustment. No flags (Apiary messages 7405 and 7410). The reviewer did not run tests. All final matrix and full-file receipts use the exact final source.

The initial review found that a second automatic refresh could race slow polling. The fixture now issues a two-hour access token for the first automatic refresh, beyond the one-hour ahead window, so the exact generation-6/provider-count-5 assertions remain stable. All explicit refreshes still use one-hour tokens with the automatic tick disabled. The automatic phase runs after a fixture daemon restart with the same persisted store; same-process immediate-after-explicit-refresh coverage is shifted to this restarted phase.

No product source, assertions, intervals or sleeps changed. Both daemon outputs remain covered by the existing secret scan. The read-only test HOME uses mode0500 and verified EACCES, not the actual gate tmpfs mask. The exact same delayed-result preloader caused the retained pre-fix failure and passes in the final matrix. No merge or deployment.

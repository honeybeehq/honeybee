Proactive provider-turn admission

Read summary.json for the scenario verdicts. Read each matching rpc.json for accepted mail, delivery generation, durable recovery, reservation count, and audit notices. The journal.jsonl and daemon.log files record the actual fake-provider run.

The lab starts real Honeybee daemons in isolated homes and uses fake Claude/Codex harnesses and a loopback limits server. It covers human mail, worker mail, action dispatch, projected usage, stale facts, accepted running work, both accounts in reserve across the 30-second retry interval, source restoration after a known reset, autoswap=false, and active owner-required recovery. No provider limit is emitted. Action dispatch does not complete the action attempt.

Run with login:false and env -i. Create a private 0700 root under /var/tmp, set HOME to a fake directory distinct from the daemon home, TMPDIR to that root, PATH to the installed Node and system tools, and NODE_COMPILE_CACHE/XDG_CACHE_HOME to directories inside the Cell or run root. Then run `node .proof/E/lab.ts`. The script retains the fixture roots and never invokes helper cleanup.

Gates are in check.log, v2-check.log, build.log, and suites.log. Existing suite cleanup is redirected to the isolated trash by `.proof/B/trash-cleanup.mjs`. The scoped suite runs account-allocation, accounts-service, accounts-rpc, auth-resume, auth-resume-rpc, actions-rpc, accounts-activity, accounts-activity-batch, and accounts-reservation-visits. The final run explicitly skips the weekly-ceiling boot-log assertion reproduced on the base, as well as the existing real-HOME import test. Both failing base/current logs and the passing isolated ceiling retry are retained.

Native provider self-wakes outside Honeybee delivery cannot be prevented before provider use. Existing authoritative provider-limit recovery remains the fallback. Active mode proof here covers durable owner-required waiting; the real owner-routing integration is C2/G. Full Codex cross-home context proof follows D in the final project lab. No deployment was performed.

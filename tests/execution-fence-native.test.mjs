import { spawnSync } from "node:child_process";
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ["scripts/run-v2-daemon-tests.mjs", "v2/daemon/tests/execution-fence.test.ts", "v2/daemon/tests/effect-resolve.test.ts", "v2/daemon/tests/idempotency.test.ts", "v2/daemon/tests/mailbox-only.test.ts", "v2/daemon/tests/local-rpc-trust.test.ts", "v2/daemon/tests/local-rpc-security.test.ts", "v2/daemon/tests/loops.test.ts"], { encoding: "utf8", env });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`native execution tests failed: ${result.status ?? result.signal}`);
if (!/^(?:# |ℹ )tests [1-9][0-9]*$/m.test(result.stdout ?? "")) throw new Error("Native execution test runner ran no target tests");

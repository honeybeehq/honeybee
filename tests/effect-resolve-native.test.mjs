import { spawnSync } from "node:child_process";
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ["scripts/run-v2-daemon-tests.mjs", "v2/daemon/tests/effect-resolve.test.ts", "v2/daemon/tests/idempotency.test.ts", "v2/daemon/tests/mailbox-only.test.ts"], { stdio: "inherit", env });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`native effect tests failed: ${result.status ?? result.signal}`);

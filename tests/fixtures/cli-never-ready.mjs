import { writeFileSync } from "node:fs";

writeFileSync(process.env.HIVE_TEST_NEVER_READY_PID_FILE, String(process.pid));
setTimeout(() => {}, 60_000);

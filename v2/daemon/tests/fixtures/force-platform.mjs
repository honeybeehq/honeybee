// Test preload: a daemon process that reports another OS (HIVE_TEST_PLATFORM).
import { exactProcessBirth, inspectProcess } from "../../../harness/src/processIdentity.ts";
if (process.env.HIVE_TEST_PLATFORM !== process.platform) {
  if (inspectProcess(process.pid).kind !== "present" || exactProcessBirth(process.pid) === null) throw new Error("Native identity unavailable before test platform simulation");
}
Object.defineProperty(process, "platform", { value: process.env.HIVE_TEST_PLATFORM });

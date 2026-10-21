import { exactProcessBirth } from "../../../harness/src/processIdentity.ts";
const owner = Number(process.env.HIVE_TEST_OWNER_PID ?? "");
const ownerBirth = process.env.HIVE_TEST_OWNER_BIRTH ?? "";
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
if (Number.isSafeInteger(owner) && owner > 1) {
  let ticks = 0;
  const watch = setInterval(() => {
    ticks += 1;
    if (alive(owner) && (ticks % 8 !== 0 || ownerBirth !== "" && exactProcessBirth(owner) === ownerBirth)) return;
    clearInterval(watch);
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 5_000).unref();
    process.kill(process.pid, "SIGTERM");
  }, 250);
  watch.unref();
}

import { execFileSync } from "node:child_process";
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
const birthOf = pid => {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim().replace(/\s+/g, " ");
  } catch {
    return null;
  }
};
if (Number.isSafeInteger(owner) && owner > 1) {
  let ticks = 0;
  const watch = setInterval(() => {
    ticks += 1;
    if (alive(owner) && (ownerBirth === "" || ticks % 8 !== 0 || birthOf(owner) === ownerBirth)) return;
    clearInterval(watch);
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 5_000).unref();
    process.kill(process.pid, "SIGTERM");
  }, 250);
  watch.unref();
}

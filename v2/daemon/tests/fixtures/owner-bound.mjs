const owner = Number(process.env.HIVE_TEST_OWNER_PID ?? "");
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
if (Number.isSafeInteger(owner) && owner > 1) {
  const watch = setInterval(() => {
    if (alive(owner)) return;
    clearInterval(watch);
    setTimeout(() => process.kill(process.pid, "SIGKILL"), 5_000);
    process.kill(process.pid, "SIGTERM");
  }, 250);
  watch.unref();
}

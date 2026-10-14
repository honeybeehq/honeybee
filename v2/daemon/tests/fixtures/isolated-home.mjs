import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
const canonical = value => { try { return realpathSync(value); } catch { return resolve(value); } };
if (!process.env.HOME || [userInfo().homedir, process.env.HIVE_TEST_INVOKING_HOME].filter(Boolean).some(home => canonical(home) === canonical(process.env.HOME))) {
  throw new Error("Test child HOME must differ from the invoking user's home");
}

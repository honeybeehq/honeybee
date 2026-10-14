#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
const home = dirname(process.argv[1]);
const [verb, secret, field] = process.argv.slice(2);
const leakedEnv = Object.keys(process.env).filter((key) => key.startsWith("L3A_") || key.startsWith("HIVE_")).join(",");
appendFileSync(join(home, "calls.log"), `${verb} ${secret} ${field} env-extra=[${leakedEnv}]\n`);
const flag = process.argv.slice(2).find((arg) => arg.startsWith("-"));
if (flag || verb !== "get" || process.argv.length !== 5) {
  process.stderr.write(`error: unexpected argument '${flag ?? process.argv.slice(2).join(" ")}' found\n\nUsage: hem get [OPTIONS] <SECRET> [KEY]\n`);
  process.exit(2);
}
if (verb === "get" && secret === "global/hive-naming-l3a-mock" && field === "api_key") {
  process.stdout.write(`${readFileSync(join(home, "key"), "utf8")}\n`);
} else if (verb === "get" && secret === "global/hive-naming-l3a-pending") {
  process.stdout.write("approval_required        true\npending_request_id       apr_l3a_fake\n");
} else {
  process.stderr.write(`status: NotFound, message: "secret not found: ${secret}", details: []\n`);
  process.exit(1);
}

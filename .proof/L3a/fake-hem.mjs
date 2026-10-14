#!/usr/bin/env node
const [verb, secret, field] = process.argv.slice(2);
if (verb === "get" && secret === "global/hive-naming-l3a-mock" && field === "api_key") {
  process.stdout.write(`${process.env.L3A_FAKE_KEY}\n`);
} else {
  process.stderr.write(`status: NotFound, message: "secret not found: ${secret}", details: []\n`);
  process.exit(1);
}

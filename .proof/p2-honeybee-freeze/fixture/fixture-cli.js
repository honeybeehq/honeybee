#!/usr/bin/env node
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const identity = JSON.parse(readFileSync(new URL("./build-identity.json", import.meta.url), "utf8"));
if (argv[0] === "v2" && argv[1] === "daemon" && argv[2] === "status" && argv.includes("--json")) { console.log(JSON.stringify({ running: true })); process.exit(0); }
if (argv[0] === "v2" && argv[1] === "daemon") process.exit(0);
if (argv[0] === "v2" && argv[1] === "deploy-info") { console.log(JSON.stringify({ pid: 4242, startedAt: 1, nodeVersion: process.version, identity })); process.exit(0); }
console.error("fixture cli: unsupported " + argv.join(" ")); process.exit(2);

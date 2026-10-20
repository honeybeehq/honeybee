import { readFileSync } from "node:fs";
const wallNow = Date.now.bind(Date);
Date.now = () => wallNow() + Number(readFileSync(process.env.C3_CLOCK_PATH, "utf8"));

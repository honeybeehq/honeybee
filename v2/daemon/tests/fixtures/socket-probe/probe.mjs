import { connect } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const TARGETS = ".socket-probe-targets.json";
const RESULTS = ".socket-probe-results.json";

function attempt(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve("connected");
    });
    socket.once("error", (err) => resolve(err.code ?? String(err)));
  });
}

let busy = false;
setInterval(async () => {
  if (busy || !existsSync(TARGETS) || existsSync(RESULTS)) return;
  busy = true;
  const results = {};
  for (const path of JSON.parse(readFileSync(TARGETS, "utf8"))) results[path] = await attempt(path);
  writeFileSync(RESULTS, JSON.stringify(results));
  busy = false;
}, 100).unref();

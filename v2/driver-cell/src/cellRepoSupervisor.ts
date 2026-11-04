import { executeCellRepoBatch } from "./cellRepoExecutor.ts";
import { CELL_REPO_REQUEST_BYTES, CellRepoRefusal } from "./cellRepoProtocol.ts";

let input = "";
let started = false;
const abort = new AbortController();
let deadline = setTimeout(() => process.exit(2), 120_000);
const stop = () => { abort.abort(); process.exit(2); };
process.stdin.setEncoding("utf8");
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.on("data", (chunk: string) => {
  if (started) { stop(); return; }
  input += chunk;
  if (Buffer.byteLength(input) > CELL_REPO_REQUEST_BYTES) { stop(); return; }
  const end = input.indexOf("\n");
  if (end < 0) return;
  started = true;
  try {
    if (input.slice(end + 1).length !== 0) { stop(); return; }
    const data = JSON.parse(input.slice(0, end));
    if (!Number.isSafeInteger(data.timeoutMs) || data.timeoutMs <= 0 || data.timeoutMs > 120_000) { stop(); return; }
    clearTimeout(deadline);
    deadline = setTimeout(() => process.exit(2), data.timeoutMs + 1000);
    void executeCellRepoBatch(data, abort.signal, identity => process.stdout.write(JSON.stringify({ started: identity }) + "\n")).then(
      result => ({ result }),
      error => ({ failure: error instanceof CellRepoRefusal ? error.code : "invalid_repository" }),
    ).then(message => {
      clearTimeout(deadline);
      process.stdout.write(JSON.stringify(message), () => process.exit(0));
    });
  } catch { stop(); }
});

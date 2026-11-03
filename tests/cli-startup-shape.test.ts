import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const entry = join(root, "dist", "cli.js");
const built = existsSync(entry) && existsSync(join(root, "dist", "v2", "cli.js"));

async function tracedRun(args: string[], dir: string): Promise<{ stdout: string; loaded: string[] }> {
  const trace = join(dir, `trace-${args[0]}.txt`);
  const env = { ...process.env, HIVE_MODULE_TRACE: trace, HIVE_STORE_ROOT: join(dir, "store"), HOME: join(dir, "home") };
  delete env.HIVE_V2_DATA_DIR;
  delete env.HIVE_V2_SOCKET_PATH;
  const { stdout } = await execFileAsync(process.execPath, ["--import", join(root, "tests", "fixtures", "module-trace.mjs"), entry, "v2", ...args], { cwd: dir, env });
  const loaded = readFileSync(trace, "utf8").split("\n").filter(url => url.startsWith("file://")).map(url => fileURLToPath(url)).filter(path => path.startsWith(join(root, "dist")));
  return { stdout, loaded };
}

function assertReadPathOnly(loaded: string[]): void {
  const heavy = loaded.filter(path => /node:sqlite|^(?:var|let|const) SCHEMA_VERSION\d* = \d+;$/m.test(readFileSync(path, "utf8")));
  assert.deepEqual(heavy, [], "store and daemon code must stay out of the read-command startup path");
}

test("hive --version answers from the bootstrap without loading the v2 bundle", { skip: !built && "run npm run build first" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-cli-shape-"));
  try {
    const { stdout, loaded } = await tracedRun(["--version"], dir);
    const identity = JSON.parse(readFileSync(join(root, "dist", "build-identity.json"), "utf8"));
    assert.equal(stdout, `honeybee ${identity.version}\n`);
    assert.deepEqual(loaded.filter(path => path.includes(join("dist", "v2"))), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hive help and a read RPC load only the thin command graph", { skip: !built && "run npm run build first" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-cli-shape-"));
  const socketPath = join(dir, "hived.sock");
  let server: Server | null = null;
  try {
    const help = await tracedRun(["help"], dir);
    assert.match(help.stdout, /durable AI agent sessions/);
    assertReadPathOnly(help.loaded);

    server = createServer(socket => {
      socket.setEncoding("utf8");
      socket.write(`${JSON.stringify({ protocol: "v2/2", instance: { id: "shape-test", dataDir: dir } })}\n`);
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index < 0) return;
          const frame = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
          if (frame.verb === "list") socket.write(`${JSON.stringify({ id: frame.id, ok: true, result: { views: [] } })}\n`);
        }
      });
    });
    await new Promise<void>(resolve => server!.listen(socketPath, resolve));
    const list = await tracedRun(["ls", "--json", "--data-dir", dir], dir);
    assert.deepEqual(JSON.parse(list.stdout).views, []);
    assertReadPathOnly(list.loaded);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

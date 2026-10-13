import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";

const FAKE_TOKEN = "fake-apiary-token-h18-0123456789";
const FAKE_PASSWORD = "fake-password-h18";

function capture(): { io: CliIo; text: () => string } {
  const lines: string[] = [];
  return { io: { out: (l) => lines.push(stripAnsi(l)), err: (l) => lines.push(stripAnsi(l)) }, text: () => lines.join("\n") };
}

async function cli(argv: string[]): Promise<string> {
  const c = capture();
  assert.equal(await runV2Cli(argv, c.io), 0, `${argv.join(" ")}: ${c.text()}`);
  return c.text();
}

function assertRedacted(output: string, label: string): void {
  assert.doesNotMatch(output, new RegExp(FAKE_TOKEN), `${label} leaks APIARY_AGENT_TOKEN`);
  assert.doesNotMatch(output, new RegExp(FAKE_PASSWORD), `${label} leaks DB_PASSWORD`);
}

test("env.redact: view, list, events and bee-row results never print APIARY_AGENT_TOKEN; --reveal-env does", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const { beeId } = await client.request<{ beeId: string }>("spawn", {
      name: "redact",
      agent: "stub",
      cwd: "/tmp",
      env: { APIARY_AGENT_TOKEN: FAKE_TOKEN, DB_PASSWORD: FAKE_PASSWORD, PLAIN_SETTING: "visible" },
    });
    await waitFor(async () => (await client.request<{ view: { runtimeState: string } }>("view", { beeId })).view.runtimeState === "idle", "stub idle");

    const rpcView = await client.request<{ bee: { env: Record<string, string> } }>("view", { beeId });
    assert.deepEqual(rpcView.bee.env, { APIARY_AGENT_TOKEN: "<redacted>", DB_PASSWORD: "<redacted>", PLAIN_SETTING: "visible" });
    assertRedacted(JSON.stringify(await client.request("list", {})), "rpc list");
    assertRedacted(JSON.stringify(await client.request("audit.tail", { limit: 1000 })), "rpc audit.tail");
    const revealedView = await client.request<{ bee: { env: Record<string, string> } }>("view", { beeId, revealEnv: true });
    assert.equal(revealedView.bee.env.APIARY_AGENT_TOKEN, FAKE_TOKEN);

    const viewJson = await cli(["view", beeId, "--data-dir", dir, "--json"]);
    assertRedacted(viewJson, "view --json");
    assert.equal(JSON.parse(viewJson).bee.env.APIARY_AGENT_TOKEN, "<redacted>");
    assertRedacted(await cli(["view", beeId, "--data-dir", dir]), "view");
    assertRedacted(await cli(["list", "--all", "--data-dir", dir, "--json"]), "list --json");
    assertRedacted(await cli(["events", "--bee", beeId, "--tail", "1000", "--data-dir", dir, "--json"]), "events --json");
    assertRedacted(await cli(["events", "--bee", beeId, "--tail", "1000", "--data-dir", dir]), "events");
    assertRedacted(await cli(["rename", beeId, "redact-2", "--data-dir", dir, "--json"]), "rename --json");
    assertRedacted(await cli(["tag", beeId, "--add", "h18", "--data-dir", dir, "--json"]), "tag --json");
    assertRedacted(await cli(["bee", "set-args", beeId, "--data-dir", dir, "--json", "--", "--x"]), "bee set-args --json");

    const revealed = JSON.parse(await cli(["view", beeId, "--data-dir", dir, "--json", "--reveal-env"]));
    assert.deepEqual(revealed.bee.env, { APIARY_AGENT_TOKEN: FAKE_TOKEN, DB_PASSWORD: FAKE_PASSWORD, PLAIN_SETTING: "visible" });
    assert.match(await cli(["list", "--all", "--data-dir", dir, "--json", "--reveal-env"]), new RegExp(FAKE_TOKEN));
    assert.match(await cli(["events", "--bee", beeId, "--tail", "1000", "--data-dir", dir, "--json", "--reveal-env"]), new RegExp(FAKE_TOKEN));
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});

test("env.redact: the read-only fallback redacts too, and --reveal-env reveals", async () => {
  const { dir, cleanup } = makeDaemonDir();
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createBee({ id: "bee-r", name: "offline", agent: "stub", substrate: "hsr", cwd: "/tmp", env: { APIARY_AGENT_TOKEN: FAKE_TOKEN, HOME: "/home/bee" } });
    store.close();

    const view = await cli(["view", "offline", "--data-dir", dir, "--json"]);
    assertRedacted(view, "stale view --json");
    const parsed = JSON.parse(view);
    assert.equal(parsed.stale, true);
    assert.deepEqual(parsed.bee.env, { APIARY_AGENT_TOKEN: "<redacted>", HOME: "/home/bee" });
    assertRedacted(await cli(["list", "--all", "--data-dir", dir, "--json"]), "stale list --json");
    assertRedacted(await cli(["events", "--data-dir", dir, "--json"]), "stale events --json");
    assert.equal(JSON.parse(await cli(["view", "offline", "--data-dir", dir, "--json", "--reveal-env"])).bee.env.APIARY_AGENT_TOKEN, FAKE_TOKEN);
  } finally {
    cleanup();
  }
});

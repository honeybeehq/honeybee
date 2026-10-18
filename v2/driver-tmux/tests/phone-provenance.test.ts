import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TmuxDriver } from "../src/driver.ts";
import { TmuxServer } from "../src/tmux.ts";

const fixture = fileURLToPath(new URL("../test-agent/phone-terminal.mjs", import.meta.url));
const corpus = JSON.parse(readFileSync(new URL("../../core/tests/fixtures/phone-origin-vectors.json", import.meta.url), "utf8")) as { vectors: { id: string; expectedFrame: string }[] };
for (const probeFixture of ["native", "supported", "unknown"] as const) for (const bracketed of [true, false]) test(`private tmux multiline transport (${probeFixture} probe): bracketed ${bracketed ? "ON" : "OFF"}; only proven ON pastes inline`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pht-"));
  const socketPath = join(dir, "t.sock"), receiptFile = join(dir, "received.jsonl");
  const body = corpus.vectors.find(v => v.id === "nested-encoded-frame")!.expectedFrame;
  const server = new TmuxServer({ socketPath, allowKillServer: true });
  const driver = new TmuxDriver({ socketPath, eventsDir: join(dir, "events"), allowKillServer: true, stopKillGraceMs: 100,
    resolve: () => ({ command: process.execPath, args: [fixture, "off"], cwd: dir, env: { ...process.env, PHONE_PROVIDER_RECEIPT: receiptFile }, deliveryMode: "paste", observation: { paneFallback: true, quiesceMs: 50, deliveryGraceMs: 1000 } }) });
  const rows = (): { ready?: boolean; submittedBody?: string; transportHex?: string; bracketedEnabled?: boolean }[] => {
    try { return readFileSync(receiptFile, "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; }
  };
  const wait = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail("private terminal accept point timed out");
  };
  let pane = "", flag = "", tmuxVersion = "";
  let formatSupported = false;
  const flagTransitions: string[] = [];
  const originalTry = TmuxServer.prototype.try;
  let fixtureFlag = "0";
  if (probeFixture !== "native") TmuxServer.prototype.try = function(args, options) {
    const format = args.at(-1);
    if (args[0] === "display-message" && (format === "#{bracket_paste_flag}" || format === "#{version}|#{pane_id}|#{bracket_paste_flag}")) {
      if (probeFixture === "unknown") return { status: 1, stdout: "", stderr: "fixture query unavailable" };
      if (rows().some(row => row.bracketedEnabled)) fixtureFlag = "1";
      const state = fixtureFlag;
      return { status: 0, stdout: format === "#{bracket_paste_flag}" ? state : `fixture-version|${args[3]}|${state}`, stderr: "" };
    }
    return originalTry.call(this, args, options);
  };
  try {
    tmuxVersion = server.run(["-V"]).trim();
    driver.start("phone-terminal", 1);
    await wait(() => {
      pane = server.try(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim();
      flag = pane ? server.try(["display-message", "-p", "-t", pane, "#{bracket_paste_flag}"]).stdout.trim() : "";
      return rows().some(row => row.ready) && pane.startsWith("%");
    });
    formatSupported = flag === "0";
    assert.ok(formatSupported || flag === "", "format must be explicitly off or unavailable");
    flagTransitions.push(flag);
    if (bracketed) {
      server.run(["send-keys", "-t", pane, "C-b"]);
      await wait(() => {
        flag = server.try(["display-message", "-p", "-t", pane, "#{bracket_paste_flag}"]).stdout.trim();
        return rows().some(row => row.bracketedEnabled) && (!formatSupported || flag === "1");
      });
      flagTransitions.push(flag);
    }
    t.diagnostic(`${tmuxVersion}, ${probeFixture} probe: bracket_paste_flag=${flagTransitions.join("→")}`);
    const capture = async (count: number) => {
      await wait(() => rows().filter(row => row.submittedBody !== undefined).length >= count);
      const received = rows().filter(row => row.submittedBody !== undefined);
      assert.equal(received.length, count);
      const transport = Buffer.from(rows().map(row => row.transportHex ?? "").join(""), "hex");
      return { received, transport };
    };
    writeFileSync(receiptFile, "");
    driver.observe();
    const result = driver.deliver("phone-terminal", 1, 1, body);
    if (!formatSupported || !bracketed) {
      const detail = probeFixture === "unknown" ? "multiline_bracketed_paste_unknown" : formatSupported ? "multiline_bracketed_paste_disabled" : "multiline_bracketed_paste_version_unsupported";
      assert.deepEqual(result, { accepted: false, reason: "not_ready", detail });
      assert.equal(rows().length, 0);
      assert.deepEqual(driver.deliver("phone-terminal", 1, 1, body, { multilineWaitExpired: true }), result);
      assert.equal(rows().length, 0);
    } else {
      assert.equal(result.accepted, true);
      const actual = await capture(1);
      assert.deepEqual(Buffer.from(actual.received[0]!.submittedBody!), Buffer.from(body));
      assert.ok(actual.transport.includes(Buffer.from(body)));
      assert.equal(actual.transport.includes(Buffer.from("\x1b[200~")), true);
    }

  } finally {
    if (process.env.PHONE_EVIDENCE_DIR) {
      try { writeFileSync(join(process.env.PHONE_EVIDENCE_DIR, `adapter-tmux-${probeFixture}-${bracketed ? "on" : "off"}.json`), JSON.stringify({ probeFixture, tmuxVersion, format: "bracket_paste_flag", flagTransitions, bracketed, flag, formatSupported, inlineSupported: bracketed && formatSupported, expectedFrame: body, providerReceiptJsonl: readFileSync(receiptFile, "utf8") }, null, 2)); } catch {}
    }
    TmuxServer.prototype.try = originalTry;
    driver.disposeAll(); server.killServer(); rmSync(dir, { recursive: true, force: true });
  }
});

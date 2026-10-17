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
for (const bracketed of [true, false]) test(`private tmux multiline transport: bracketed paste ${bracketed ? "ON is one exact input" : "OFF is refused; raw transport splits"}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pht-"));
  const socketPath = join(dir, "t.sock"), receiptFile = join(dir, "received.jsonl");
  const body = corpus.vectors.find(v => v.id === "nested-encoded-frame")!.expectedFrame;
  const server = new TmuxServer({ socketPath, allowKillServer: true });
  const driver = new TmuxDriver({ socketPath, eventsDir: join(dir, "events"), allowKillServer: true, stopKillGraceMs: 100,
    resolve: () => ({ command: process.execPath, args: [fixture, "off"], cwd: dir, env: { ...process.env, PHONE_PROVIDER_RECEIPT: receiptFile }, deliveryMode: "paste", observation: { paneFallback: true, quiesceMs: 50, deliveryGraceMs: 1000 } }) });
  const rows = (): { ready?: boolean; submittedBody?: string; transportHex?: string }[] => {
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
  const flagTransitions: string[] = [];
  try {
    driver.start("phone-terminal", 1);
    await wait(() => {
      pane = server.try(["list-panes", "-a", "-F", "#{pane_id}"]).stdout.trim();
      flag = pane ? server.try(["display-message", "-p", "-t", pane, "#{bracketed_paste_flag}"]).stdout.trim() : "";
      return rows().some(row => row.ready) && flag === "0";
    });
    flagTransitions.push(flag);
    tmuxVersion = server.run(["-V"]).trim();
    if (bracketed) {
      server.run(["send-keys", "-t", pane, "C-b"]);
      await wait(() => {
        flag = server.try(["display-message", "-p", "-t", pane, "#{bracketed_paste_flag}"]).stdout.trim();
        return flag === "1";
      });
      flagTransitions.push(flag);
    }
    t.diagnostic(`${tmuxVersion}: bracketed_paste_flag=${flagTransitions.join("→")}`);
    driver.observe();
    const result = driver.deliver("phone-terminal", 1, 1, body);
    if (bracketed) assert.equal(result.accepted, true);
    else {
      assert.deepEqual(result, { accepted: false, reason: "not_ready", detail: "multiline_bracketed_paste_disabled" });
      assert.equal(rows().filter(row => row.submittedBody !== undefined || row.transportHex !== undefined).length, 0);
      server.run(["load-buffer", "-b", "raw-off-evidence", "-"], { input: body });
      server.run(["paste-buffer", "-p", "-r", "-d", "-b", "raw-off-evidence", "-t", pane]);
      server.run(["send-keys", "-t", pane, "Enter"]);
    }
    const expectedSubmissions = bracketed ? 1 : body.split("\n").length;
    await wait(() => rows().filter(row => row.submittedBody !== undefined).length >= expectedSubmissions);
    const received = rows().filter(row => row.submittedBody !== undefined);
    assert.equal(received.length, expectedSubmissions);
    assert.deepEqual(Buffer.from(received.map(row => row.submittedBody!).join("\n")), Buffer.from(body));
    const transport = Buffer.from(rows().map(row => row.transportHex ?? "").join(""), "hex");
    assert.ok(transport.includes(Buffer.from(body)), "literal LF bytes survive transport");
    assert.equal(transport.includes(Buffer.from("\x1b[200~")), bracketed);
  } finally {
    if (process.env.PHONE_EVIDENCE_DIR) {
      try { writeFileSync(join(process.env.PHONE_EVIDENCE_DIR, `adapter-tmux-${bracketed ? "on" : "off"}.json`), JSON.stringify({ tmuxVersion, format: "bracketed_paste_flag", flagTransitions, bracketed, flag, supported: bracketed, expectedFrame: body, providerReceiptJsonl: readFileSync(receiptFile, "utf8") }, null, 2)); } catch {}
    }
    driver.disposeAll(); server.killServer(); rmSync(dir, { recursive: true, force: true });
  }
});

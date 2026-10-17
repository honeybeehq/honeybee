import { before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stubAdapter } from "../../adapters/src/index.ts";
import { HsrDriver } from "../../driver-hsr/src/driver.ts";
import { sandboxDefaultFor, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { DeliveryFiles } from "../src/deliveryFile.ts";
import { ensureDeliveryFileArtifact } from "./delivery-file-build.ts";

before(ensureDeliveryFileArtifact);
for (const substrate of ["hsr", "cell-sandbox", "satellite-default"] as const) test(`OS-level file read outside cwd: ${substrate}; tool-policy read UNVERIFIED (OS-level only)`, {skip: process.platform !== "linux"}, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fr-"))), data = join(root, "data"), work = join(root, "work");
  mkdirSync(data, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
  mkdirSync(join(root, "s"), {mode: 0o700});
  const id = randomUUID(), content = `Honeybee delivery content: publication=${id}\n\nnonce-${randomUUID()}`;
  const row = new DeliveryFiles(undefined, root).publish(data, "owner", "bee", id, content, [work]);
  const fixture = fileURLToPath(new URL("./fixtures/delivery-file-reader.mjs", import.meta.url));
  const sandboxed = substrate !== "hsr";
  if (substrate === "satellite-default") assert.equal(sandboxDefaultFor("satellite"), true);
  const command = sandboxed ? wrapWithSandbox({cellDir: work, writablePaths: [], scratchPaths: []}, process.execPath, [fixture], join(work, "sandbox.sb")) : {command: process.execPath, args: [fixture]};
  const driver = new HsrDriver({sessionLogDir: join(root, "logs"), stopKillGraceMs: 100, socketDir: join(root, "s"), resolve: () => ({...command, cwd: work, env: {...process.env, FILE_READ_ROOT: data, ...(sandboxed ? {FILE_EXPECT_READONLY: "1"} : {})}, adapter: stubAdapter})});
  t.after(() => {driver.disposeAll(); rmSync(root, {recursive: true, force: true});});
  driver.start("bee", 1);
  let accepted = false, ended = false;
  const observed: unknown[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const events = driver.observe();
    observed.push(...events);
    if (accepted) ended ||= readFileSync(driver.sessionLogPath("bee"), "utf8").trim().split("\n").some(line => {const value = JSON.parse(line); return value.event === "turn_ended" && value.messageId === 1;});
    if (!accepted && events.some(event => event.kind === "booted") || !accepted && driver.hasProcess("bee", 1)) accepted = driver.deliver("bee", 1, 1, `full text: ${row.path}`, {singleAttempt: true}).accepted;
    if (accepted && ended) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(accepted, true, JSON.stringify(observed)); assert.equal(ended, true, readFileSync(driver.sessionLogPath("bee"), "utf8"));
  assert.equal(driver.deliveryReceipt("bee", 1, 1, `full text: ${row.path}`), "accepted");
  assert.equal(driver.deliveryReceipt("bee", 1, 1, "another body"), "unknown");
  assert.equal(driver.deliveryReceipt("another-bee", 1, 1, `full text: ${row.path}`), "unknown");
  assert.equal(driver.deliveryReceipt("bee", 2, 1, `full text: ${row.path}`), "unknown");
  const replies = readFileSync(driver.sessionLogPath("bee"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const reply = JSON.parse(replies.find(value => value.event === "text").text);
  assert.deepEqual(reply, {sha256: row.digest, header: content.split("\n")[0], cwd: work, writeDenied: sandboxed ? true : null});
  assert.equal(readFileSync(row.path, "utf8"), content);
});

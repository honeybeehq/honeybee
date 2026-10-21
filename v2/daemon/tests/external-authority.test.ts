import { verifyManagementChallenge, localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadNodeConfig } from "../src/config.ts";
import { externalOwner, privateManagementFile } from "../src/externalAuthority.ts";

test("external authority refuses Cell configuration, permissive files and symbolic links", () => {
  const base = join(process.cwd(), ".local", "external-exec-tests"); mkdirSync(base, {recursive: true, mode: 0o700});
  const root = mkdtempSync(join(tmpdir(), "hb-external-authority-")), file = join(root, "owner.json");
  writeFileSync(file, "private", {mode: 0o600});
  assert.equal(privateManagementFile(file, root).toString(), "private");
  assert.throws(() => externalOwner(join(base, "owner.json"), join(process.cwd(), "cells")), /outside_cell/);
  chmodSync(file, 0o644);
  assert.throws(() => privateManagementFile(file, root), /unprotected/);
  chmodSync(file, 0o600); symlinkSync(file, join(root, "alias"));
  assert.throws(() => privateManagementFile(join(root, "alias"), root), /invalid/);
  chmodSync(root, 0o755);
  assert.throws(() => privateManagementFile(file, root), /unprotected/);
});

test("management signer refuses relayed process, daemon and workspace challenges", () => {
  const expected = {uid: 1001, pid: 234, processBirth: "linux:9988", daemonInstanceId: "daemon-a", workspace: "ur"};
  const challenge: LocalTrustChallenge = {...expected, challengeId: "12345678-1234-1234-1234-123456789012", nonce: "n".repeat(43), expiresAtMs: 10000};
  assert.doesNotThrow(() => verifyManagementChallenge(challenge, expected, 1000));
  for (const wrong of [{uid: 1002}, {pid: 999}, {processBirth: "linux:9989"}, {daemonInstanceId: "fake"}, {workspace: "other"}, {expiresAtMs: 1000}, {expiresAtMs: 61001}]) assert.throws(() => verifyManagementChallenge({...challenge, ...wrong}, expected, 1000));
  assert.notEqual(localTrustMessage(challenge), localTrustMessage({...challenge, workspace: "other"}));
});

test("only a protected external owner file can supply workspace grants", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-external-owner-")), ownerFile = join(root, "owner.json");
  const externalExec = {bridges: {}, workspaces: {ur: {capabilities: ["external-exec.v1"], bridges: []}}};
  writeFileSync(ownerFile, JSON.stringify({schema: "honeybee.external-owner.v1", externalExec}), {mode: 0o600});
  writeFileSync(join(root, "management.key"), Buffer.alloc(32, 7), {mode: 0o600});
  const loaded = externalOwner(ownerFile, join(root, "cells"));
  assert.deepEqual(loaded.externalExec, externalExec);
  assert.equal(loaded.externalManagement?.socketPath, join(root, "hived.sock"));
  writeFileSync(join(root, "config.json"), JSON.stringify({externalOwnerFile: ownerFile}));
  assert.equal(loadNodeConfig(root).socketPath, join(root, "hived.sock"));
  writeFileSync(join(root, "config.json"), JSON.stringify({externalExec}));
  assert.throws(() => loadNodeConfig(root), /Inline externalExec is forbidden/);
  chmodSync(join(root, "management.key"), 0o644);
  assert.throws(() => externalOwner(ownerFile, join(root, "cells")), /unprotected/);
});

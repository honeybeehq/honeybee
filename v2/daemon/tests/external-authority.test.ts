import { resolveDaemonTarget } from "../../cli/src/target.ts";
import { verifyManagementChallenge, localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { tmpdir, homedir } from "node:os";
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
  const node = mkdtempSync(join(tmpdir(), "hb-external-node-"));
  const loaded = externalOwner(ownerFile, join(node, "cells"), node);
  assert.deepEqual(loaded.externalExec, externalExec);
  assert.equal(loaded.externalManagement?.socketPath, join(root, "hived.sock"));
  writeFileSync(join(node, "config.json"), JSON.stringify({externalOwnerFile: ownerFile}));
  assert.equal(loadNodeConfig(node, undefined, "management").externalManagement?.socketPath, join(root, "hived.sock"));
  assert.equal(loadNodeConfig(node).socketPath, join(node, "hived.sock"));
  assert.equal(loadNodeConfig(node).externalManagement, undefined);
  writeFileSync(join(node, "config.json"), JSON.stringify({externalExec}));
  assert.throws(() => loadNodeConfig(node), /Inline externalExec is forbidden/);
  chmodSync(join(root, "management.key"), 0o644);
  assert.throws(() => externalOwner(ownerFile, join(node, "cells"), node), /unprotected/);
});

test("public configuration never probes inaccessible management files", () => {
  const node = mkdtempSync(join(tmpdir(), "hb-public-config-"));
  writeFileSync(join(node, "config.json"), JSON.stringify({externalOwnerFile: "/no-management-access/owner.json"}));
  const cfg = resolveDaemonTarget({dataDirFlag: node}, {}).cfg;
  assert.equal(cfg.externalManagement, undefined);
  assert.equal(cfg.socketPath, join(node, "hived.sock"));
  assert.deepEqual(cfg.externalExec, {bridges: {}, workspaces: {}});
  assert.throws(() => loadNodeConfig(node, undefined, "daemon"));
  assert.throws(() => loadNodeConfig(node, undefined, "management"));
});

test("management authority refuses the hive v2 root and every ancestor", () => {
  const v2 = join(homedir(), ".hive", "v2");
  for (const root of [v2, join(homedir(), ".hive"), homedir(), "/"]) assert.throws(() => externalOwner(join(root, "owner.json"), join(v2, "cells")), /outside_cell/);
});

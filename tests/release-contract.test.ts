import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseComponentIdentity, parseCompatibilityRecord, parseDependencyLock, parseReleaseManifest, parseRecoveryPlan, compatibilitySubjectDigest } from "../src/release/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../contracts/release/v1/fixtures/${name}.json`, import.meta.url), "utf8"));

test("exact identity accepts an artifact and rejects legacy versions without hashes", () => {
  const identity = parseComponentIdentity(fixture("honeybee"));
  assert.equal(identity.version, "0.1.0");
  for (const patch of [{ version: "0.01.0" }, { sourceRevision: "c31d87b" }, { artifact: { url: "https://example.test/runtime.tgz" } }]) {
    assert.throws(() => parseComponentIdentity({ ...identity, ...patch }));
  }
});

test("compatibility evidence is bound to exact artifacts and both contract fingerprints", () => {
  const record = parseCompatibilityRecord(fixture("compatible"));
  assert.equal(record.state, "compatible");
  const changed = structuredClone(record);
  changed.subject.operations[0]!.consumer.fingerprint = `sha256:${"9".repeat(64)}`;
  assert.throws(() => parseCompatibilityRecord(changed), /subject digest/);
  const mismatched = structuredClone(record);
  mismatched.results[0]!.checks.output.evidence[0]!.subjectDigest = `sha256:${"9".repeat(64)}`;
  assert.throws(() => parseCompatibilityRecord(mismatched), /evidence/);
});

test("required uncertainty cannot claim compatibility, but optional failures do not veto", () => {
  const record = parseCompatibilityRecord(fixture("compatible"));
  record.results[0]!.checks.input.state = "unverified";
  record.results[0]!.checks.input.evidence = [];
  assert.throws(() => parseCompatibilityRecord(record), /state must agree/);
  record.state = "unverified";
  assert.equal(parseCompatibilityRecord(record).state, "unverified");
  assert.equal(parseCompatibilityRecord(fixture("optional-incompatible")).state, "compatible");
});

test("dependency locks distinguish exact pins from unverified legacy observations", () => {
  const lock = parseDependencyLock(fixture("dependency-lock"));
  assert.equal(lock.status, "locked");
  const legacy = parseDependencyLock(fixture("legacy-lock"));
  assert.equal(legacy.status, "unverified");
  assert.throws(() => parseDependencyLock({ ...legacy, status: "locked" }));
});

test("a release manifest requires compatible pinned and explicitly supported combinations", () => {
  const manifest = parseReleaseManifest(fixture("release-manifest"));
  assert.equal(manifest.schemaVersion, 1);
  const historical = manifest.compatibility.entries.find((entry) => entry.state === "incompatible")!;
  assert.ok(historical);
  manifest.supported.push(historical.subjectDigest);
  assert.throws(() => parseReleaseManifest(manifest), /supported.*compatible/);
});

test("evidence for another operation or check cannot satisfy a required result", () => {
  const record = parseCompatibilityRecord(fixture("compatible"));
  record.results[0]!.checks.output.evidence = record.results[0]!.checks.input.evidence;
  assert.throws(() => parseCompatibilityRecord(record), /evidence/);
});

test("published fixtures preserve compatible, incompatible, unverified and recovery states", () => {
  assert.equal(parseCompatibilityRecord(fixture("incompatible")).state, "incompatible");
  assert.equal(parseCompatibilityRecord(fixture("unverified")).state, "unverified");
  assert.equal(parseRecoveryPlan(fixture("recovery-plan")).state, "compatible");
  assert.throws(() => parseComponentIdentity(fixture("invalid-identity")));
  assert.throws(() => parseComponentIdentity(fixture("invalid-artifact-url")));
  assert.throws(() => parseRecoveryPlan(fixture("invalid-storage-evidence")), /evidence/);
  assert.throws(() => parseCompatibilityRecord(fixture("invalid-evidence")), /evidence/);
  assert.throws(() => parseRecoveryPlan(fixture("invalid-recovery")), /storage/);
});

test("artifact, provider, evaluator, model, prompt and policy changes invalidate prior evidence", () => {
  const original = parseCompatibilityRecord(fixture("compatible"));
  const changes: ((record: typeof original) => void)[] = [
    (r) => { r.subject.combination.honeybee.artifact.sha256 = `sha256:${"e".repeat(64)}`; },
    (r) => { r.subject.combination.apiaryd.sourceRevision = "d".repeat(40); },
    (r) => { r.subject.operations[0]!.provider.fingerprint = `sha256:${"e".repeat(64)}`; },
    (r) => { r.subject.evaluation.evaluatorRevision = "e".repeat(40); },
    (r) => { r.subject.evaluation.modelRevision = "different-model"; },
    (r) => { r.subject.evaluation.promptSha256 = `sha256:${"e".repeat(64)}`; },
    (r) => { r.subject.evaluation.policySha256 = `sha256:${"e".repeat(64)}`; },
  ];
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.throws(() => parseCompatibilityRecord(changed), /subject digest/);
  }
});

test("missing, duplicate, unknown, or unevidenced required checks cannot pass", () => {
  const original = parseCompatibilityRecord(fixture("compatible"));
  const changes: ((record: typeof original) => void)[] = [
    (r) => { r.results = []; },
    (r) => { r.results.push(structuredClone(r.results[0]!)); },
    (r) => { r.results[0]!.operationId = "unknown-operation"; },
    (r) => { r.results[0]!.checks.command.evidence = []; },
    (r) => { r.results[0]!.checks.output.state = "incompatible"; },
  ];
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.throws(() => parseCompatibilityRecord(changed));
  }
});

test("unknown contract versions, extra fields and component substitutions fail closed", () => {
  const record = parseCompatibilityRecord(fixture("compatible"));
  assert.throws(() => parseCompatibilityRecord({ ...record, schemaVersion: 2 }));
  assert.throws(() => parseCompatibilityRecord({ ...record, override: true }));
  const manifest = parseReleaseManifest(fixture("release-manifest"));
  assert.throws(() => parseReleaseManifest({ ...manifest, components: { ...manifest.components, apiary: manifest.components.apiaryd } }));
});

test("current-major eligibility does not declare support and zero-major includes all minors", () => {
  const manifest = parseReleaseManifest(fixture("release-manifest"));
  assert.deepEqual(manifest.supported, []);
  assert.equal(manifest.compatibility.entries.length, 2);
  manifest.compatibility.currentMajors.honeybee = 1;
  assert.throws(() => parseReleaseManifest(manifest), /outside current major/);
});

test("locks, pinned identities, required protocols and recovery targets cannot drift", () => {
  const original = parseReleaseManifest(fixture("release-manifest"));
  const changes: ((manifest: typeof original) => void)[] = [
    (m) => { m.dependencyLock.honeybee.artifact.sha256 = `sha256:${"e".repeat(64)}`; },
    (m) => { m.components.apiary.artifact.sha256 = `sha256:${"e".repeat(64)}`; },
    (m) => { m.dependencyLock.requiredProtocols[0]!.capabilities.push("missing-capability"); },
    (m) => { m.pinned = m.compatibility.entries[1]!.subjectDigest; },
  ];
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.throws(() => parseReleaseManifest(changed));
  }
  const recovery = parseRecoveryPlan(fixture("recovery-plan"));
  original.recovery.push(recovery);
  assert.equal(parseReleaseManifest(original).recovery.length, 1);
  recovery.subject.to.honeybee.artifact.sha256 = `sha256:${"f".repeat(64)}`;
  assert.throws(() => parseReleaseManifest(original), /recovery subject digest/);
});

test("canonical subject digests ignore object key order and parsers return independent values", () => {
  const record = parseCompatibilityRecord(fixture("compatible"));
  const subject = record.subject;
  record.subject = { evaluation: subject.evaluation, operations: subject.operations, combination: subject.combination };
  const parsed = parseCompatibilityRecord(record);
  assert.equal(parsed.subjectDigest, record.subjectDigest);
  parsed.subject.operations[0]!.required = false;
  assert.equal(record.subject.operations[0]!.required, true);
});

test("artifact references reject malformed HTTPS authorities", () => {
  const identity = parseComponentIdentity(fixture("honeybee"));
  for (const url of ["https://:/artifact.tgz", "https://[invalid]/artifact.tgz", "https://example.test:999999/artifact.tgz"]) {
    assert.throws(() => parseComponentIdentity({ ...identity, artifact: { ...identity.artifact, url } }), url);
  }
});

test("a decisive storage claim requires evidence even while recovery remains unverified", () => {
  const plan = parseRecoveryPlan(fixture("recovery-plan"));
  plan.state = "unverified";
  plan.evidence = [];
  assert.throws(() => parseRecoveryPlan(plan), /evidence/);
});

test("a locked protocol can require capabilities provided by separate required operations", () => {
  const manifest = parseReleaseManifest(fixture("release-manifest"));
  const record = manifest.compatibility.entries[0]!;
  const operation = structuredClone(record.subject.operations[0]!);
  operation.id = "hive.bees.send";
  operation.protocol.capabilities = ["bees.send"];
  record.subject.operations.push(operation);
  const result = structuredClone(record.results[0]!);
  result.operationId = operation.id;
  record.results.push(result);
  record.subjectDigest = compatibilitySubjectDigest(record.subject);
  for (const entry of record.results) {
    for (const check of Object.values(entry.checks)) {
      for (const evidence of check.evidence) {
        evidence.subjectDigest = record.subjectDigest;
        evidence.operationId = entry.operationId;
      }
    }
  }
  manifest.pinned = record.subjectDigest;
  manifest.dependencyLock.requiredProtocols[0]!.capabilities.push("bees.send");
  assert.equal(parseReleaseManifest(manifest).pinned, record.subjectDigest);
});

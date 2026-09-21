import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseCompatibilityRecord, parseReleaseManifest, parseCompatibilityMatrix, parseRecoveryPlan, parseDependencyLock, parseComponentIdentity, compatibilitySubjectDigest, recoverySubjectDigest, type CompatibilityRecord } from "../src/release/v2.js";
import * as v1 from "../src/release/index.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../contracts/release/v2/fixtures/${name}.json`, import.meta.url), "utf8"));
const legacyFixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../contracts/release/v1/fixtures/${name}.json`, import.meta.url), "utf8"));

function rebind(record: CompatibilityRecord): void {
  record.subjectDigest = compatibilitySubjectDigest(record.subject);
  for (const result of record.results) for (const check of Object.values(result.checks)) {
    for (const evidence of check.evidence) evidence.subjectDigest = record.subjectDigest;
  }
}

test("standalone caller and provider bind distinct apiaryd builds and targets", () => {
  const record = parseCompatibilityRecord(fixture("standalone-compatible"));
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.state, "compatible");
  assert.equal(record.subject.combination.caller.component, "apiaryd");
  assert.equal(record.subject.combination.provider.component, "apiaryd");
  assert.equal(record.subject.combination.caller.target, "darwin-arm64");
  assert.equal(record.subject.combination.provider.target, "linux-x64");
  assert.notEqual(record.subject.combination.caller.artifact.sha256, record.subject.combination.provider.artifact.sha256);
  assert.deepEqual(record.subject.operations.map(op => [op.consumer.role, op.provider.role]), [["caller", "provider"], ["provider", "honeybee"]]);
});

test("portable conformance corpus rejects forged, ambiguous, stale and cross-edge evidence", () => {
  const parsers = { record: parseCompatibilityRecord, manifest: parseReleaseManifest, recoveryPlan: parseRecoveryPlan, dependencyLock: parseDependencyLock };
  const corpus = fixture("conformance") as { cases: { fixture: string; parser: keyof typeof parsers; valid: boolean }[] };
  for (const entry of corpus.cases) {
    const parse = () => parsers[entry.parser](fixture(entry.fixture.replace(/\.json$/, "")));
    if (entry.valid) assert.doesNotThrow(parse, entry.fixture);
    else assert.throws(parse, entry.fixture);
  }
});

test("both endpoints, targets, fingerprints and evaluator policy independently fence evidence", () => {
  const original = parseCompatibilityRecord(fixture("standalone-compatible"));
  const changes: ((record: CompatibilityRecord) => void)[] = [];
  for (const role of ["caller", "provider", "honeybee"] as const) {
    changes.push(r => { r.subject.combination[role].artifact.sha256 = `sha256:${"f".repeat(64)}`; });
    changes.push(r => { r.subject.combination[role].sourceRevision = "f".repeat(40); });
    changes.push(r => { r.subject.combination[role].target = "linux-arm64"; });
    changes.push(r => { r.subject.combination[role].version = "0.9.0"; });
  }
  for (const endpoint of ["consumer", "provider"] as const) {
    changes.push(r => { r.subject.operations[0]![endpoint].fingerprint = `sha256:${"f".repeat(64)}`; });
  }
  changes.push(r => { r.subject.evaluation.evaluatorRevision = "f".repeat(40); });
  changes.push(r => { r.subject.evaluation.modelRevision = "new-model"; });
  changes.push(r => { r.subject.evaluation.promptSha256 = `sha256:${"f".repeat(64)}`; });
  changes.push(r => { r.subject.evaluation.policySha256 = `sha256:${"f".repeat(64)}`; });
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.throws(() => parseCompatibilityRecord(changed), /subject digest/);
    changed.subjectDigest = compatibilitySubjectDigest(changed.subject);
    assert.throws(() => parseCompatibilityRecord(changed), /evidence/);
  }
});

test("desktop attachment cannot substitute a desktop component for a standalone caller", () => {
  const standalone = parseCompatibilityRecord(fixture("standalone-compatible"));
  const attached = { ...standalone, desktop: parseCompatibilityRecord(fixture("bundled-compatible")).subject.combination.caller };
  assert.throws(() => parseCompatibilityRecord(attached), /additional properties/);
  standalone.subject.operations[0]!.consumer.component = "apiary";
  rebind(standalone);
  assert.throws(() => parseCompatibilityRecord(standalone), /role\/component/);
  const bundled = parseCompatibilityRecord(fixture("bundled-compatible"));
  assert.equal(bundled.subject.operations[0]!.consumer.component, "apiary");
});

test("equal builds still have independent caller/provider roles and cannot share an endpoint slot", () => {
  const record = parseCompatibilityRecord(fixture("standalone-compatible"));
  record.subject.combination.caller = structuredClone(record.subject.combination.provider);
  rebind(record);
  assert.equal(parseCompatibilityRecord(record).state, "compatible");
  record.subject.operations[0]!.consumer.role = "provider";
  rebind(record);
  assert.throws(() => parseCompatibilityRecord(record), /roles must differ/);
});

test("required failures on either edge veto a pass; optional failures and uncertainty remain visible", () => {
  for (const operationId of ["node.bees.list", "hive.bees.list"]) {
    for (const name of ["command", "input", "output"] as const) {
      const record = parseCompatibilityRecord(fixture("standalone-compatible"));
      record.results.find(result => result.operationId === operationId)!.checks[name].state = "incompatible";
      assert.throws(() => parseCompatibilityRecord(record), /state must agree/);
      record.state = "incompatible";
      assert.equal(parseCompatibilityRecord(record).state, "incompatible");
    }
  }
  const optional = parseCompatibilityRecord(fixture("optional-incompatible"));
  assert.equal(optional.state, "compatible");
  assert.equal(optional.results[2]!.checks.command.state, "incompatible");
  assert.equal(parseCompatibilityRecord(fixture("unverified")).state, "unverified");
});

test("missing, duplicate, unknown and unevidenced results cannot authorize either edge", () => {
  const mutations: ((r: CompatibilityRecord) => void)[] = [
    r => { r.results.pop(); },
    r => { r.results[1] = structuredClone(r.results[0]!); },
    r => { r.results[0]!.operationId = "unknown"; },
    r => { r.results[0]!.checks.command.evidence = []; },
    r => { r.results[0]!.checks.input.evidence = r.results[0]!.checks.output.evidence; },
    r => { r.subject.operations[1]!.id = r.subject.operations[0]!.id; rebind(r); },
    r => { for (const op of r.subject.operations) op.required = false; rebind(r); },
  ];
  for (const mutate of mutations) {
    const record = parseCompatibilityRecord(fixture("standalone-compatible"));
    mutate(record);
    assert.throws(() => parseCompatibilityRecord(record));
  }
});

test("both caller and provider must be within their component's current major", () => {
  for (const role of ["caller", "provider"] as const) {
    const matrix = parseReleaseManifest(fixture("standalone-manifest")).compatibility;
    matrix.entries[0]!.subject.combination[role].version = "1.0.0";
    rebind(matrix.entries[0]!);
    assert.throws(() => parseCompatibilityMatrix(matrix), /outside current major: apiaryd/);
  }
});

test("v1 remains readable separately; unsupported readers refuse rather than relabel", () => {
  assert.equal(v1.parseReleaseManifest(legacyFixture("release-manifest")).schemaVersion, 1);
  const pairs = [
    [v1.parseCompatibilityRecord, parseCompatibilityRecord, "compatible", "standalone-compatible"],
    [v1.parseReleaseManifest, parseReleaseManifest, "release-manifest", "standalone-manifest"],
    [v1.parseDependencyLock, parseDependencyLock, "dependency-lock", "dependency-lock"],
    [v1.parseRecoveryPlan, parseRecoveryPlan, "recovery-plan", "remote-recovery"],
  ] as const;
  for (const [oldReader, newReader, oldName, newName] of pairs) {
    assert.throws(() => oldReader(fixture(newName)));
    assert.throws(() => newReader(legacyFixture(oldName)));
  }
  const record = parseCompatibilityRecord(fixture("standalone-compatible"));
  assert.throws(() => v1.parseCompatibilityRecord({ ...record, schemaVersion: 1 }));
  assert.throws(() => parseCompatibilityRecord({ ...record, schemaVersion: 3 }));
  const old = v1.parseCompatibilityRecord(legacyFixture("compatible"));
  old.subject.operations[0]!.provider.component = old.subject.operations[0]!.consumer.component;
  old.subjectDigest = v1.compatibilitySubjectDigest(old.subject);
  assert.throws(() => v1.parseCompatibilityRecord(old), /provider and consumer must differ/);
});

test("recovery binds exact role combinations and storage without treating remote caller as destination", () => {
  const manifest = parseReleaseManifest(fixture("standalone-manifest"));
  const plan = parseRecoveryPlan(fixture("remote-recovery"));
  assert.deepEqual(plan.subject.from.caller, plan.subject.to.caller);
  assert.equal(plan.subject.to.caller.target, "darwin-arm64");
  assert.equal(plan.subject.to.provider.target, "linux-x64");
  for (const role of ["caller", "provider", "honeybee"] as const) {
    const changed = structuredClone(plan);
    changed.subject.to[role].artifact.sha256 = `sha256:${"f".repeat(64)}`;
    assert.throws(() => parseRecoveryPlan(changed), /recovery subject digest/);
    changed.subjectDigest = recoverySubjectDigest(changed.subject);
    for (const evidence of changed.evidence) evidence.subjectDigest = changed.subjectDigest;
    assert.throws(() => parseReleaseManifest({ ...manifest, recovery: [changed] }), /recovery target/);
  }
  assert.throws(() => parseRecoveryPlan({ ...plan, storage: "unverified" }), /compatible storage/);
  assert.throws(() => parseRecoveryPlan({ ...plan, state: "unverified", evidence: [] }), /evidence/);
});

test("supported recovery targets require an exact explicit promise, beyond mere matrix evaluation", () => {
  const manifest = parseReleaseManifest(fixture("standalone-manifest"));
  const plan = manifest.recovery[0]!;
  plan.subject.to = structuredClone(manifest.compatibility.entries[3]!.subject.combination);
  plan.subjectDigest = recoverySubjectDigest(plan.subject);
  for (const evidence of plan.evidence) evidence.subjectDigest = plan.subjectDigest;
  assert.equal(parseReleaseManifest(manifest).recovery.length, 1);
  manifest.supported = [];
  assert.throws(() => parseReleaseManifest(manifest), /recovery target/);
});

test("manifest gates preserve exact locks, required Honeybee protocols and pinned artifacts", () => {
  const original = parseReleaseManifest(fixture("standalone-manifest"));
  const mutations: ((m: typeof original) => void)[] = [
    m => { m.components.caller.artifact.sha256 = `sha256:${"f".repeat(64)}`; },
    m => { m.dependencyLock.honeybee.target = "darwin-arm64"; },
    m => { m.dependencyLock.requiredProtocols[0]!.capabilities.push("missing"); },
    m => { m.pinned = m.compatibility.entries[1]!.subjectDigest; },
    m => { m.supported.push(`sha256:${"f".repeat(64)}`); },
  ];
  for (const mutate of mutations) {
    const manifest = structuredClone(original);
    mutate(manifest);
    assert.throws(() => parseReleaseManifest(manifest));
  }
});

test("identity syntax and canonical independent values remain consistent across versions", () => {
  const record = parseCompatibilityRecord(fixture("standalone-compatible"));
  const { subject } = record;
  record.subject = { evaluation: subject.evaluation, operations: subject.operations, combination: subject.combination };
  const parsed = parseCompatibilityRecord(record);
  parsed.subject.combination.caller.target = "other";
  assert.equal(record.subject.combination.caller.target, "darwin-arm64");
  assert.deepEqual(parseComponentIdentity(subject.combination.caller), v1.parseComponentIdentity(subject.combination.caller));
  for (const patch of [{ version: "0.01.0" }, { sourceRevision: "short" }, { artifact: { url: "https://:/invalid", sha256: `sha256:${"f".repeat(64)}` } }]) {
    assert.throws(() => parseComponentIdentity({ ...subject.combination.caller, ...patch }));
  }
});

test("exact support promises retain incompatible and unverified gaps within the current major", () => {
  const manifest = parseReleaseManifest(fixture("standalone-manifest"));
  assert.deepEqual(manifest.compatibility.entries.map(entry => entry.state), ["compatible", "incompatible", "unverified", "compatible"]);
  assert.deepEqual(manifest.compatibility.entries.map(entry => entry.subject.combination.provider.version), ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]);
  assert.deepEqual(manifest.supported, [manifest.compatibility.entries[3]!.subjectDigest]);
  for (const gap of manifest.compatibility.entries.slice(1, 3)) {
    const changed = structuredClone(manifest);
    changed.supported.push(gap.subjectDigest);
    assert.throws(() => parseReleaseManifest(changed), /supported.*compatible/);
  }
  const outside = structuredClone(manifest.compatibility);
  outside.currentMajors.apiaryd = 1;
  assert.throws(() => parseCompatibilityMatrix(outside), /outside current major/);
});

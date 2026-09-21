/** Versioned release metadata. Parsing establishes consistency, not authenticity. */
import { canonicalDigest } from "../comb/canonical.js";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

export type Component = "apiary" | "apiaryd" | "honeybee";
export type ArtifactReference = { url: string; sha256: string };
export type ComponentIdentity = {
  component: Component;
  version: string;
  sourceRevision: string;
  target: string;
  artifact: ArtifactReference;
};

const schema = JSON.parse(readFileSync(new URL("../../contracts/release/v1/schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function parse<T>(name: string, value: unknown): T {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Unknown release contract: ${name}`);
  if (!validate(value)) throw new Error(`Invalid ${name}: ${ajv.errorsText(validate.errors)}`);
  return structuredClone(value) as T;
}

export function parseComponentIdentity(value: unknown): ComponentIdentity {
  return parse("identity", value);
}

export type Combination = { [K in Component]: ComponentIdentity & { component: K } };
export type CompatibilityState = "compatible" | "incompatible" | "unverified";
export type ProtocolRequirement = { name: string; version: string; capabilities: string[] };
export type ContractFingerprint = { component: Component; fingerprint: string };
export type OperationRequirement = {
  id: string;
  required: boolean;
  provider: ContractFingerprint;
  consumer: ContractFingerprint;
  protocol: ProtocolRequirement;
};
export type EvaluationRevision = {
  evaluatorRevision: string;
  modelRevision: string;
  promptSha256: string;
  policySha256: string;
};
export type CompatibilitySubject = {
  combination: Combination;
  operations: OperationRequirement[];
  evaluation: EvaluationRevision;
};
export type Evidence = { subjectDigest: string; artifact: ArtifactReference };
export type OperationEvidence = Evidence & { operationId: string; check: "command" | "input" | "output" };
export type CompatibilityCheck = {
  state: CompatibilityState;
  method: "mechanical" | "jev";
  reason: string;
  evidence: OperationEvidence[];
};
export type CompatibilityRecord = {
  schemaVersion: 1;
  subject: CompatibilitySubject;
  subjectDigest: string;
  state: CompatibilityState;
  results: { operationId: string; checks: { command: CompatibilityCheck; input: CompatibilityCheck; output: CompatibilityCheck } }[];
};

function requireContract(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid release contract: ${message}`);
}

function unique(values: string[], subject: string): void {
  requireContract(new Set(values).size === values.length, `duplicate ${subject}`);
}

/** Hash canonical JSON (recursively sorted keys, ordered arrays, UTF-8). */
export function compatibilitySubjectDigest(subject: CompatibilitySubject): string {
  return canonicalDigest(subject);
}

export function parseCompatibilityRecord(value: unknown): CompatibilityRecord {
  const record = parse<CompatibilityRecord>("record", value);
  const { subject, results } = record;
  requireContract(record.subjectDigest === compatibilitySubjectDigest(subject), "subject digest mismatch");
  unique(subject.operations.map((op) => op.id), "operation requirement");
  unique(results.map((result) => result.operationId), "operation result");
  requireContract(subject.operations.some((op) => op.required), "at least one required operation is necessary");
  requireContract(results.length === subject.operations.length, "missing operation results");
  const requiredChecks: CompatibilityCheck[] = [];
  for (const operation of subject.operations) {
    requireContract(operation.provider.component !== operation.consumer.component, "provider and consumer must differ");
    const result = results.find((entry) => entry.operationId === operation.id);
    requireContract(result !== undefined, `missing operation result: ${operation.id}`);
    for (const [name, check] of Object.entries(result.checks)) {
      requireContract(check.state === "unverified" || check.evidence.length > 0, "decisive checks require evidence");
      for (const evidence of check.evidence) {
        requireContract(evidence.subjectDigest === record.subjectDigest
          && evidence.operationId === operation.id && evidence.check === name, "mismatched evidence subject/operation/check");
      }
      if (operation.required) requiredChecks.push(check);
    }
  }
  const state: CompatibilityState = requiredChecks.some((check) => check.state === "incompatible")
    ? "incompatible"
    : requiredChecks.every((check) => check.state === "compatible") ? "compatible" : "unverified";
  requireContract(record.state === state, "state must agree with every required command/input/output check");
  return record;
}

export type LockedDependency = {
  schemaVersion: 1;
  status: "locked";
  honeybee: ComponentIdentity & { component: "honeybee" };
  requiredProtocols: ProtocolRequirement[];
};
export type DependencyLock = LockedDependency | {
  schemaVersion: 1;
  status: "unverified";
  legacyPins: { source: string; revision: string }[];
  reason: string;
};
export type CompatibilityMatrix = {
  schemaVersion: 1;
  currentMajors: Record<Component, number>;
  entries: CompatibilityRecord[];
};
export type RecoverySubject = {
  from: Combination;
  to: Combination;
  strategy: "rollback" | "coordinated_migration";
  storageRequirements: string[];
  requiresInterruption: boolean;
};
export type RecoveryPlan = {
  subject: RecoverySubject;
  subjectDigest: string;
  state: CompatibilityState;
  storage: CompatibilityState;
  evidence: Evidence[];
};
export type ReleaseManifest = {
  schemaVersion: 1;
  releaseId: string;
  components: Combination;
  dependencyLock: LockedDependency;
  compatibility: CompatibilityMatrix;
  pinned: string;
  supported: string[];
  recovery: RecoveryPlan[];
};

export function parseDependencyLock(value: unknown): DependencyLock {
  return parse("dependencyLock", value);
}

export function parseCompatibilityMatrix(value: unknown): CompatibilityMatrix {
  const matrix = parse<CompatibilityMatrix>("matrix", value);
  unique(matrix.entries.map((entry) => entry.subjectDigest), "compatibility subject");
  for (const entry of matrix.entries) {
    parseCompatibilityRecord(entry);
    for (const component of ["apiary", "apiaryd", "honeybee"] as const) {
      const major = entry.subject.combination[component].version.split(".")[0]!;
      requireContract(BigInt(major) === BigInt(matrix.currentMajors[component]), `outside current major: ${component}`);
    }
  }
  return matrix;
}

export function recoverySubjectDigest(subject: RecoverySubject): string {
  return canonicalDigest(subject);
}

export function parseRecoveryPlan(value: unknown): RecoveryPlan {
  const plan = parse<RecoveryPlan>("recoveryPlan", value);
  requireContract(plan.subjectDigest === recoverySubjectDigest(plan.subject), "recovery subject digest mismatch");
  requireContract(plan.state !== "compatible" || plan.storage === "compatible", "recovery requires compatible storage");
  requireContract(plan.state === "unverified" || plan.evidence.length > 0, "decisive recovery requires evidence");
  for (const evidence of plan.evidence) {
    requireContract(evidence.subjectDigest === plan.subjectDigest, "mismatched recovery evidence");
  }
  return plan;
}

/** A publishable manifest must pass the pinned and explicitly supported gates. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const manifest = parse<ReleaseManifest>("manifest", value);
  parseCompatibilityMatrix(manifest.compatibility);
  requireContract(canonicalDigest(manifest.components.honeybee) === canonicalDigest(manifest.dependencyLock.honeybee), "dependency lock differs from pinned Honeybee");
  const pinned = manifest.compatibility.entries.find((entry) => entry.subjectDigest === manifest.pinned);
  requireContract(pinned !== undefined && pinned.state === "compatible", "pinned combination must be compatible");
  requireContract(canonicalDigest(pinned.subject.combination) === canonicalDigest(manifest.components), "pinned artifacts differ from release components");
  for (const protocol of manifest.dependencyLock.requiredProtocols) {
    requireContract(pinned.subject.operations.some((operation) => operation.required && operation.provider.component === "honeybee"
      && operation.protocol.name === protocol.name && operation.protocol.version === protocol.version
      && protocol.capabilities.every((capability) => operation.protocol.capabilities.includes(capability))), "locked protocol/capabilities missing from required evaluation");
  }
  for (const supported of manifest.supported) {
    requireContract(manifest.compatibility.entries.some((entry) => entry.subjectDigest === supported && entry.state === "compatible"), "supported combination must be compatible");
  }
  unique(manifest.recovery.map((plan) => plan.subjectDigest), "recovery subject");
  for (const plan of manifest.recovery) {
    parseRecoveryPlan(plan);
    requireContract(canonicalDigest(plan.subject.to) === canonicalDigest(manifest.components), "recovery target differs from release components");
  }
  return manifest;
}

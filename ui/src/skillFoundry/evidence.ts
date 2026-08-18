// Task 7 — manual physical/taste evidence. `record-evidence` binds a `--evidence` attestation
// to the EXACT frozen pending case a prior `certify` reported as `needs_manual_evidence` —
// run/case/expected-observation/artifact/eval must all still match, or the attestation is
// stale and rejected. Every listed artifact locator is revalidated (no-follow, bounded) so a
// swapped file after recording is caught. The ledger is append-only: a failed or superseded
// attempt is never overwritten, only ever followed by a new record.

import { FOUNDRY_STORAGE_LIMITS_V1, type ManualEvidenceArtifactV1, type ManualEvidenceRecordResultV1, type ManualEvidenceV1, type RecordManualEvidenceInputV1 } from "./contracts";
import { inspectExternalRegularFileV1, readBoundedNoFollowV1, atomicWriteBytesV1 } from "./safeFs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";

const DECISION_VALUES = new Set(["passed", "failed", "physical_not_required"]);
const ARTIFACT_KIND_VALUES = new Set(["audio", "image", "video", "log", "other"]);
const HEX64_REGEX = /^[0-9a-f]{64}$/;

export type ParseIssueV1 = { path: string; message: string };
export type ParseManualEvidenceResultV1 = { ok: true; value: ManualEvidenceV1 } | { ok: false; issues: readonly ParseIssueV1[] };

export function parseManualEvidenceV1(value: unknown): ParseManualEvidenceResultV1 {
  const issues: ParseIssueV1[] = [];
  if (value === null || typeof value !== "object") {
    return { ok: false, issues: [{ path: "$", message: "not an object" }] };
  }
  const v = value as Record<string, unknown>;
  if (v.schemaVersion !== 1) issues.push({ path: "schemaVersion", message: "must be 1" });
  if (typeof v.runId !== "string" || v.runId.length === 0) issues.push({ path: "runId", message: "must be a non-empty string" });
  if (typeof v.caseId !== "string" || v.caseId.length === 0) issues.push({ path: "caseId", message: "must be a non-empty string" });
  const artifact = v.artifact as Record<string, unknown> | undefined;
  if (artifact === undefined || (artifact.kind !== "declarative_manifest" && artifact.kind !== "native_payload") || typeof artifact.sha256 !== "string" || !HEX64_REGEX.test(artifact.sha256)) {
    issues.push({ path: "artifact", message: "must be a valid SkillArtifactRefV1" });
  }
  if (typeof v.evalSha256 !== "string" || !HEX64_REGEX.test(v.evalSha256)) issues.push({ path: "evalSha256", message: "must be 64 lowercase hex characters" });
  if (typeof v.expectedObservation !== "string" || v.expectedObservation.length === 0) issues.push({ path: "expectedObservation", message: "must be a non-empty string" });
  if (typeof v.decision !== "string" || !DECISION_VALUES.has(v.decision)) issues.push({ path: "decision", message: `unknown decision: ${JSON.stringify(v.decision)}` });
  if (typeof v.observed !== "string") issues.push({ path: "observed", message: "must be a string" });
  if (v.decision === "physical_not_required" && (typeof v.observed !== "string" || v.observed.trim().length === 0)) {
    issues.push({ path: "observed", message: 'decision "physical_not_required" requires a non-empty reviewer statement in observed' });
  }
  if (typeof v.actor !== "string" || v.actor.length === 0) issues.push({ path: "actor", message: "must be a non-empty string" });
  if (typeof v.recordedAt !== "string") issues.push({ path: "recordedAt", message: "must be a string" });

  const artifactsRaw = Array.isArray(v.artifacts) ? v.artifacts : null;
  const artifacts: ManualEvidenceArtifactV1[] = [];
  if (artifactsRaw === null) {
    issues.push({ path: "artifacts", message: "must be an array" });
  } else {
    artifactsRaw.forEach((raw, index) => {
      if (raw === null || typeof raw !== "object") {
        issues.push({ path: `artifacts[${index}]`, message: "not an object" });
        return;
      }
      const a = raw as Record<string, unknown>;
      if (typeof a.kind !== "string" || !ARTIFACT_KIND_VALUES.has(a.kind)) issues.push({ path: `artifacts[${index}].kind`, message: "unknown artifact kind" });
      if (typeof a.localPath !== "string" || a.localPath.length === 0) issues.push({ path: `artifacts[${index}].localPath`, message: "must be a non-empty string" });
      if (typeof a.sha256 !== "string" || !HEX64_REGEX.test(a.sha256)) issues.push({ path: `artifacts[${index}].sha256`, message: "must be 64 lowercase hex characters" });
      if (typeof a.bytes !== "number" || a.bytes < 0) issues.push({ path: `artifacts[${index}].bytes`, message: "must be a non-negative number" });
      artifacts.push({ kind: a.kind as ManualEvidenceArtifactV1["kind"], localPath: String(a.localPath ?? ""), sha256: String(a.sha256 ?? ""), bytes: Number(a.bytes ?? 0) });
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      runId: v.runId as string,
      caseId: v.caseId as string,
      artifact: artifact as ManualEvidenceV1["artifact"],
      evalSha256: v.evalSha256 as string,
      expectedObservation: v.expectedObservation as string,
      decision: v.decision as ManualEvidenceV1["decision"],
      observed: v.observed as string,
      actor: v.actor as string,
      recordedAt: v.recordedAt as string,
      artifacts,
    },
  };
}

export type EvidenceDepsV1 = { draftDir: string; uid: number };

async function readExistingRecordsV1(evidencePath: string): Promise<{ raw: string; records: ManualEvidenceV1[] }> {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8").decode(await readBoundedNoFollowV1(evidencePath, FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceBytes));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { raw: "", records: [] };
    throw err;
  }
  if (raw.length === 0) return { raw, records: [] };
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
  return { raw, records: lines.filter((l) => l.length > 0).map((l) => JSON.parse(l) as ManualEvidenceV1) };
}

export async function recordManualEvidenceV1(input: RecordManualEvidenceInputV1, deps: EvidenceDepsV1): Promise<ManualEvidenceRecordResultV1> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.evidenceBytes));
  } catch (err) {
    return { ok: false, code: "invalid_artifact", message: `evidence is not valid UTF-8 JSON: ${(err as Error).message}` };
  }
  const parsed = parseManualEvidenceV1(json);
  if (!parsed.ok) {
    if (parsed.issues.some((i) => i.path === "observed" && i.message.includes("reviewer statement"))) {
      return { ok: false, code: "missing_reviewer_statement", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
    }
    return { ok: false, code: "invalid_artifact", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  }
  const evidence = parsed.value;

  const { pending } = input;
  if (
    evidence.runId !== pending.runId ||
    evidence.caseId !== pending.caseId ||
    evidence.expectedObservation !== pending.expectedObservation ||
    evidence.artifact.sha256 !== pending.artifact.sha256 ||
    evidence.artifact.kind !== pending.artifact.kind ||
    evidence.evalSha256 !== pending.evalSha256
  ) {
    return { ok: false, code: "stale_evidence", message: "evidence does not match the current frozen pending case (stale run/eval/build/artifact)" };
  }

  for (const artifact of evidence.artifacts) {
    const inspected = await inspectExternalRegularFileV1(artifact.localPath, deps.uid, FOUNDRY_STORAGE_LIMITS_V1.maxExternalReferenceBytes);
    if (!inspected.ok || inspected.value.sha256 !== artifact.sha256 || inspected.value.bytes !== artifact.bytes) {
      return { ok: false, code: "invalid_artifact", message: `evidence artifact locator is invalid or does not match: ${artifact.localPath}` };
    }
  }

  const evidencePath = `${deps.draftDir}/manual-evidence.jsonl`;
  const { records } = await readExistingRecordsV1(evidencePath);

  const newLine = JSON.stringify(JSON.parse(new TextDecoder().decode(canonicalJsonBytes(evidence))));
  const alreadyPresent = records.some((r) => JSON.stringify(JSON.parse(new TextDecoder().decode(canonicalJsonBytes(r)))) === newLine);
  if (alreadyPresent) {
    return { ok: true, record: evidence, changed: false };
  }

  if (records.length + 1 > FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceRecords) {
    return { ok: false, code: "quota_exceeded", message: `quota exceeded: manual evidence would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceRecords} records` };
  }

  const nextRaw = `${records.map((r) => JSON.stringify(JSON.parse(new TextDecoder().decode(canonicalJsonBytes(r))))).join("\n")}${records.length > 0 ? "\n" : ""}${newLine}\n`;
  const nextBytes = new TextEncoder().encode(nextRaw);
  if (nextBytes.length > FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceBytes) {
    return { ok: false, code: "quota_exceeded", message: `quota exceeded: manual-evidence.jsonl would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceBytes} bytes` };
  }
  await atomicWriteBytesV1(evidencePath, nextBytes);

  return { ok: true, record: evidence, changed: true };
}

// Task 7 — RED-first pin for manual evidence: exact pending-case matching, stale run/eval/
// build/artifact rejection, physical_not_required requiring a nonempty statement, 128/+1
// records, and immutable duplicate/failed attempts.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { recordManualEvidenceV1 } from "./evidence";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";

const PENDING = {
  runId: "run-1",
  caseId: "physical-001",
  expectedObservation: "audible kept take after relaunch",
  artifact: { kind: "declarative_manifest" as const, sha256: "a".repeat(64) },
  evalSha256: "b".repeat(64),
};

function evidenceFor(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    runId: PENDING.runId,
    caseId: PENDING.caseId,
    artifact: PENDING.artifact,
    evalSha256: PENDING.evalSha256,
    expectedObservation: PENDING.expectedObservation,
    decision: "passed",
    observed: "heard the kept take play back clearly",
    actor: "owner",
    recordedAt: "2026-01-01T00:00:00.000Z",
    artifacts: [],
    ...overrides,
  };
}

describe("recordManualEvidenceV1", () => {
  let foundry: IsolatedFoundryV1;
  let draftDir: string;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
    draftDir = join(foundry.paths.draftsRoot, "owner-park-backgrounds");
    await mkdir(draftDir, { recursive: true });
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("records a valid attestation matching the pending case", async () => {
    const evidenceBytes = canonicalJsonBytes(evidenceFor());
    const result = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    expect(result).toMatchObject({ ok: true, changed: true });
  });

  it("is idempotent on an exact-duplicate re-record", async () => {
    const evidenceBytes = canonicalJsonBytes(evidenceFor());
    await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    const second = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    expect(second).toMatchObject({ ok: true, changed: false });
  });

  it("rejects evidence for a DIFFERENT (stale) runId", async () => {
    const evidenceBytes = canonicalJsonBytes(evidenceFor({ runId: "run-OLD" }));
    const result = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    expect(result).toMatchObject({ ok: false, code: "stale_evidence" });
  });

  it("rejects evidence whose artifact hash no longer matches (stale build)", async () => {
    const evidenceBytes = canonicalJsonBytes(evidenceFor({ artifact: { kind: "declarative_manifest", sha256: "f".repeat(64) } }));
    const result = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    expect(result).toMatchObject({ ok: false, code: "stale_evidence" });
  });

  it("rejects evidence whose evalSha256 no longer matches", async () => {
    const evidenceBytes = canonicalJsonBytes(evidenceFor({ evalSha256: "c".repeat(64) }));
    const result = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes, pending: PENDING }, { draftDir, uid });
    expect(result).toMatchObject({ ok: false, code: "stale_evidence" });
  });

  it("requires a non-empty reviewer statement for physical_not_required", async () => {
    const missing = canonicalJsonBytes(evidenceFor({ decision: "physical_not_required", observed: "" }));
    const missingResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: missing, pending: PENDING }, { draftDir, uid });
    expect(missingResult).toMatchObject({ ok: false, code: "missing_reviewer_statement" });

    const present = canonicalJsonBytes(evidenceFor({ decision: "physical_not_required", observed: "reviewer confirms this claim needs no physical check" }));
    const presentResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: present, pending: PENDING }, { draftDir, uid });
    expect(presentResult).toMatchObject({ ok: true, changed: true });
  });

  it("revalidates every listed artifact locator and rejects a mismatch", async () => {
    const filePath = join(foundry.homeDir, "evidence.wav");
    await writeFile(filePath, "audio bytes here");
    const { inspectExternalRegularFileV1 } = await import("./safeFs");
    const inspected = await inspectExternalRegularFileV1(filePath, uid, 1024);
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;

    const goodBytes = canonicalJsonBytes(
      evidenceFor({ artifacts: [{ kind: "audio", localPath: filePath, sha256: inspected.value.sha256, bytes: inspected.value.bytes }] }),
    );
    const goodResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: goodBytes, pending: PENDING }, { draftDir, uid });
    expect(goodResult.ok).toBe(true);

    const badBytes = canonicalJsonBytes(
      evidenceFor({ recordedAt: "2026-01-02T00:00:00.000Z", artifacts: [{ kind: "audio", localPath: filePath, sha256: "0".repeat(64), bytes: 999 }] }),
    );
    const badResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: badBytes, pending: PENDING }, { draftDir, uid });
    expect(badResult).toMatchObject({ ok: false, code: "invalid_artifact" });
  });

  it("accepts exactly 128 records and rejects the 129th", async () => {
    for (let i = 0; i < FOUNDRY_STORAGE_LIMITS_V1.maxManualEvidenceRecords; i += 1) {
      const bytes = canonicalJsonBytes(evidenceFor({ recordedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, actor: `owner-${i}` }));
      const result = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: bytes, pending: PENDING }, { draftDir, uid });
      expect(result.ok).toBe(true);
    }
    const overCap = canonicalJsonBytes(evidenceFor({ actor: "owner-over" }));
    const overResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: overCap, pending: PENDING }, { draftDir, uid });
    expect(overResult).toMatchObject({ ok: false, code: "quota_exceeded" });
  });

  it("a failed attempt is preserved immutably alongside a later differing attempt", async () => {
    const failed = canonicalJsonBytes(evidenceFor({ decision: "failed", observed: "did not sound right" }));
    const failedResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: failed, pending: PENDING }, { draftDir, uid });
    expect(failedResult.ok).toBe(true);

    const passed = canonicalJsonBytes(evidenceFor({ decision: "passed", observed: "sounds right now", recordedAt: "2026-01-02T00:00:00.000Z" }));
    const passedResult = await recordManualEvidenceV1({ draftId: "owner-park-backgrounds", evidenceBytes: passed, pending: PENDING }, { draftDir, uid });
    expect(passedResult).toMatchObject({ ok: true, changed: true });

    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(draftDir, "manual-evidence.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => JSON.parse(l).decision === "failed")).toBe(true);
    expect(lines.some((l) => JSON.parse(l).decision === "passed")).toBe(true);
  });
});

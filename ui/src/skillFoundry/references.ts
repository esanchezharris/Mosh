// Task 5 — immutable external-file reference locators, plus the optional
// `AbletonReferenceV1` metadata schema (spec §7.2).
//
// `absolutePath` is trusted owner-authored input per the Global Constraints — never
// root-confined. `inspectExternalRegularFileV1` (Task 3) is what bounds trust: no-follow,
// owner-uid, single-hardlink, size-bounded, and it returns the device/inode/mtime identity
// that makes the RECORDED hash trustworthy. The external file itself is never copied.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { FOUNDRY_STORAGE_LIMITS_V1, type AbletonReferenceV1, type ReferenceLocatorV1 } from "./contracts";
import { atomicWriteBytesV1, inspectExternalRegularFileV1 } from "./safeFs";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";

type AbletonReferenceCheckpointV1 = AbletonReferenceV1["checkpoints"][number];
type AbletonReferenceSetRefV1 = NonNullable<AbletonReferenceV1["beforeSet"]>;

export type ParseIssueV1 = { path: string; message: string };
export type ParseAbletonReferenceResultV1 =
  | { ok: true; value: AbletonReferenceV1 }
  | { ok: false; issues: readonly ParseIssueV1[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseSetRef(value: unknown, path: string, issues: ParseIssueV1[]): AbletonReferenceSetRefV1 | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) {
    issues.push({ path, message: "must have {path:string, sha256:64-hex}" });
    return undefined;
  }
  return { path: v.path, sha256: v.sha256 };
}

/** Structural validation for the optional Ableton reference declaration (spec §7.2). */
export function parseAbletonReferenceV1(value: unknown): ParseAbletonReferenceResultV1 {
  const issues: ParseIssueV1[] = [];
  if (value === null || typeof value !== "object") {
    return { ok: false, issues: [{ path: "$", message: "not an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (v.schemaVersion !== 1) issues.push({ path: "schemaVersion", message: "must be 1" });
  if (typeof v.journeyId !== "string" || v.journeyId.length === 0) issues.push({ path: "journeyId", message: "must be a non-empty string" });
  if (typeof v.liveVersion !== "string") issues.push({ path: "liveVersion", message: "must be a string" });
  if (typeof v.startedAt !== "string") issues.push({ path: "startedAt", message: "must be a string" });
  if (typeof v.goal !== "string") issues.push({ path: "goal", message: "must be a string" });

  const checkpointsRaw = Array.isArray(v.checkpoints) ? v.checkpoints : null;
  const checkpoints: AbletonReferenceCheckpointV1[] = [];
  if (checkpointsRaw === null) {
    issues.push({ path: "checkpoints", message: "must be an array" });
  } else {
    checkpointsRaw.forEach((raw, index) => {
      if (raw === null || typeof raw !== "object") {
        issues.push({ path: `checkpoints[${index}]`, message: "not an object" });
        return;
      }
      const c = raw as Record<string, unknown>;
      if (typeof c.name !== "string") issues.push({ path: `checkpoints[${index}].name`, message: "must be a string" });
      if (typeof c.narration !== "string") issues.push({ path: `checkpoints[${index}].narration`, message: "must be a string" });
      if (!isStringArray(c.unobservedOrAmbiguous)) {
        issues.push({ path: `checkpoints[${index}].unobservedOrAmbiguous`, message: "must be a string array" });
      }
      checkpoints.push({
        name: String(c.name ?? ""),
        narration: String(c.narration ?? ""),
        observedState: c.observedState as Record<string, unknown> | undefined,
        unobservedOrAmbiguous: isStringArray(c.unobservedOrAmbiguous) ? c.unobservedOrAmbiguous : [],
      });
    });
  }

  const beforeSet = parseSetRef(v.beforeSet, "beforeSet", issues);
  const afterSet = parseSetRef(v.afterSet, "afterSet", issues);

  const ownerRulesRaw = v.ownerRules;
  let ownerRules = { variables: [] as string[], forbidden: [] as string[] };
  if (ownerRulesRaw === null || typeof ownerRulesRaw !== "object") {
    issues.push({ path: "ownerRules", message: "must be an object" });
  } else {
    const r = ownerRulesRaw as Record<string, unknown>;
    if (!isStringArray(r.variables)) issues.push({ path: "ownerRules.variables", message: "must be a string array" });
    if (!isStringArray(r.forbidden)) issues.push({ path: "ownerRules.forbidden", message: "must be a string array" });
    ownerRules = {
      variables: isStringArray(r.variables) ? r.variables : [],
      forbidden: isStringArray(r.forbidden) ? r.forbidden : [],
    };
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      journeyId: v.journeyId as string,
      liveVersion: v.liveVersion as string,
      startedAt: v.startedAt as string,
      goal: v.goal as string,
      checkpoints,
      beforeSet,
      afterSet,
      ownerRules,
    },
  };
}

export type AddReferenceInputV1 = { draftDir: string; filePath: string; uid: number; clock: { now(): Date } };
export type AddReferenceResultV1 =
  | { ok: true; locator: ReferenceLocatorV1; changed: boolean }
  | { ok: false; code: "invalid_reference" | "quota_exceeded"; message: string };

async function buildLocatorV1(filePath: string, uid: number, nowIso: string): Promise<ReferenceLocatorV1 | { error: string }> {
  const inspected = await inspectExternalRegularFileV1(filePath, uid, FOUNDRY_STORAGE_LIMITS_V1.maxExternalReferenceBytes);
  if (!inspected.ok) return { error: inspected.message };
  const referenceId = await sha256Bytes(canonicalJsonBytes({ absolutePath: filePath, sha256: inspected.value.sha256 }));
  return {
    schemaVersion: 1,
    referenceId,
    absolutePath: filePath,
    sha256: inspected.value.sha256,
    bytes: inspected.value.bytes,
    fileIdentity: { device: inspected.value.device, inode: inspected.value.inode, mtimeNs: inspected.value.mtimeNs },
    recordedAt: nowIso,
  };
}

/**
 * Store one immutable locator for an explicit external file. Never copies the file. Exact
 * re-adds of the same path (same identity) are idempotent.
 */
export async function addReferenceV1(input: AddReferenceInputV1): Promise<AddReferenceResultV1> {
  const nowIso = input.clock.now().toISOString();
  const built = await buildLocatorV1(input.filePath, input.uid, nowIso);
  if ("error" in built) {
    return { ok: false, code: "invalid_reference", message: built.error };
  }

  const referencesDir = join(input.draftDir, "references");
  let existingCount = 0;
  try {
    existingCount = (await readdir(referencesDir)).length;
  } catch {
    existingCount = 0;
  }

  const targetPath = join(referencesDir, `${built.referenceId}.json`);
  const { existsSync } = await import("node:fs");
  const alreadyExists = existsSync(targetPath);
  if (!alreadyExists && existingCount + 1 > FOUNDRY_STORAGE_LIMITS_V1.maxReferencesPerDraft) {
    return {
      ok: false,
      code: "quota_exceeded",
      message: `quota exceeded: draft would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxReferencesPerDraft} references`,
    };
  }

  await atomicWriteBytesV1(targetPath, canonicalJsonBytes(built));
  return { ok: true, locator: built, changed: !alreadyExists };
}

export type RevalidateReferenceResultV1 =
  | { ok: true }
  | { ok: false; code: "changed" | "unreadable"; message: string };

/** Re-inspects the SAME `absolutePath` and confirms it still matches the recorded identity. */
export async function revalidateReferenceV1(locator: ReferenceLocatorV1, uid: number): Promise<RevalidateReferenceResultV1> {
  const inspected = await inspectExternalRegularFileV1(locator.absolutePath, uid, FOUNDRY_STORAGE_LIMITS_V1.maxExternalReferenceBytes);
  if (!inspected.ok) {
    return { ok: false, code: "unreadable", message: inspected.message };
  }
  const identityMatches =
    inspected.value.device === locator.fileIdentity.device &&
    inspected.value.inode === locator.fileIdentity.inode &&
    inspected.value.mtimeNs === locator.fileIdentity.mtimeNs &&
    inspected.value.sha256 === locator.sha256 &&
    inspected.value.bytes === locator.bytes;
  if (!identityMatches) {
    return { ok: false, code: "changed", message: `reference identity changed since it was recorded: ${locator.absolutePath}` };
  }
  return { ok: true };
}

// Task 5 — bounded, metadata-only source-card admission.
//
// A source card is produced by `service/corpus/recipe_source_intake.py project-skill-source`
// (or hand-authored to the identical shape). `parseSourceCardV1` re-validates it exactly the
// same way the Python projector does — same closed enums, same 1..10 unique-claim bound,
// same "unresolved/unofficial fails closed" posture — because the CLI must never trust a
// JSON file just because the Python tool once produced it; a hand-edited or stale file is
// untrusted input like any other. `sourceSnapshotSha256V1` recomputes the SAME canonical
// hash the Python side computes (verified byte-identical across languages) so a mismatch
// between a card's own `sourceSnapshotSha256` field and its actual content is caught before
// admission, not after.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  FOUNDRY_STORAGE_LIMITS_V1,
  type SourceCardAcquisitionV1,
  type SourceCardClaimOriginV1,
  type SourceCardClaimV1,
  type SourceCardPlatformHandlingV1,
  type SourceCardRightsV1,
  type SourceCardStateV1,
  type SourceCardV1,
} from "./contracts";
import { canonicalJsonBytes, sha256Bytes } from "../agent/skillFoundry/hash";
import { atomicWriteBytesV1, isSafePathComponentV1, readBoundedNoFollowV1 } from "./safeFs";

const RIGHTS_VALUES = new Set<SourceCardRightsV1>([
  "official_public_documentation",
  "creator_authorized",
  "user_owned_or_licensed",
  "manual_paraphrase_only",
]);
const ACQUISITION_VALUES = new Set<SourceCardAcquisitionV1>([
  "official_https_page",
  "creator_authorized_file",
  "user_supplied_local_file",
  "manual_viewing_notes",
]);
const PLATFORM_HANDLING_VALUES = new Set<SourceCardPlatformHandlingV1>([
  "metadata_and_short_paraphrases_only",
  "local_locator_only",
]);
const CLAIM_ORIGIN_VALUES = new Set<SourceCardClaimOriginV1>([
  "source_text",
  "owner_observation",
  "asr_ocr",
  "codex_inference",
]);
const STATE_VALUES = new Set<SourceCardStateV1>(["current", "stale", "superseded", "revoked"]);
const HEX64_REGEX = /^[0-9a-f]{64}$/;

export type ParseIssueV1 = { path: string; message: string };
export type ParseSourceCardResultV1 = { ok: true; value: SourceCardV1 } | { ok: false; issues: readonly ParseIssueV1[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Re-validates a decoded JSON value against the exact `SourceCardV1` shape and enums. */
export function parseSourceCardV1(value: unknown): ParseSourceCardResultV1 {
  const issues: ParseIssueV1[] = [];
  if (value === null || typeof value !== "object") {
    return { ok: false, issues: [{ path: "$", message: "not an object" }] };
  }
  const v = value as Record<string, unknown>;

  if (v.schemaVersion !== 1) issues.push({ path: "schemaVersion", message: "must be 1" });
  if (!isNonEmptyString(v.sourceCardId) || !isSafePathComponentV1(v.sourceCardId, 64)) {
    issues.push({ path: "sourceCardId", message: "must be a safe lowercase slug of at most 64 characters" });
  }
  if (typeof v.sourceVersion !== "string") issues.push({ path: "sourceVersion", message: "must be a string" });
  if (!RIGHTS_VALUES.has(v.rights as SourceCardRightsV1)) {
    issues.push({ path: "rights", message: `unresolved or unknown rights: ${JSON.stringify(v.rights)}` });
  }
  if (!ACQUISITION_VALUES.has(v.acquisition as SourceCardAcquisitionV1)) {
    issues.push({ path: "acquisition", message: `unresolved or unofficial acquisition: ${JSON.stringify(v.acquisition)}` });
  }
  if (!PLATFORM_HANDLING_VALUES.has(v.platformHandling as SourceCardPlatformHandlingV1)) {
    issues.push({ path: "platformHandling", message: `unresolved platform handling: ${JSON.stringify(v.platformHandling)}` });
  }
  const evidenceSha256 = v.evidenceSha256;
  if (typeof evidenceSha256 !== "string" || (evidenceSha256.length > 0 && !HEX64_REGEX.test(evidenceSha256))) {
    issues.push({ path: "evidenceSha256", message: "must be empty or 64 lowercase hex characters" });
  }
  if (typeof v.reviewer !== "string") issues.push({ path: "reviewer", message: "must be a string" });
  if (typeof v.reviewedAt !== "string") issues.push({ path: "reviewedAt", message: "must be a string" });
  if (!STATE_VALUES.has(v.state as SourceCardStateV1)) {
    issues.push({ path: "state", message: `unknown source state: ${JSON.stringify(v.state)}` });
  }
  const dependentIds = Array.isArray(v.dependentIds) ? v.dependentIds : null;
  if (dependentIds === null || !dependentIds.every((d) => typeof d === "string")) {
    issues.push({ path: "dependentIds", message: "must be a string array" });
  }

  const claimsRaw = Array.isArray(v.claims) ? v.claims : null;
  const claims: SourceCardClaimV1[] = [];
  if (claimsRaw === null) {
    issues.push({ path: "claims", message: "must be an array" });
  } else {
    if (claimsRaw.length < 1) issues.push({ path: "claims", message: "at least one claim is required" });
    if (claimsRaw.length > 10) issues.push({ path: "claims", message: `claim ceiling exceeded: ${claimsRaw.length} claims (max 10)` });
    const seenIds = new Set<string>();
    claimsRaw.forEach((raw, index) => {
      if (raw === null || typeof raw !== "object") {
        issues.push({ path: `claims[${index}]`, message: "not an object" });
        return;
      }
      const c = raw as Record<string, unknown>;
      if (!isNonEmptyString(c.claimId)) {
        issues.push({ path: `claims[${index}].claimId`, message: "must be a non-empty string" });
      } else if (seenIds.has(c.claimId)) {
        issues.push({ path: `claims[${index}].claimId`, message: `duplicate claim id: ${c.claimId}` });
      } else {
        seenIds.add(c.claimId);
      }
      if (!CLAIM_ORIGIN_VALUES.has(c.origin as SourceCardClaimOriginV1)) {
        issues.push({ path: `claims[${index}].origin`, message: `unknown claim origin: ${JSON.stringify(c.origin)}` });
      }
      for (const field of ["workflowMoment", "paraphrase", "boundary"] as const) {
        if (typeof c[field] !== "string") issues.push({ path: `claims[${index}].${field}`, message: "must be a string" });
      }
      claims.push({
        claimId: String(c.claimId ?? ""),
        origin: c.origin as SourceCardClaimOriginV1,
        workflowMoment: String(c.workflowMoment ?? ""),
        paraphrase: String(c.paraphrase ?? ""),
        boundary: String(c.boundary ?? ""),
      });
    });
  }

  if (!HEX64_REGEX.test((v.sourceSnapshotSha256 as string) ?? "")) {
    issues.push({ path: "sourceSnapshotSha256", message: "must be 64 lowercase hex characters" });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      sourceCardId: v.sourceCardId as string,
      sourceVersion: v.sourceVersion as string,
      rights: v.rights as SourceCardRightsV1,
      acquisition: v.acquisition as SourceCardAcquisitionV1,
      platformHandling: v.platformHandling as SourceCardPlatformHandlingV1,
      evidenceSha256: evidenceSha256 as string,
      reviewer: v.reviewer as string,
      reviewedAt: v.reviewedAt as string,
      state: v.state as SourceCardStateV1,
      dependentIds: dependentIds as string[],
      claims,
      sourceSnapshotSha256: v.sourceSnapshotSha256 as string,
    },
  };
}

/** Recomputes the canonical snapshot hash — MUST match `recipe_source_intake.py`'s exactly. */
export async function sourceSnapshotSha256V1(card: SourceCardV1): Promise<string> {
  const snapshotPayload = {
    sourceCardId: card.sourceCardId,
    sourceVersion: card.sourceVersion,
    rights: card.rights,
    acquisition: card.acquisition,
    platformHandling: card.platformHandling,
    evidenceSha256: card.evidenceSha256,
    claims: card.claims.map((c) => ({
      claimId: c.claimId,
      origin: c.origin,
      workflowMoment: c.workflowMoment,
      paraphrase: c.paraphrase,
      boundary: c.boundary,
    })),
  };
  return sha256Bytes(canonicalJsonBytes(snapshotPayload));
}

export type AddSourceCardInputV1 = { draftDir: string; teachRoot: string; cardPath: string };
export type AddSourceCardResultV1 =
  | { ok: true; card: SourceCardV1; changed: boolean }
  | { ok: false; code: "invalid_source_card" | "quota_exceeded" | "conflict"; message: string };

/**
 * Validate one explicit source-card file and copy its EXACT bytes into
 * `<draft>/sources/<id>.json`, mirroring the current reviewed copy under
 * `<teach>/source-cards/<id>.json`. Exact-duplicate re-adds are idempotent; a same-ID
 * conflicting-bytes re-add fails (that is `refresh-source`'s job, not `add-source`'s).
 */
export async function addSourceCardV1(input: AddSourceCardInputV1): Promise<AddSourceCardResultV1> {
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedNoFollowV1(input.cardPath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
  } catch (err) {
    return { ok: false, code: "invalid_source_card", message: (err as Error).message };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (err) {
    return { ok: false, code: "invalid_source_card", message: `not valid UTF-8 JSON: ${(err as Error).message}` };
  }

  const parsed = parseSourceCardV1(parsedJson);
  if (!parsed.ok) {
    return { ok: false, code: "invalid_source_card", message: parsed.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
  }
  const card = parsed.value;

  const expectedSnapshot = await sourceSnapshotSha256V1(card);
  if (expectedSnapshot !== card.sourceSnapshotSha256) {
    return { ok: false, code: "invalid_source_card", message: "sourceSnapshotSha256 does not match the card's own content" };
  }

  const sourcesDir = join(input.draftDir, "sources");
  let existingCount = 0;
  try {
    existingCount = (await readdir(sourcesDir)).length;
  } catch {
    existingCount = 0;
  }

  const targetPath = join(sourcesDir, `${card.sourceCardId}.json`);
  let existingBytes: Uint8Array | null = null;
  try {
    existingBytes = await readBoundedNoFollowV1(targetPath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, code: "invalid_source_card", message: (err as Error).message };
    }
  }

  if (existingBytes !== null) {
    const same = Buffer.compare(Buffer.from(existingBytes), Buffer.from(bytes)) === 0;
    if (same) {
      return { ok: true, card, changed: false };
    }
    return { ok: false, code: "conflict", message: `source card "${card.sourceCardId}" already exists with different content` };
  }

  if (existingCount + 1 > FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardsPerDraft) {
    return {
      ok: false,
      code: "quota_exceeded",
      message: `quota exceeded: draft would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardsPerDraft} source cards`,
    };
  }

  await atomicWriteBytesV1(targetPath, bytes);
  await atomicWriteBytesV1(join(input.teachRoot, "source-cards", `${card.sourceCardId}.json`), bytes);

  return { ok: true, card, changed: true };
}

// Task 5 — the `$MOSH_AGENT_DIR/skills/source-status.json` freshness/revocation index.
//
// DESIGN DECISION: the plan's spec-text example path (`$MOSH_AGENT_DIR/sources/status.json`)
// disagrees with the ALREADY-MERGED Slice A native reader, which reads
// `<agentRoot>/skills/source-status.json` (`src/agent/CertifiedSkillLoader.cpp:652,755`).
// Slice A ships first and is the actual runtime consumer, so this module (and Task 3's
// `paths.ts`) targets the merged path, not the older spec-text path — the spec text is
// simply stale here.
//
// DESIGN DECISION (freshness window): the plan and spec define `reviewAfter` as a field but
// never state its offset from `reviewedAt`. This module uses 90 days, matching the freshness
// convention this repo already applies to garbage collection elsewhere (spec §5.4 / plan
// Task 9's 90-day GC threshold) — reusing an existing number rather than inventing a new one.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FOUNDRY_STORAGE_LIMITS_V1, type SourceCardV1, type SourceStatusEntryV1, type SourceStatusV1 } from "./contracts";
import { atomicWriteBytesV1, isSafePathComponentV1, readBoundedNoFollowV1 } from "./safeFs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";
import { parseSourceCardV1 } from "./sourceCards";

export const SOURCE_FRESHNESS_WINDOW_MS_V1 = 90 * 24 * 60 * 60 * 1000;

const EMPTY_INDEX: SourceStatusV1 = { schemaVersion: 1, generation: 0, updatedAt: new Date(0).toISOString(), entries: [] };

export type ClockV1 = { now(): Date };

function isValidEntry(value: unknown): value is SourceStatusEntryV1 {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sourceCardId === "string" &&
    typeof v.sourceSnapshotSha256 === "string" &&
    (v.state === "current" || v.state === "stale" || v.state === "superseded" || v.state === "revoked") &&
    typeof v.checkedAt === "string" &&
    typeof v.reviewAfter === "string"
  );
}

/** Missing file reads as the empty index (generation 0). Malformed JSON throws — fail closed. */
export async function readSourceStatusV1(sourceStatusPath: string): Promise<SourceStatusV1> {
  let raw: string;
  try {
    raw = await readFile(sourceStatusPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_INDEX;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`source-status index is not valid JSON: ${sourceStatusPath}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`source-status index is not an object: ${sourceStatusPath}`);
  }
  const v = parsed as Record<string, unknown>;
  if (v.schemaVersion !== 1 || typeof v.generation !== "number" || typeof v.updatedAt !== "string" || !Array.isArray(v.entries)) {
    throw new Error(`source-status index is malformed: ${sourceStatusPath}`);
  }
  // 256 entries matches Slice A's `SKILL_LIMITS_V1.sourceStatusEntries` — the runtime cap
  // for THIS exact index (a different axis from `FOUNDRY_STORAGE_LIMITS_V1`'s per-draft caps).
  if (v.entries.length > 256) {
    throw new Error(`source-status index exceeds its entry cap: ${sourceStatusPath}`);
  }
  const entries: SourceStatusEntryV1[] = [];
  for (const entry of v.entries) {
    if (!isValidEntry(entry)) {
      throw new Error(`source-status index has a malformed entry: ${sourceStatusPath}`);
    }
    entries.push(entry);
  }
  return { schemaVersion: 1, generation: v.generation, updatedAt: v.updatedAt, entries };
}

async function writeIndexV1(sourceStatusPath: string, index: SourceStatusV1): Promise<void> {
  const sorted: SourceStatusV1 = { ...index, entries: [...index.entries].sort((a, b) => a.sourceCardId.localeCompare(b.sourceCardId)) };
  await atomicWriteBytesV1(sourceStatusPath, canonicalJsonBytes(sorted));
}

export type RefreshSourceStatusInputV1 = {
  sourceStatusPath: string;
  /** `<teachRoot>/source-cards` — the mirrored reviewed-metadata directory `sourceCards.ts` writes. */
  sourceCardsRoot: string;
  card: SourceCardV1;
  snapshotSha256: string;
  clock: ClockV1;
};
export type RefreshSourceStatusResultV1 =
  | { ok: true; index: SourceStatusV1; entry: SourceStatusEntryV1; changed: boolean }
  | { ok: false; code: "acquisition_mismatch"; message: string };

/**
 * Idempotent add-or-refresh: an unchanged snapshot hash extends freshness WITHOUT bumping
 * `generation`; a changed hash advances `generation` by exactly one. Never fetches anything
 * — the caller already validated and hashed `card` (see `sourceCards.ts`). Follows ONLY the
 * acquisition method already approved on the mirrored master card: a refresh that tries to
 * switch acquisition method (e.g. an official page suddenly becoming "manual viewing
 * notes") is rejected rather than silently accepted.
 */
export async function refreshSourceStatusV1(input: RefreshSourceStatusInputV1): Promise<RefreshSourceStatusResultV1> {
  if (!isSafePathComponentV1(input.card.sourceCardId, 64)) {
    throw new Error(`unsafe source card id: ${input.card.sourceCardId}`);
  }

  const mirrorPath = join(input.sourceCardsRoot, `${input.card.sourceCardId}.json`);
  try {
    const existingBytes = await readBoundedNoFollowV1(mirrorPath, FOUNDRY_STORAGE_LIMITS_V1.maxSourceCardBytes);
    const existingParsed = parseSourceCardV1(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(existingBytes)));
    if (existingParsed.ok && existingParsed.value.acquisition !== input.card.acquisition) {
      return {
        ok: false,
        code: "acquisition_mismatch",
        message: `refresh must use the already-approved acquisition method "${existingParsed.value.acquisition}", got "${input.card.acquisition}"`,
      };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No prior mirrored card: this is effectively a first admission via refresh-source,
    // nothing to compare acquisition against yet.
  }

  const current = await readSourceStatusV1(input.sourceStatusPath);
  const now = input.clock.now();
  const nowIso = now.toISOString();
  const reviewAfter = new Date(now.getTime() + SOURCE_FRESHNESS_WINDOW_MS_V1).toISOString();

  const existingIndex = current.entries.findIndex((e) => e.sourceCardId === input.card.sourceCardId);
  const existing = existingIndex >= 0 ? current.entries[existingIndex] : null;

  const digestChanged = existing === null || existing.sourceSnapshotSha256 !== input.snapshotSha256;
  const newEntry: SourceStatusEntryV1 = {
    sourceCardId: input.card.sourceCardId,
    sourceSnapshotSha256: input.snapshotSha256,
    state: "current",
    checkedAt: nowIso,
    reviewAfter,
  };

  const sameEntryContent =
    existing !== null &&
    !digestChanged &&
    existing.state === "current" &&
    existing.checkedAt === nowIso &&
    existing.reviewAfter === reviewAfter;
  if (sameEntryContent) {
    return { ok: true, index: current, entry: existing as SourceStatusEntryV1, changed: false };
  }

  const entries =
    existingIndex >= 0
      ? current.entries.map((e, i) => (i === existingIndex ? newEntry : e))
      : [...current.entries, newEntry];

  const nextIndex: SourceStatusV1 = {
    schemaVersion: 1,
    generation: digestChanged ? current.generation + 1 : current.generation,
    updatedAt: nowIso,
    entries,
  };
  await writeIndexV1(input.sourceStatusPath, nextIndex);
  return { ok: true, index: nextIndex, entry: newEntry, changed: true };
}

export type RevokeSourceStatusResultV1 =
  | { ok: true; index: SourceStatusV1; changed: boolean }
  | { ok: false; code: "source_card_not_found"; message: string };

/** Marks an entry revoked and bumps `generation` exactly once; repeated revoke is a no-op. */
export async function revokeSourceStatusV1(
  sourceStatusPath: string,
  sourceCardId: string,
  clock: ClockV1,
): Promise<RevokeSourceStatusResultV1> {
  if (!isSafePathComponentV1(sourceCardId, 64)) {
    return { ok: false, code: "source_card_not_found", message: `unsafe source card id: ${sourceCardId}` };
  }
  const current = await readSourceStatusV1(sourceStatusPath);
  const idx = current.entries.findIndex((e) => e.sourceCardId === sourceCardId);
  if (idx < 0) {
    return { ok: false, code: "source_card_not_found", message: `unknown source card: ${sourceCardId}` };
  }
  if (current.entries[idx].state === "revoked") {
    return { ok: true, index: current, changed: false };
  }
  const nowIso = clock.now().toISOString();
  const entries = current.entries.map((e, i) => (i === idx ? { ...e, state: "revoked" as const, checkedAt: nowIso } : e));
  const nextIndex: SourceStatusV1 = { schemaVersion: 1, generation: current.generation + 1, updatedAt: nowIso, entries };
  await writeIndexV1(sourceStatusPath, nextIndex);
  return { ok: true, index: nextIndex, changed: true };
}

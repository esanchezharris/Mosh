// Task 3 — quota measurement and mutation assertion against `FOUNDRY_STORAGE_LIMITS_V1`.
//
// `measureFoundryQuotaV1` traverses ONLY regular files (never follows a symlink, never
// double-counts a hard link within one traversal via device+inode dedupe) to build a
// snapshot; `assertQuotaMutationV1` is a pure, synchronous check against a prospective
// delta so callers can measure once, then validate several candidate mutations against the
// same snapshot before committing any of them. Every caller must re-measure and re-assert
// immediately before publication, under the foundry lock — a snapshot is a point-in-time
// read, not a reservation.

import { readdir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { FOUNDRY_STORAGE_LIMITS_V1, type FoundryPathsV1, type FoundryQuotaSnapshotV1, type QuotaMutationDeltaV1 } from "./contracts";

async function sumDirectoryBytesV1(rootDir: string): Promise<number> {
  const seenInodes = new Set<string>();
  let total = 0;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      const key = `${st.dev}:${st.ino}`;
      if (seenInodes.has(key)) continue;
      seenInodes.add(key);
      total += st.size;
    }
  }

  await walk(rootDir);
  return total;
}

/** Measure current foundry storage usage. Missing roots read as empty, not an error. */
export async function measureFoundryQuotaV1(paths: FoundryPathsV1): Promise<FoundryQuotaSnapshotV1> {
  let draftEntries: Dirent[];
  try {
    draftEntries = await readdir(paths.draftsRoot, { withFileTypes: true });
  } catch {
    draftEntries = [];
  }
  const draftDirs = draftEntries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());

  const draftBytesById: Record<string, number> = {};
  let allDraftBytes = 0;
  for (const dirent of draftDirs) {
    const bytes = await sumDirectoryBytesV1(join(paths.draftsRoot, dirent.name));
    draftBytesById[dirent.name] = bytes;
    allDraftBytes += bytes;
  }

  const allRunArtifactBytes = await sumDirectoryBytesV1(paths.artifactsRoot);

  return { draftCount: draftDirs.length, draftBytesById, allDraftBytes, allRunArtifactBytes };
}

/** Throws an `Error` whose message matches `/quota/i` when `delta` would exceed a cap. */
export function assertQuotaMutationV1(snapshot: FoundryQuotaSnapshotV1, delta: QuotaMutationDeltaV1): void {
  if (delta.newDraft === true && snapshot.draftCount + 1 > FOUNDRY_STORAGE_LIMITS_V1.maxDrafts) {
    throw new Error(`quota exceeded: draft count would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxDrafts}`);
  }

  const draftBytesDelta = delta.draftBytesDelta ?? 0;

  if (delta.draftId !== undefined && draftBytesDelta !== 0) {
    const currentBytes = snapshot.draftBytesById[delta.draftId] ?? 0;
    const nextBytes = currentBytes + draftBytesDelta;
    if (nextBytes > FOUNDRY_STORAGE_LIMITS_V1.maxDraftBytes) {
      throw new Error(
        `quota exceeded: draft "${delta.draftId}" would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxDraftBytes} bytes (${nextBytes})`,
      );
    }
  }

  const nextAllDraftBytes = snapshot.allDraftBytes + draftBytesDelta;
  if (nextAllDraftBytes > FOUNDRY_STORAGE_LIMITS_V1.maxAllDraftBytes) {
    throw new Error(
      `quota exceeded: all draft metadata would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxAllDraftBytes} bytes (${nextAllDraftBytes})`,
    );
  }

  if (delta.runArtifactBytesDelta !== undefined) {
    const nextRunArtifactBytes = snapshot.allRunArtifactBytes + delta.runArtifactBytesDelta;
    if (nextRunArtifactBytes > FOUNDRY_STORAGE_LIMITS_V1.maxAllRunArtifactBytes) {
      throw new Error(
        `quota exceeded: all run artifacts would exceed ${FOUNDRY_STORAGE_LIMITS_V1.maxAllRunArtifactBytes} bytes (${nextRunArtifactBytes})`,
      );
    }
  }
}

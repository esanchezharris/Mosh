// Task 6 — the bounded, non-public Codex compiler helper: `authorCandidateArtifactsV1`.
// Not a CLI command (absent from `TeachMoshiCommandV1`/`commands.ts`/`ui/package.json`) —
// only `ui/scripts/teachMoshi/authorCandidate.ts` (the developer/Codex entrypoint) and
// `nativeDraftSeed.ts` call this.
//
// Crash safety: before changing EITHER artifact file, a durable `.authoring-v1.json` marker
// is written recording the transaction's old/new hashes AND the new bytes themselves
// (base64) — genuine crash RECOVERY (not just detection) needs the actual new bytes, since a
// crashed process cannot be asked to resupply its input. Any draft load while the marker
// exists is `draft_update_incomplete`; `recoverAuthoringMarkerV1` deterministically finishes
// or fails closed (never guesses) the next time authoring runs against this draft.

import { readFile, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthorCandidateArtifactsInputV1, AuthorCandidateArtifactsResultV1, ClockV1, DraftStoreV1, FoundryPathsV1 } from "./contracts";
import { atomicWriteBytesV1, fsyncDirectoryV1, isSafePathComponentV1 } from "./safeFs";
import { sha256Bytes } from "../agent/skillFoundry/hash";
import { appendStateTransitionV1, isLegalStateTransitionV1, readStateLedgerV1 } from "./stateLedger";
import { resolveOfflineExecutionIdentityV1, type ExecutionIdentityDepsV1 } from "./draftStore";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { NATIVE_SKILL_IDS_V1 } from "../agent/skillFoundry/catalogs";

const MARKER_FILE_NAME = ".authoring-v1.json";

type AuthoringMarkerV1 = {
  schemaVersion: 1;
  nonce: string;
  old: { candidateSha256: string | null; evalSha256: string | null };
  new: { candidateSha256: string; evalSha256: string };
  newCandidateBase64: string;
  newEvalBase64: string;
  staleAppended: boolean;
};

function markerPath(draftDir: string): string {
  return join(draftDir, MARKER_FILE_NAME);
}

/** True iff an authoring transaction was left incomplete by a crash. */
export async function hasIncompleteAuthoringMarkerV1(draftDir: string): Promise<boolean> {
  try {
    await readFile(markerPath(draftDir));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export type CompilerAuthoringDepsV1 = { store: DraftStoreV1; paths: FoundryPathsV1; clock: ClockV1; identityDeps?: ExecutionIdentityDepsV1 };

async function readCurrentBytesV1(store: DraftStoreV1, draftId: string, name: "candidate" | "evals"): Promise<Uint8Array | null> {
  return store.readArtifactBytes(draftId, name, { missing: "null" });
}

/**
 * Deterministically finish or fail-closed an interrupted authoring transaction. Only
 * completes a file whose CURRENT bytes hash to exactly the marker's recorded `old` or `new`
 * value — an unexpected third state is left untouched and reported, never guessed at.
 */
export async function recoverAuthoringMarkerV1(
  draftDir: string,
  draftId: string,
  deps: CompilerAuthoringDepsV1,
): Promise<{ recovered: boolean; message?: string }> {
  let raw: string;
  try {
    raw = await readFile(markerPath(draftDir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { recovered: true };
    throw err;
  }
  const marker = JSON.parse(raw) as AuthoringMarkerV1;

  const currentCandidate = await readCurrentBytesV1(deps.store, draftId, "candidate");
  const currentCandidateSha = currentCandidate !== null ? await sha256Bytes(currentCandidate) : null;
  if (currentCandidateSha !== marker.new.candidateSha256) {
    if (currentCandidateSha !== marker.old.candidateSha256) {
      return { recovered: false, message: "candidate.skill.json is in an unexpected state; cannot auto-recover" };
    }
    const newBytes = Buffer.from(marker.newCandidateBase64, "base64");
    await deps.store.writeArtifactBytes(draftId, "candidate", new Uint8Array(newBytes), {
      createOnly: marker.old.candidateSha256 === null,
      expectedSha256: marker.old.candidateSha256 ?? undefined,
    });
  }

  const currentEval = await readCurrentBytesV1(deps.store, draftId, "evals");
  const currentEvalSha = currentEval !== null ? await sha256Bytes(currentEval) : null;
  if (currentEvalSha !== marker.new.evalSha256) {
    if (currentEvalSha !== marker.old.evalSha256) {
      return { recovered: false, message: "evals.jsonl is in an unexpected state; cannot auto-recover" };
    }
    const newBytes = Buffer.from(marker.newEvalBase64, "base64");
    await deps.store.writeArtifactBytes(draftId, "evals", new Uint8Array(newBytes), {
      createOnly: marker.old.evalSha256 === null,
      expectedSha256: marker.old.evalSha256 ?? undefined,
    });
  }

  if (!marker.staleAppended) {
    await appendStaleIfLegalV1(draftDir, deps);
  }

  await unlink(markerPath(draftDir));
  await fsyncDirectoryV1(draftDir);
  return { recovered: true };
}

async function appendStaleIfLegalV1(draftDir: string, deps: CompilerAuthoringDepsV1): Promise<void> {
  const statePath = join(draftDir, "state.jsonl");
  const history = await readStateLedgerV1(statePath);
  const legality = isLegalStateTransitionV1(history, "stale", "declarative");
  if (!legality.ok) return; // e.g. a fresh "draft" with no proven stage to invalidate yet
  const executionIdentity = await resolveOfflineExecutionIdentityV1(deps.identityDeps);
  const nowIso = deps.clock.now().toISOString();
  await appendStateTransitionV1(statePath, {
    state: "stale",
    artifactKind: "declarative",
    artifactHashes: {},
    executionIdentity,
    testCommand: "teach-moshi (internal) author-candidate",
    startedAt: nowIso,
    finishedAt: nowIso,
    result: "passed",
  });
}

export async function authorCandidateArtifactsV1(
  input: AuthorCandidateArtifactsInputV1,
  deps: CompilerAuthoringDepsV1,
): Promise<AuthorCandidateArtifactsResultV1> {
  if (input.candidateBytes.length > FOUNDRY_STORAGE_LIMITS_V1.maxDraftBytes || input.evalsBytes.length > FOUNDRY_STORAGE_LIMITS_V1.maxEvalsJsonlBytes) {
    throw new Error("quota exceeded: candidate or eval bytes exceed their cap");
  }

  if (!isSafePathComponentV1(input.draftId)) {
    throw new Error(`unsafe draft id: ${input.draftId}`);
  }
  // Native drafts always use one of the four bare canonical IDs; declarative owner drafts
  // always use the "owner-" namespace. The namespaces never overlap, so this check alone
  // (no persisted artifact-kind field needed) is sufficient to reject a native draft here —
  // public authoring must never overwrite the four core native payloads.
  if ((NATIVE_SKILL_IDS_V1 as readonly string[]).includes(input.draftId)) {
    throw new Error(`authorCandidateArtifactsV1 rejects native artifact kinds: ${input.draftId}`);
  }
  const draftDir = join(deps.paths.draftsRoot, input.draftId);
  const statePath = join(draftDir, "state.jsonl");
  const priorState = await readStateLedgerV1(statePath);
  if (priorState.length === 0) {
    throw new Error(`draft not found: ${input.draftId}`);
  }

  const recovery = await recoverAuthoringMarkerV1(draftDir, input.draftId, deps);
  if (!recovery.recovered) {
    throw new Error(`draft_update_incomplete: ${recovery.message}`);
  }

  const oldCandidate = await readCurrentBytesV1(deps.store, input.draftId, "candidate");
  const oldEval = await readCurrentBytesV1(deps.store, input.draftId, "evals");
  const oldCandidateSha256 = oldCandidate !== null ? await sha256Bytes(oldCandidate) : null;
  const oldEvalSha256 = oldEval !== null ? await sha256Bytes(oldEval) : null;
  const newCandidateSha256 = await sha256Bytes(input.candidateBytes);
  const newEvalSha256 = await sha256Bytes(input.evalsBytes);

  if (oldCandidateSha256 === newCandidateSha256 && oldEvalSha256 === newEvalSha256) {
    return { changed: false, candidateSha256: newCandidateSha256, evalSha256: newEvalSha256 };
  }

  const marker: AuthoringMarkerV1 = {
    schemaVersion: 1,
    nonce: randomUUID(),
    old: { candidateSha256: oldCandidateSha256, evalSha256: oldEvalSha256 },
    new: { candidateSha256: newCandidateSha256, evalSha256: newEvalSha256 },
    newCandidateBase64: Buffer.from(input.candidateBytes).toString("base64"),
    newEvalBase64: Buffer.from(input.evalsBytes).toString("base64"),
    staleAppended: false,
  };
  await atomicWriteBytesV1(markerPath(draftDir), new TextEncoder().encode(JSON.stringify(marker)));

  await deps.store.writeArtifactBytes(input.draftId, "candidate", input.candidateBytes, {
    createOnly: oldCandidateSha256 === null,
    expectedSha256: oldCandidateSha256 ?? undefined,
  });
  await deps.store.writeArtifactBytes(input.draftId, "evals", input.evalsBytes, {
    createOnly: oldEvalSha256 === null,
    expectedSha256: oldEvalSha256 ?? undefined,
  });

  await appendStaleIfLegalV1(draftDir, deps);

  await unlink(markerPath(draftDir));
  await fsyncDirectoryV1(draftDir);

  return { changed: true, candidateSha256: newCandidateSha256, evalSha256: newEvalSha256 };
}

// Re-exported for tests that need to simulate a crash by leaving the marker in place.
export async function removeMarkerForTestV1(draftDir: string): Promise<void> {
  await rm(markerPath(draftDir), { force: true });
}

export function markerPathForTestV1(draftDir: string): string {
  return markerPath(draftDir);
}

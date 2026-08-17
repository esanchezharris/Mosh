// Skill Foundry Slice B, Task 2 — observed recording-lifecycle state and the store <->
// native-runtime seam.
//
// This module has two jobs:
//   1. `observeRecordingLane` — a pure, stable-ID projection of "what does the snapshot
//      say about this clip's takes right now" (Task 1's native `Clip.takeIds`/
//      `currentTakeId` fields), used by store.ts to build its own richer observed
//      result on every recording-lifecycle transition.
//   2. `createRecordingLifecycleEnvironmentV1` — an adapter from store.ts's own richer
//      `RecordingStoreOutcomeV1` down to Slice A's verbatim `RecordingLifecycleResultV1`/
//      `RecordingLifecycleEnvironmentV1` (contracts.ts), which is the exact shape
//      `StudioSkillEnvironmentV1.recording` and the native `takeCycleV1` handler consume.
//      Neither Slice A contract is redeclared here — both are imported verbatim.

import type { RecordingLifecycleEnvironmentV1, RecordingLifecycleResultV1 } from "./agent/skillFoundry/contracts";
import type { CommandResult, Snapshot } from "./types";

export type RecordingCommandData = {
  applied?: boolean;
  clips?: unknown[];
  reason?: string;
};

export function landedRecordingClipIds(result: CommandResult): string[] | null {
  if (!result.ok || result.command !== "stop_recording") return null;
  const data = result.data as RecordingCommandData | undefined;
  if (data?.applied !== true || !Array.isArray(data.clips) || data.clips.length === 0)
    return null;

  const ids: string[] = [];
  for (const clip of data.clips) {
    if (clip === null || typeof clip !== "object") return null;
    const id = (clip as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) return null;
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------------------
// Observed take-lane projection
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: not given an exact shape anywhere — only that the store must expose
// "baseline"/"review" objects the plan's RED snippet asserts against
// (`{ takeIds: [...], currentTakeId: ... }`). Modeled as the minimal stable-ID lane
// observation Task 1's native `Clip.takeIds`/`currentTakeId` fields make possible, plus
// the clip/track it was read from (so a caller never has to re-search the snapshot).
export type RecordingLaneObservationV1 = {
  readonly clipId: string;
  readonly trackId: string;
  readonly takeIds: readonly string[];
  readonly currentTakeId: string;
};

/**
 * Read the stable-ID take-lane state for one clip out of a snapshot. Returns null unless
 * EVERY field is well-formed: a non-empty, all-non-empty-string `takeIds` array and a
 * non-empty `currentTakeId` that is one of them. A clip whose ids have not been
 * backfilled yet (Task 1 — an empty string at some index, or an empty `currentTakeId`)
 * is deliberately treated as "not yet observable" rather than reported with a hole, so a
 * caller never mistakes a placeholder empty string for a real id.
 */
export function observeRecordingLane(snapshot: Snapshot, clipId: string): RecordingLaneObservationV1 | null {
  for (const track of snapshot.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (!clip) continue;
    const { takeIds, currentTakeId } = clip;
    if (!Array.isArray(takeIds) || takeIds.length === 0) return null;
    if (takeIds.some((id) => typeof id !== "string" || id.length === 0)) return null;
    if (typeof currentTakeId !== "string" || currentTakeId.length === 0) return null;
    if (!takeIds.includes(currentTakeId)) return null;
    return { clipId, trackId: track.id, takeIds: [...takeIds], currentTakeId };
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Store-facing observed outcome
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: `RecordingStoreOutcomeV1` is not given an exact shape — only that
// `store.enterRecord()`/`store.stopRecord()` must resolve to something matching
// `{ kind: "started", baseline: {...} }` / `{ kind: "reviewing", review: {...} }` (the
// plan's own RED snippet). This is deliberately RICHER than Slice A's
// `RecordingLifecycleResultV1` (a bare `state: string`) because store.ts's callers
// (tests, and eventually UI code) want a closed, narrowable `kind` plus the actual
// observed take-lane snapshot Task 1's stable ids make possible — `state: string` alone
// cannot carry that. `createRecordingLifecycleEnvironmentV1` below is the ONE place this
// richer shape is narrowed back down to the generic contract for the native runtime.
export type RecordingStoreOutcomeV1 =
  | { readonly kind: "started"; readonly baseline: RecordingLaneObservationV1 | null }
  | { readonly kind: "recording_failed"; readonly reason: string }
  | { readonly kind: "reviewing"; readonly review: RecordingLaneObservationV1 }
  | { readonly kind: "landed_unverified"; readonly reason: string }
  | { readonly kind: "kept"; readonly review: RecordingLaneObservationV1 | null }
  | { readonly kind: "not_recording" }
  | { readonly kind: "blocked"; readonly reason: string };

// ---------------------------------------------------------------------------------------
// RecordingLifecycleEnvironmentV1 adapter
// ---------------------------------------------------------------------------------------

export type RecordingLifecycleStoreDepsV1 = {
  readonly enterRecord: (bar?: number) => Promise<RecordingStoreOutcomeV1>;
  readonly stopRecord: () => Promise<RecordingStoreOutcomeV1>;
  readonly navTake: (delta: -1 | 1) => Promise<RecordingStoreOutcomeV1>;
  readonly keepTake: (takeId?: string) => Promise<RecordingStoreOutcomeV1>;
};

function toLifecycleResultV1(outcome: RecordingStoreOutcomeV1): RecordingLifecycleResultV1 {
  switch (outcome.kind) {
    case "started":
      return { ok: true, state: "recording", say: "Recording.", changes: null };
    case "reviewing":
      return { ok: true, state: "reviewing", say: "Stopped — reviewing the take.", changes: null };
    case "kept":
      return { ok: true, state: "kept", say: "Kept the take.", changes: null };
    case "not_recording":
      return { ok: true, state: "idle", say: "Not recording.", changes: null };
    case "recording_failed":
      return { ok: false, code: "observation_failed", say: outcome.reason };
    case "landed_unverified":
      return { ok: false, code: "observation_failed", say: outcome.reason };
    case "blocked":
      return { ok: false, code: "missing_target", say: outcome.reason };
  }
}

/**
 * Adapt store.ts's own richer `RecordingStoreOutcomeV1` methods into Slice A's verbatim
 * `RecordingLifecycleEnvironmentV1` — the exact 4-method shape `StudioSkillEnvironmentV1`
 * and the native `takeCycleV1` handler consume. This is the ONLY place a
 * `RecordingStoreOutcomeV1` is narrowed down to the generic `{ok,state,say,changes}` /
 * `{ok,code,say}` contract shape; every other consumer (store tests, UI) reads the richer
 * shape directly.
 */
export function createRecordingLifecycleEnvironmentV1(deps: RecordingLifecycleStoreDepsV1): RecordingLifecycleEnvironmentV1 {
  return {
    start: async (bar) => toLifecycleResultV1(await deps.enterRecord(bar)),
    stop: async () => toLifecycleResultV1(await deps.stopRecord()),
    audition: async (delta) => toLifecycleResultV1(await deps.navTake(delta)),
    keep: async () => toLifecycleResultV1(await deps.keepTake()),
  };
}

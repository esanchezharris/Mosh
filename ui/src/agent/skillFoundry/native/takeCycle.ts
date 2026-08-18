// Skill Foundry Slice B, Task 2 — the native `capture-review-choose-take` handler
// (canonical id "capture-review-choose-take", handlerKey "takeCycleV1").
//
// Owns exactly one thing beyond what `RecordingLifecycleEnvironmentV1` (contracts.ts,
// Slice A verbatim) already provides: PREFLIGHT target resolution for `start`/`again`
// (the lifecycle environment's `start()` takes no target — something has to decide
// which track a bare "record" verb means before calling it), and the `again` guard that
// refuses to call `start()` at all while anything is still playing/recording. Every
// actual mutation (start/stop/audition/keep) is delegated to `environment.recording` —
// this module never calls `environment.exec` directly and never claims atomic rollback
// (spec 8.5: lifecycle mode "reports the observed state", no rollback concept).
//
// `slots.action` selects which of the six journey actions to run
// (start|stop|again|audition_next|audition_previous|keep) — the six-action enum spec
// 2.1's "may expose a small action enum rather than forcing every action into a
// separate package" describes for exactly this journey.

import type { Snapshot, Track } from "../../../types";
import type {
  NativeSkillHandlerV1,
  NativeSkillPayloadV1,
  RecordingLifecycleResultV1,
  SkillOutcomeV1,
  SkillReasonCodeV1,
  StudioSkillEnvironmentV1,
} from "../contracts";

export type TakeCycleActionV1 = "start" | "stop" | "again" | "audition_next" | "audition_previous" | "keep";

function blocked(payload: NativeSkillPayloadV1, code: SkillReasonCodeV1, say: string): SkillOutcomeV1 {
  return { kind: "blocked", skill: payload.id, version: payload.version, code, say, unserved: true };
}

function fromLifecycle(payload: NativeSkillPayloadV1, result: RecordingLifecycleResultV1): SkillOutcomeV1 {
  if (result.ok) {
    return { kind: "completed", skill: payload.id, version: payload.version, say: result.say, changes: result.changes };
  }
  return blocked(payload, result.code, result.say);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------
// Target resolution for start/again (spec: "resolve exactly one target: the sole armed
// track with hasInput===true, otherwise the selected hasInput===true track; never fall
// back to the first audio/first project track").
// ---------------------------------------------------------------------------------------

export type RecordTargetResolutionV1 =
  | { readonly kind: "resolved"; readonly trackId: string }
  | { readonly kind: "ambiguous_target" }
  | { readonly kind: "missing_target" }
  | { readonly kind: "observation_failed"; readonly reason: string };

function isInputCapable(track: Track): boolean {
  return track.hasInput === true;
}

export function resolveRecordTargetV1(snapshot: Snapshot, selectedTrackId: string | null): RecordTargetResolutionV1 {
  if (!Array.isArray(snapshot.tracks)) return { kind: "observation_failed", reason: "malformed snapshot: tracks is not an array" };

  const armedEligible = snapshot.tracks.filter((track) => track.armed === true && isInputCapable(track));
  if (armedEligible.length === 1) return { kind: "resolved", trackId: armedEligible[0]!.id };
  if (armedEligible.length > 1) return { kind: "ambiguous_target" };

  if (selectedTrackId) {
    const selected = snapshot.tracks.find((track) => track.id === selectedTrackId);
    if (selected && isInputCapable(selected)) return { kind: "resolved", trackId: selected.id };
  }

  return { kind: "missing_target" };
}

function reasonFromTargetResolution(
  payload: NativeSkillPayloadV1,
  resolution: Exclude<RecordTargetResolutionV1, { kind: "resolved" }>,
): SkillOutcomeV1 {
  switch (resolution.kind) {
    case "ambiguous_target":
      return blocked(payload, "ambiguous_target", "More than one track is armed and input-capable — arm just one.");
    case "missing_target":
      return blocked(payload, "missing_target", "No armed, input-capable track to record into.");
    case "observation_failed":
      return blocked(payload, "observation_failed", resolution.reason);
  }
}

async function observeSnapshot(environment: StudioSkillEnvironmentV1): Promise<Snapshot | null> {
  try {
    return await environment.snapshot();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Transport/controller stillness check for "again" (spec: before "again", require
// transport.playing===false, transport.recording===false, and
// controller.record!=="recording"; otherwise block WITHOUT calling start. "Again" never
// deletes a take or calls Undo — it only gates whether `start()` is even attempted).
// ---------------------------------------------------------------------------------------

function isStillEnoughToRecordAgain(snapshot: Snapshot): boolean {
  if (snapshot.transport.playing !== false || snapshot.transport.recording !== false) return false;
  const controllerRecord = snapshot.controller?.record;
  if (controllerRecord === "recording") return false;
  return true;
}

// ---------------------------------------------------------------------------------------
// Per-action runners
// ---------------------------------------------------------------------------------------

async function runStart(payload: NativeSkillPayloadV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  const snapshot = await observeSnapshot(environment);
  if (!snapshot) return blocked(payload, "observation_failed", "Could not read session state.");
  const resolution = resolveRecordTargetV1(snapshot, environment.context().selectedTrackId);
  if (resolution.kind !== "resolved") return reasonFromTargetResolution(payload, resolution);

  let result: RecordingLifecycleResultV1;
  try {
    result = await environment.recording.start();
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not start recording: ${detail(error)}.`);
  }
  return fromLifecycle(payload, result);
}

async function runAgain(payload: NativeSkillPayloadV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  const snapshot = await observeSnapshot(environment);
  if (!snapshot) return blocked(payload, "observation_failed", "Could not read session state.");
  if (!isStillEnoughToRecordAgain(snapshot)) {
    return blocked(payload, "stale_context", "Still playing or recording — stop first.");
  }
  return runStart(payload, environment);
}

async function runStop(payload: NativeSkillPayloadV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let result: RecordingLifecycleResultV1;
  try {
    result = await environment.recording.stop();
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not stop recording: ${detail(error)}.`);
  }
  return fromLifecycle(payload, result);
}

async function runAudition(
  payload: NativeSkillPayloadV1,
  environment: StudioSkillEnvironmentV1,
  delta: -1 | 1,
): Promise<SkillOutcomeV1> {
  let result: RecordingLifecycleResultV1;
  try {
    result = await environment.recording.audition(delta);
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not switch takes: ${detail(error)}.`);
  }
  return fromLifecycle(payload, result);
}

async function runKeep(payload: NativeSkillPayloadV1, environment: StudioSkillEnvironmentV1): Promise<SkillOutcomeV1> {
  let result: RecordingLifecycleResultV1;
  try {
    result = await environment.recording.keep();
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not keep the take: ${detail(error)}.`);
  }
  return fromLifecycle(payload, result);
}

// ---------------------------------------------------------------------------------------
// Handler entry point
// ---------------------------------------------------------------------------------------

export const takeCycleV1: NativeSkillHandlerV1 = async ({ payload, environment, slots }) => {
  const action = slots.action;
  if (typeof action !== "string") {
    return blocked(payload, "missing_slot", "Which take-cycle action? (start/stop/again/audition_next/audition_previous/keep)");
  }

  switch (action as TakeCycleActionV1) {
    case "start": return runStart(payload, environment);
    case "again": return runAgain(payload, environment);
    case "stop": return runStop(payload, environment);
    case "audition_next": return runAudition(payload, environment, 1);
    case "audition_previous": return runAudition(payload, environment, -1);
    case "keep": return runKeep(payload, environment);
    default:
      return blocked(payload, "invalid_slot", `Unknown take-cycle action: ${action}`);
  }
};

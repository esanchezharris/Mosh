// Skill Foundry Slice B, Task 4 — the native `explicit-balance` handler (canonical id
// "explicit-balance", handlerKey "explicitBalanceV1").
//
// Owns four EXPLICIT mutations — set_level, mute, unmute, solo — over a single track
// resolved either from the current selection or a normalized exact name (reusing
// primitives.ts's `runResolverV1`/`selected_track`/`track_by_unique_name`, the SAME
// resolvers an owner-local manifest would use; this module never re-derives a second
// name-matching rule). Every mutation runs through `atomicPlan.ts`'s
// `runAtomicSkillPlanV1` — never the legacy static-catalog `runSkill` — with a real
// `guard(phase, context)` that re-checks project epoch, target existence, and source
// status on BOTH the before_begin and before_commit checkpoints (spec 8.5's two-guard
// protocol). Ambiguity (more than one exact-name match, up to the 5-choice cap) issues a
// single-use continuation from a private, module-scoped `ContinuationStoreV1` — this
// journey's only continuation traffic, never shared with any other native handler.
//
// Vague requests ("mix this", "make it sound professional") are UNSUPPORTED, not
// misinterpreted as an explicit level: this module only ever recognizes a REQUIRED,
// already-validated numeric `db` slot for set_level, and boolean intent for
// mute/unmute/solo — there is no fuzzy taste inference here to weaken.

import type { Snapshot } from "../../../types";
import { trackVolumeReachedV1 } from "../../skills";
import type { SkillCheck } from "../../skills";
import {
  runAtomicSkillPlanV1,
  type AtomicSkillGuardContextV1,
  type AtomicSkillGuardPhaseV1,
  type AtomicSkillPlanDepsV1,
  type AtomicSkillPlanV1,
} from "../atomicPlan";
import { createContinuationStoreV1 } from "../continuations";
import { runResolverV1 } from "../primitives";
import type {
  ContinuationChoiceValueV1,
  ContinuationPayloadV1,
  ContinuationStoreV1,
  NativeSkillHandlerV1,
  NativeSkillPayloadV1,
  ResolvedTargetIdentityV1,
  SkillChoiceV1,
  SkillOutcomeV1,
  SkillReasonCodeV1,
  SlotValueV1,
  StudioSkillEnvironmentV1,
} from "../contracts";

export type ExplicitBalanceActionV1 = "set_level" | "mute" | "unmute" | "solo";

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function blocked(payload: NativeSkillPayloadV1, code: SkillReasonCodeV1, say: string): SkillOutcomeV1 {
  return { kind: "blocked", skill: payload.id, version: payload.version, code, say, unserved: true };
}

// ---------------------------------------------------------------------------------------
// Source-status snapshot (generation + digest), read once before planning and re-read by
// both guard checkpoints.
// ---------------------------------------------------------------------------------------

type SourceStatusSnapshotV1 = { readonly generation: number; readonly digest: string };

async function readSourceStatusSnapshotV1(environment: StudioSkillEnvironmentV1): Promise<SourceStatusSnapshotV1 | null> {
  let read;
  try {
    read = await environment.readSourceStatus();
  } catch {
    return null;
  }
  if (!read.ok) return null;
  if (read.statusIndex === null) return { generation: 0, digest: "" };
  let generation = 0;
  try {
    const parsed: unknown = JSON.parse(read.statusIndex.utf8);
    if (isRecord(parsed) && typeof parsed.generation === "number") generation = parsed.generation;
  } catch {
    return null;
  }
  return { generation, digest: read.statusIndex.sha256 };
}

// ---------------------------------------------------------------------------------------
// Private continuation store — this handler's only user. A fresh store per module
// instance (matches Slice A's own doc comment: "a fresh store is created per skill
// runtime and cleared on project replacement or registry regeneration").
// ---------------------------------------------------------------------------------------

const explicitBalanceContinuations: ContinuationStoreV1 = createContinuationStoreV1();

/** Exposed for the runtime (Task 6/7) to clear alongside every other continuation store
 *  on project replacement — mirrors `clearStudioSkillContinuations()`'s own purpose. */
export function clearExplicitBalanceContinuationsV1(): void {
  explicitBalanceContinuations.clear();
}

// ---------------------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------------------

type TargetResolutionV1 =
  | { readonly kind: "resolved"; readonly trackId: string }
  | { readonly kind: "needs_choice"; readonly candidates: readonly ContinuationChoiceValueV1[] }
  | { readonly kind: "missing_target" }
  | { readonly kind: "ambiguous_target"; readonly count: number }
  | { readonly kind: "observation_failed"; readonly reason: string };

async function resolveTargetV1(
  before: Snapshot,
  environment: StudioSkillEnvironmentV1,
  trackName: string | undefined,
): Promise<TargetResolutionV1> {
  const context = environment.context();
  const outcome = trackName
    ? await runResolverV1("track_by_unique_name", { name: trackName }, before, context, environment, 5)
    : await runResolverV1("selected_track", {}, before, context, environment, 5);

  if (outcome.kind === "resolved") return { kind: "resolved", trackId: outcome.entityId };
  if (outcome.kind === "none") return { kind: "missing_target" };
  if (outcome.kind === "too_many") return { kind: "ambiguous_target", count: outcome.count };
  if (outcome.kind === "failed") return { kind: "observation_failed", reason: outcome.reason };
  // "choices" — bounded (<=5 by construction, runResolverV1's own cap) ambiguity.
  const candidates: ContinuationChoiceValueV1[] = outcome.candidates.map((candidate, index) => ({
    id: String(index + 1), label: candidate.label, value: candidate.entityId,
  }));
  return { kind: "needs_choice", candidates };
}

function reasonFromTargetResolution(
  payload: NativeSkillPayloadV1,
  resolution: Exclude<TargetResolutionV1, { kind: "resolved" } | { kind: "needs_choice" }>,
): SkillOutcomeV1 {
  switch (resolution.kind) {
    case "missing_target":
      return blocked(payload, "missing_target", "No selected or uniquely named track to adjust.");
    case "ambiguous_target":
      return blocked(payload, "ambiguous_target", `${resolution.count} tracks share that name — rename one or select it directly.`);
    case "observation_failed":
      return blocked(payload, "observation_failed", resolution.reason);
  }
}

// ---------------------------------------------------------------------------------------
// Action -> mutation command
// ---------------------------------------------------------------------------------------

type PlannedMutationV1 = {
  readonly command: "set_track_volume" | "set_track_mute" | "set_track_solo";
  readonly args: Readonly<Record<string, SlotValueV1>>;
  readonly verify: (after: Snapshot, trackId: string) => SkillCheck;
};

function trackMuteEqualsV1(after: Snapshot, trackId: string, expected: boolean): SkillCheck {
  const track = after.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return { ok: false, reason: `Track "${trackId}" was not preserved.` };
  const actual = track.mute ?? false;
  return actual === expected ? { ok: true } : { ok: false, reason: `Track "${trackId}" did not reach mute:${expected}.` };
}

function trackSoloEqualsV1(after: Snapshot, trackId: string, expected: boolean): SkillCheck {
  const track = after.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return { ok: false, reason: `Track "${trackId}" was not preserved.` };
  const actual = track.solo ?? false;
  return actual === expected ? { ok: true } : { ok: false, reason: `Track "${trackId}" did not reach solo:${expected}.` };
}

function planMutationV1(action: ExplicitBalanceActionV1, trackId: string, db: number | undefined): PlannedMutationV1 | null {
  switch (action) {
    case "set_level":
      if (typeof db !== "number" || !Number.isFinite(db) || db < -60 || db > 6) return null;
      return {
        command: "set_track_volume",
        args: { trackId, db },
        verify: (after) => trackVolumeReachedV1(after, trackId, db),
      };
    case "mute":
      return { command: "set_track_mute", args: { trackId, mute: true }, verify: (after) => trackMuteEqualsV1(after, trackId, true) };
    case "unmute":
      return { command: "set_track_mute", args: { trackId, mute: false }, verify: (after) => trackMuteEqualsV1(after, trackId, false) };
    case "solo":
      return { command: "set_track_solo", args: { trackId, solo: true }, verify: (after) => trackSoloEqualsV1(after, trackId, true) };
  }
}

// ---------------------------------------------------------------------------------------
// Atomic execution
// ---------------------------------------------------------------------------------------

function defaultNewId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function runAtomicallyV1(
  payload: NativeSkillPayloadV1,
  environment: StudioSkillEnvironmentV1,
  before: Snapshot,
  trackId: string,
  mutation: PlannedMutationV1,
  epochAtStart: number,
  sourceAtStart: SourceStatusSnapshotV1,
): Promise<SkillOutcomeV1> {
  const newId = environment.newId ?? defaultNewId;
  const transactionId = newId();
  const requestId = newId();
  const steps = [{ call: { command: mutation.command, args: mutation.args }, meta: { transactionId, requestId, index: 0 } }];
  const transaction = {
    transactionId,
    name: payload.id,
    manifest: [{ index: 0, requestId, command: mutation.command }],
    steps,
  };

  let reasonCode: SkillReasonCodeV1 | null = null;

  const guard: AtomicSkillPlanDepsV1["guard"] = async (
    _phase: AtomicSkillGuardPhaseV1,
    context: AtomicSkillGuardContextV1,
  ) => {
    if (environment.context().projectEpoch !== epochAtStart) {
      reasonCode = "manifest_stale";
      return { ok: false, reason: "the project changed" };
    }
    const snap = context.after ?? context.before;
    if (!snap.tracks.some((track) => track.id === trackId)) {
      reasonCode = "stale_context";
      return { ok: false, reason: `track ${trackId} no longer exists` };
    }
    const source = await readSourceStatusSnapshotV1(environment);
    if (!source) {
      reasonCode = "observation_failed";
      return { ok: false, reason: "could not verify source status" };
    }
    if (source.generation !== sourceAtStart.generation || source.digest !== sourceAtStart.digest) {
      reasonCode = "manifest_stale";
      return { ok: false, reason: "source status changed" };
    }
    return { ok: true };
  };

  const plan: AtomicSkillPlanV1 = {
    skill: payload.id,
    version: payload.version,
    slots: mutation.args as Readonly<Record<string, string | number | boolean>>,
    before,
    transaction,
    verifyPostcondition: (_before, after) => mutation.verify(after, trackId),
  };

  const result = await runAtomicSkillPlanV1(plan, { snapshot: environment.snapshot, exec: environment.exec, guard });

  if (result.ok) {
    return { kind: "completed", skill: payload.id, version: payload.version, say: payload.responses.completed, changes: null };
  }

  const unserved = result.outcome === "no_edit";
  let code: SkillReasonCodeV1;
  if (reasonCode) code = reasonCode;
  else if (result.outcome === "needs_recovery") code = "rollback_failed";
  else if (result.stage === "postcondition") code = "postcondition_failed";
  else code = "command_failed";

  return { kind: "blocked", skill: payload.id, version: payload.version, code, say: payload.responses.blocked, unserved };
}

// ---------------------------------------------------------------------------------------
// Continuation issue/resume
// ---------------------------------------------------------------------------------------

function matchChoiceReply(reply: string, choices: readonly ContinuationChoiceValueV1[]): ContinuationChoiceValueV1 | null {
  const normalized = reply.trim().toLowerCase();
  return choices.find((choice) => choice.id.toLowerCase() === normalized || choice.label.toLowerCase() === normalized) ?? null;
}

async function issueChoiceV1(
  payload: NativeSkillPayloadV1,
  environment: StudioSkillEnvironmentV1,
  candidates: readonly ContinuationChoiceValueV1[],
  action: ExplicitBalanceActionV1,
  db: number | undefined,
): Promise<SkillOutcomeV1> {
  // Stamped with the continuation STORE's own clock (real wall-clock — `explicitBalanceContinuations`
  // is a module-level singleton created with no injected `now`), never `environment.nowMs()`: the
  // store's own `issue()` validates `expiresAtMs` against ITS clock, so stamping with a different
  // clock (e.g. a test's injected `environment.nowMs()`) would spuriously fail that validation.
  const nowMs = Date.now();
  const targetIdentities: readonly ResolvedTargetIdentityV1[] = [];
  const payloadRecord: ContinuationPayloadV1 = {
    skillId: payload.id,
    version: payload.version,
    artifactSha256: payload.compatibility.nativeSourceSha256,
    choices: candidates,
    targetIdentities,
    projectEpoch: environment.context().projectEpoch,
    registryGeneration: 0,
    sourceStatusGeneration: 0,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + 600_000,
    attempts: 0,
    pendingKind: "choice",
    pendingSlot: "trackName",
    choiceReason: "ambiguity",
  };
  // The chosen action/db are not part of ContinuationPayloadBaseV1 (Slice A's frozen
  // shape) — stash them in an out-of-band side map keyed by token instead of widening
  // that frozen contract. See `pendingActionByToken` below.
  const issued = explicitBalanceContinuations.issue(payloadRecord);
  if (!issued.ok) return blocked(payload, "provider_unavailable", payload.responses.blocked);
  pendingActionByToken.set(issued.token, { action, db });
  const options: readonly SkillChoiceV1[] = candidates.map((choice) => ({ id: choice.id, label: choice.label }));
  return {
    kind: "needs_choice", skill: payload.id, version: payload.version, say: payload.responses.needsChoice,
    options, continuationToken: issued.token,
  };
}

/** DESIGN DECISION: `ContinuationPayloadV1` (Slice A, frozen) has no field for "which
 *  action/value was pending" — it was designed for the declarative executor, where the
 *  manifest itself supplies that context on resume. A native handler has no manifest to
 *  re-read, so the pending action/db is kept in this small side table, keyed by the same
 *  single-use token the continuation store already enforces uniqueness/expiry for. */
const pendingActionByToken = new Map<string, { readonly action: ExplicitBalanceActionV1; readonly db: number | undefined }>();

// ---------------------------------------------------------------------------------------
// Handler entry point
// ---------------------------------------------------------------------------------------

export const explicitBalanceV1: NativeSkillHandlerV1 = async ({ payload, environment, utterance, slots, continuationToken }) => {
  if (continuationToken) {
    // Same real-clock discipline as issueChoiceV1 — the store's own clock, not
    // environment.nowMs() (see that function's comment).
    const taken = explicitBalanceContinuations.take(continuationToken, Date.now());
    if (!taken.ok) return blocked(payload, "stale_context", "That choice has expired — ask again.");
    const pending = pendingActionByToken.get(continuationToken);
    pendingActionByToken.delete(continuationToken);
    if (!pending || taken.payload.skillId !== payload.id || taken.payload.artifactSha256 !== payload.compatibility.nativeSourceSha256) {
      return blocked(payload, "stale_context", "That choice is no longer valid — ask again.");
    }
    // The reply text is the resuming utterance itself unless a caller supplies a distinct
    // `slots.reply` — mirrors loadNamedPlugin.ts's own resume fallback, since the runtime
    // (runtime.ts) dispatches a resume as `handler({..., utterance: <reply text>, slots: {}, continuationToken})`.
    const replyText = typeof slots.reply === "string" ? slots.reply : utterance;
    const chosen = matchChoiceReply(replyText, taken.payload.choices);
    if (!chosen) return blocked(payload, "invalid_slot", "That wasn't one of the options — ask again.");

    let before: Snapshot;
    try {
      before = await environment.snapshot();
    } catch (error) {
      return blocked(payload, "observation_failed", `Could not read session state: ${detail(error)}.`);
    }
    if (environment.context().projectEpoch !== taken.payload.projectEpoch) {
      return blocked(payload, "stale_context", "The project changed — ask again.");
    }
    const trackId = String(chosen.value);
    if (!before.tracks.some((track) => track.id === trackId)) {
      return blocked(payload, "stale_context", "That track no longer exists — ask again.");
    }
    const mutation = planMutationV1(pending.action, trackId, pending.db);
    if (!mutation) return blocked(payload, "invalid_slot", "That level is out of range (-60..+6 dB).");
    const sourceAtStart = await readSourceStatusSnapshotV1(environment);
    if (!sourceAtStart) return blocked(payload, "observation_failed", "Could not verify source status.");
    return runAtomicallyV1(payload, environment, before, trackId, mutation, environment.context().projectEpoch, sourceAtStart);
  }

  const action = slots.action;
  if (typeof action !== "string" || !["set_level", "mute", "unmute", "solo"].includes(action)) {
    // Vague/unrecognized asks ("mix this", "make it sound professional") land here —
    // never a fuzzy guess at a level or target.
    return blocked(payload, "unsupported_intent", payload.responses.blocked);
  }
  const db = typeof slots.db === "number" ? slots.db : undefined;
  const trackName = typeof slots.trackName === "string" ? slots.trackName : undefined;

  let before: Snapshot;
  try {
    before = await environment.snapshot();
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not read session state: ${detail(error)}.`);
  }
  const epochAtStart = environment.context().projectEpoch;

  const resolution = await resolveTargetV1(before, environment, trackName);
  if (resolution.kind === "needs_choice") {
    return issueChoiceV1(payload, environment, resolution.candidates, action as ExplicitBalanceActionV1, db);
  }
  if (resolution.kind !== "resolved") return reasonFromTargetResolution(payload, resolution);

  const mutation = planMutationV1(action as ExplicitBalanceActionV1, resolution.trackId, db);
  if (!mutation) return blocked(payload, "invalid_slot", "That level is out of range (-60..+6 dB).");

  const sourceAtStart = await readSourceStatusSnapshotV1(environment);
  if (!sourceAtStart) return blocked(payload, "observation_failed", "Could not verify source status.");

  return runAtomicallyV1(payload, environment, before, resolution.trackId, mutation, epochAtStart, sourceAtStart);
};

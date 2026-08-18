// Task 8 — the atomic declarative executor: the seven-phase runtime that turns one already
// VALIDATED owner-local manifest (`ValidatedDeclarativeSkillV1`, Task 3) plus filled-in slot
// values into either a committed engine transaction or a typed, non-mutating refusal.
//
// Phase order (plan Task 8 Step 2), load-bearing:
//   slots -> before snapshot -> observations/resolvers -> preconditions -> expansion ->
//   confirmation gate -> before_begin -> begin -> each mutation once -> status ->
//   after snapshot -> postconditions -> before_commit -> end
//
// Everything through "expansion" is PURE PLANNING: no bridge mutation, only reads (snapshot,
// list_plugins, source-status). "confirmation gate" may PAUSE the whole run behind a typed,
// digest-bound continuation (Task 6) with ZERO bridge mutations. Only past that gate does
// this module hand a plan to `atomicPlan.ts`'s `runAtomicSkillPlanV1` — the trusted runner
// that owns `batch_begin`/execution/`batch_end`/rollback ordering. This module never
// reimplements that ordering; it only supplies the plan and the two guard checkpoints.

import type { Snapshot, Track } from "../../types";
import type { AgentCommandCall, ChangeSet } from "../executor";
import type { SkillCheck, SkillExecutionSummary } from "../skills";
import type { StudioContext } from "../studioSkills";
import { runAtomicSkillPlanV1, type AtomicSkillGuardContextV1, type AtomicSkillGuardPhaseV1, type AtomicSkillPlanDepsV1, type AtomicSkillPlanV1 } from "./atomicPlan";
import { canonicalJsonBytes, sha256Bytes } from "./hash";
import { FOUNDRY_LIMITS_V1, SKILL_LIMITS_V1 } from "./limits";
import { validateSourceStatusForInvocationV1 } from "./packageValidation";
import type { ValidatedDeclarativeSkillV1 } from "./packageValidation";
import {
  evaluatePredicateV1,
  RESOLVER_ROLE_V1,
  runObservationV1,
  runResolverV1,
  type PredicateNameV1,
  type ResolvedRoleV1,
  type ResolverNameV1,
} from "./primitives";
import type {
  ContinuationChoiceValueV1,
  ContinuationPayloadBaseV1,
  ContinuationPayloadV1,
  ContinuationStoreV1,
  ResolvedTargetIdentityV1,
  SkillChoiceV1,
  SkillManifestV1,
  SkillOutcomeV1,
  SkillReasonCodeV1,
  SkillSlotV1,
  SlotValueV1,
  StudioSkillEnvironmentV1,
  ValueRefV1,
} from "./contracts";

// ---------------------------------------------------------------------------------------
// Public input/output
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: `DeclarativeExecutionInputV1` is not given an exact shape anywhere — only
// `executeDeclarativeSkillV1(input: DeclarativeExecutionInputV1): Promise<SkillOutcomeV1>` is
// named (this task's "Produces" line). Modeled to carry exactly what one call needs: the
// already-validated skill (Task 3's chain check happened at LOAD time, not per-invocation —
// this module never re-verifies hashes), the raw utterance-extracted slot values (Slice B's
// job to extract NL -> values; this task only consumes already-filled-in values), the
// environment/continuation seams Task 1/6 already froze, `registryGeneration` supplied by the
// caller (this slice has no live registry — see the guard's own comment below for why that is
// still a meaningful check), and an optional `continuationToken`/`reply` pair for resuming a
// paused run. `newId`/`nowMs` mirror `StudioSkillEnvironmentV1`'s own optional injection
// points (Cross-Slice APIs block) for deterministic tests.
export type DeclarativeExecutionInputV1 = {
  readonly skill: ValidatedDeclarativeSkillV1;
  readonly utteranceSlots: Readonly<Record<string, unknown>>;
  readonly environment: StudioSkillEnvironmentV1;
  readonly continuations: ContinuationStoreV1;
  readonly registryGeneration: number;
  readonly continuationToken?: string;
  readonly reply?: string;
  readonly newId?: () => string;
  readonly nowMs?: () => number;
};

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultNewId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------------------
// Reason-code mapping helpers
// ---------------------------------------------------------------------------------------

/** DESIGN DECISION: `SkillReasonCodeV1` (Task 1) has no dedicated "precondition failed" code
 *  — only `postcondition_failed`. Each closed predicate is mapped to the closest applicable
 *  code when it fails as a PREcondition; a POSTcondition failure of ANY predicate always maps
 *  to `postcondition_failed` (matching `skillHarness.ts`'s existing `SkillFailureStage`
 *  convention, where "postcondition" is one stage regardless of which check tripped it). */
function preconditionReasonCode(name: PredicateNameV1): SkillReasonCodeV1 {
  switch (name) {
    case "not_recording":
    case "project_epoch_unchanged":
    case "selected_track_is": return "stale_context";
    case "track_exists": return "missing_target";
    case "track_volume_equals":
    case "track_mute_equals":
    case "track_solo_equals": return "invalid_slot";
    case "plugin_instance_added_once": return "postcondition_failed";
    default: return "unsupported_intent";
  }
}

function reasonFor(manifest: SkillManifestV1, skillId: string, code: SkillReasonCodeV1): SkillOutcomeV1 {
  return { kind: "blocked", skill: skillId, version: manifest.version, code, say: manifest.responses.blocked, unserved: true };
}

// ---------------------------------------------------------------------------------------
// ValueRefV1 resolution — the ONE place a typed reference becomes a plain runtime value.
// No interpolation: every source is either a literal already type-checked at manifest-parse
// time, a filled slot, a fixed context key, or a prior step's bound entity ID.
// ---------------------------------------------------------------------------------------

type RefScopeV1 = {
  readonly slots: Readonly<Record<string, SlotValueV1>>;
  readonly context: StudioContext;
  readonly binds: Readonly<Record<string, string>>;
};

type RefResolutionV1 = { readonly ok: true; readonly value: SlotValueV1 } | { readonly ok: false; readonly reason: string };

function resolveRefV1(ref: ValueRefV1, scope: RefScopeV1): RefResolutionV1 {
  if ("literal" in ref) return { ok: true, value: ref.literal };
  if ("slot" in ref) {
    const value = scope.slots[ref.slot];
    if (value === undefined) return { ok: false, reason: `unresolved slot "${ref.slot}"` };
    return { ok: true, value };
  }
  if ("context" in ref) {
    if (ref.context === "selectedTrackId") {
      if (scope.context.selectedTrackId === null) return { ok: false, reason: "no track is selected" };
      return { ok: true, value: scope.context.selectedTrackId };
    }
    return { ok: true, value: scope.context.projectEpoch };
  }
  if ("binding" in ref) {
    const value = scope.binds[ref.binding];
    if (value === undefined) return { ok: false, reason: `unresolved binding "${ref.binding}"` };
    return { ok: true, value };
  }
  // `each` — structurally accepted by contracts.ts but reachable by NO V1 primitive argument
  // (validate.ts's own DESIGN DECISION on this same point: no `allowedSources` in
  // `OWNER_PRIMITIVES_V1`/`OWNER_PREDICATES_V1` ever includes "each"). An already-validated
  // manifest can therefore never produce this branch; it exists only so this function is
  // total over `ValueRefV1`, and fails closed rather than throwing if it ever were reached.
  return { ok: false, reason: "each is not resolvable by any V1 primitive argument" };
}

function resolveArgsV1(
  args: Readonly<Record<string, ValueRefV1>>,
  scope: RefScopeV1,
): { readonly ok: true; readonly values: Readonly<Record<string, SlotValueV1>> } | { readonly ok: false; readonly reason: string } {
  const values: Record<string, SlotValueV1> = {};
  for (const [name, ref] of Object.entries(args)) {
    const resolved = resolveRefV1(ref, scope);
    if (!resolved.ok) return resolved;
    values[name] = resolved.value;
  }
  return { ok: true, values };
}

// ---------------------------------------------------------------------------------------
// Slot filling
// ---------------------------------------------------------------------------------------

type SlotFillResultV1 =
  | { readonly kind: "ok"; readonly slots: Readonly<Record<string, SlotValueV1>> }
  | { readonly kind: "blocked"; readonly code: SkillReasonCodeV1; readonly reason: string }
  | { readonly kind: "needs_choice"; readonly pendingSlot: string; readonly candidates: readonly ContinuationChoiceValueV1[] };

function unicodeLength(text: string): number {
  return [...text].length;
}

function isValidSlotValue(slot: SkillSlotV1, value: unknown): value is SlotValueV1 {
  if (slot.type === "string") return typeof value === "string" && unicodeLength(value) <= FOUNDRY_LIMITS_V1.stringSlotChars;
  if (slot.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (slot.minimum !== undefined && value < slot.minimum) return false;
    if (slot.maximum !== undefined && value > slot.maximum) return false;
    return true;
  }
  if (slot.type === "boolean") return typeof value === "boolean";
  if (slot.type === "enum") return typeof value === "string" && (slot.enumValues ?? []).includes(value);
  // "string[]"
  if (!Array.isArray(value) || value.length > FOUNDRY_LIMITS_V1.listSlotItems) return false;
  if (slot.minItems !== undefined && value.length < slot.minItems) return false;
  if (slot.maxItems !== undefined && value.length > slot.maxItems) return false;
  return value.every((item) => typeof item === "string" && unicodeLength(item) <= FOUNDRY_LIMITS_V1.stringSlotChars);
}

/**
 * DESIGN DECISION: a required slot with no default and no supplied value can only become a
 * `needs_choice` continuation when it has a SMALL, closed, enumerable domain that fits inside
 * `SKILL_LIMITS_V1.choices` (5): an `enum` slot with at most 5 values, or a `boolean` slot
 * (offered as exactly 2 options). Nothing else in the grammar bounds a free-form `string`/
 * `number`/`string[]` slot's domain, so there is no safe finite choice set to offer for one —
 * it fails closed as `blocked/missing_slot` instead of fabricating a continuation with no real
 * options. This is the same "do not exercise a path the closed catalog cannot honestly reach"
 * discipline `validate.ts` already applied to the `each` `ValueRefV1` discriminant.
 */
function missingSlotChoice(slot: SkillSlotV1): readonly ContinuationChoiceValueV1[] | null {
  if (slot.type === "enum" && (slot.enumValues?.length ?? 0) > 0 && (slot.enumValues?.length ?? 0) <= SKILL_LIMITS_V1.choices) {
    return slot.enumValues!.map((value, index) => ({ id: String(index + 1), label: value, value }));
  }
  if (slot.type === "boolean") {
    return [{ id: "1", label: "yes", value: true }, { id: "2", label: "no", value: false }];
  }
  return null;
}

function fillSlotsV1(manifest: SkillManifestV1, utteranceSlots: Readonly<Record<string, unknown>>): SlotFillResultV1 {
  const slots: Record<string, SlotValueV1> = {};
  for (const slot of manifest.slots) {
    const raw = utteranceSlots[slot.name];
    if (raw !== undefined) {
      if (!isValidSlotValue(slot, raw)) {
        return { kind: "blocked", code: "invalid_slot", reason: `slot "${slot.name}" is invalid` };
      }
      slots[slot.name] = raw;
      continue;
    }
    if (slot.default !== undefined) {
      slots[slot.name] = slot.default;
      continue;
    }
    if (!slot.required) continue;
    const choice = missingSlotChoice(slot);
    if (choice) return { kind: "needs_choice", pendingSlot: slot.name, candidates: choice };
    return { kind: "blocked", code: "missing_slot", reason: `slot "${slot.name}" is required` };
  }
  return { kind: "ok", slots };
}

// ---------------------------------------------------------------------------------------
// Target overrides — supplied on a continuation resume, either because the user just chose
// among ambiguous candidates or because a confirmation payload already carries the exact
// targets resolved before it was issued. Skips the resolver call for that role and instead
// verifies the chosen entity still exists in the current snapshot/catalog.
// ---------------------------------------------------------------------------------------

type TargetOverridesV1 = Readonly<Partial<Record<ResolvedRoleV1, string>>>;

async function overrideStillExists(
  role: ResolvedRoleV1,
  entityId: string,
  before: Snapshot,
  environment: StudioSkillEnvironmentV1,
): Promise<boolean> {
  if (role === "trackId") return before.tracks.some((track: Track) => track.id === entityId);
  const observed = await runObservationV1("list_plugins", before, environment);
  if (!observed.ok) return false;
  return (observed.value as { readonly id: string }[]).some((plugin) => plugin.id === entityId);
}

// ---------------------------------------------------------------------------------------
// Preflight — everything through "expansion". No mutation, only reads.
// ---------------------------------------------------------------------------------------

type TargetResolutionV1 = { readonly resolver: ResolverNameV1; readonly input: { readonly name?: string } };

type PreflightOkV1 = {
  readonly kind: "ok";
  readonly before: Snapshot;
  readonly context: StudioContext;
  readonly slots: Readonly<Record<string, SlotValueV1>>;
  readonly binds: Readonly<Record<string, string>>;
  readonly targetIdentities: readonly ResolvedTargetIdentityV1[];
  readonly targetResolutions: Readonly<Partial<Record<ResolvedRoleV1, TargetResolutionV1>>>;
  readonly mutationCalls: readonly AgentCommandCall[];
  readonly sourceStatusGeneration: number;
};

type PreflightResultV1 =
  | PreflightOkV1
  | { readonly kind: "blocked"; readonly code: SkillReasonCodeV1; readonly reason: string }
  | {
      readonly kind: "needs_choice";
      readonly pendingSlot: string;
      readonly choiceReason: "ambiguity" | "missing_slot";
      readonly candidates: readonly ContinuationChoiceValueV1[];
      // Populated only for an "ambiguity" pause, which happens after the before-snapshot/
      // context/source-status reads — a "missing_slot" pause happens before any of that (the
      // slots phase runs first), so there is honestly nothing yet to report; left undefined
      // rather than a misleading placeholder like `projectEpoch: 0`.
      readonly partial?: {
        readonly projectEpoch: number;
        readonly sourceStatusGeneration: number;
        readonly targetIdentities: readonly ResolvedTargetIdentityV1[];
      };
    };

async function runPreflightV1(
  manifest: SkillManifestV1,
  utteranceSlots: Readonly<Record<string, unknown>>,
  environment: StudioSkillEnvironmentV1,
  overrides: TargetOverridesV1,
): Promise<PreflightResultV1> {
  // ── PHASE: slots ──
  const filled = fillSlotsV1(manifest, utteranceSlots);
  if (filled.kind === "blocked") return { kind: "blocked", code: filled.code, reason: filled.reason };
  if (filled.kind === "needs_choice") {
    return { kind: "needs_choice", pendingSlot: filled.pendingSlot, choiceReason: "missing_slot", candidates: filled.candidates };
  }
  const slots = filled.slots;

  // ── PHASE: before snapshot ──
  let before: Snapshot;
  try {
    before = await environment.snapshot();
  } catch (error) {
    return { kind: "blocked", code: "observation_failed", reason: `could not read session state: ${detail(error)}` };
  }
  const context = environment.context();

  // Source-status admission (spec 6.2): read once here so a stale/superseded/revoked source
  // fails BEFORE any resolver/mutation work, and so `sourceStatusGeneration` is available for
  // the continuation payload / guard drift comparisons below.
  let sourceStatusGeneration = 0;
  try {
    const statusRead = await environment.readSourceStatus();
    let freshIndex: unknown = null;
    if (statusRead.statusIndex) {
      try {
        freshIndex = JSON.parse(statusRead.statusIndex.utf8);
      } catch {
        freshIndex = null;
      }
      if (isRecord(freshIndex) && typeof freshIndex.generation === "number") sourceStatusGeneration = freshIndex.generation;
    }
    const sourceCheck = validateSourceStatusForInvocationV1({ provenance: manifest.provenance, freshIndex, nowMs: Date.now() });
    if (!sourceCheck.ok) {
      const code: SkillReasonCodeV1 = sourceCheck.code === "missing_index" || sourceCheck.code === "malformed_index"
        ? "observation_failed" : "manifest_stale";
      return { kind: "blocked", code, reason: sourceCheck.message };
    }
  } catch (error) {
    return { kind: "blocked", code: "observation_failed", reason: `could not read source status: ${detail(error)}` };
  }

  // ── PHASE: observations/resolvers ──
  const binds: Record<string, string> = {};
  const targetIdentities: ResolvedTargetIdentityV1[] = [];
  const targetResolutions: Partial<Record<ResolvedRoleV1, TargetResolutionV1>> = {};
  let preflightCallCount = 0;

  for (const step of manifest.steps) {
    if (step.kind === "observe") {
      preflightCallCount += 1;
      if (preflightCallCount > FOUNDRY_LIMITS_V1.expandedPreflightCalls) {
        return { kind: "blocked", code: "invalid_slot", reason: "too many preflight observation/resolver calls" };
      }
      const outcome = await runObservationV1(step.command as "current_snapshot" | "list_plugins", before, environment);
      if (!outcome.ok) return { kind: "blocked", code: "observation_failed", reason: outcome.reason };
      // Observation binds are not entity IDs; they are not consumed by any V1 argument
      // (`allowedSources` never includes a route from an observe bind into a mutation arg),
      // so nothing further needs to happen with the value here beyond having attempted it —
      // it exists for the manifest author's precondition-authoring symmetry with `resolve`.
      continue;
    }
    if (step.kind !== "resolve") continue; // "mutate" steps are handled in the expansion phase below

    preflightCallCount += 1;
    if (preflightCallCount > FOUNDRY_LIMITS_V1.expandedPreflightCalls) {
      return { kind: "blocked", code: "invalid_slot", reason: "too many preflight observation/resolver calls" };
    }
    const resolverName = step.resolver as ResolverNameV1;
    const role = RESOLVER_ROLE_V1[resolverName];
    const override = overrides[role];

    // Resolve the step's own search input (if any) REGARDLESS of whether an override applies
    // — an override still needs `input.name` recorded in `targetResolutions` so the
    // before_begin/before_commit guard can re-run the SAME name-based resolver later (a
    // rename must still be catchable even for a role the user just disambiguated). Without
    // this, a resumed-after-choice role would only ever be guard-checked by bare existence,
    // silently missing a rename to a DIFFERENT still-existing entity.
    let inputName: string | undefined;
    if (step.input !== undefined) {
      const resolved = resolveRefV1(step.input, { slots, context, binds });
      if (!resolved.ok) return { kind: "blocked", code: "invalid_slot", reason: resolved.reason };
      if (typeof resolved.value !== "string") return { kind: "blocked", code: "invalid_slot", reason: "resolver input must be a string" };
      inputName = resolved.value;
    }

    if (override !== undefined) {
      const stillExists = await overrideStillExists(role, override, before, environment);
      if (!stillExists) return { kind: "blocked", code: "stale_context", reason: `the previously chosen ${role} no longer exists` };
      binds[step.bind] = override;
      targetIdentities.push({ role, entityKind: role === "trackId" ? "track" : "plugin", entityId: override });
      targetResolutions[role] = { resolver: resolverName, input: inputName !== undefined ? { name: inputName } : {} };
      continue;
    }

    const outcome = await runResolverV1(resolverName, { name: inputName }, before, context, environment, step.maxChoices);
    if (outcome.kind === "none") return { kind: "blocked", code: "missing_target", reason: `no ${role} matched` };
    if (outcome.kind === "too_many") return { kind: "blocked", code: "ambiguous_target", reason: `too many ${role} candidates matched (${outcome.count})` };
    if (outcome.kind === "failed") return { kind: "blocked", code: "observation_failed", reason: outcome.reason };
    if (outcome.kind === "choices") {
      const candidates: ContinuationChoiceValueV1[] = outcome.candidates.map((candidate, index) => ({
        id: String(index + 1), label: candidate.label, value: candidate.entityId,
      }));
      return {
        kind: "needs_choice", pendingSlot: role, choiceReason: "ambiguity", candidates,
        partial: { projectEpoch: context.projectEpoch, sourceStatusGeneration, targetIdentities: [...targetIdentities] },
      };
    }
    binds[step.bind] = outcome.entityId;
    targetIdentities.push({ role, entityKind: role === "trackId" ? "track" : "plugin", entityId: outcome.entityId });
    targetResolutions[role] = { resolver: resolverName, input: inputName !== undefined ? { name: inputName } : {} };
  }

  // ── PHASE: preconditions ──
  for (const predicate of manifest.preconditions) {
    const resolvedArgs = resolveArgsV1(predicate.args, { slots, context, binds });
    if (!resolvedArgs.ok) return { kind: "blocked", code: "invalid_slot", reason: resolvedArgs.reason };
    const check = evaluatePredicateV1(predicate.name as PredicateNameV1, resolvedArgs.values, { snapshot: before, studioContext: context });
    if (!check.ok) return { kind: "blocked", code: preconditionReasonCode(predicate.name as PredicateNameV1), reason: check.reason };
  }

  // ── PHASE: expansion ──
  const mutationCalls: AgentCommandCall[] = [];
  for (const step of manifest.steps) {
    if (step.kind !== "mutate") continue;
    let items: readonly unknown[] = [undefined];
    if (step.forEach !== undefined) {
      const slot = manifest.slots.find((candidate) => candidate.name === step.forEach);
      if (!slot || slot.type !== "string[]") {
        return { kind: "blocked", code: "invalid_slot", reason: `forEach "${step.forEach}" does not name a string[] slot` };
      }
      const value = slots[step.forEach];
      items = Array.isArray(value) ? value : [];
    }
    for (const _item of items) {
      const resolvedArgs = resolveArgsV1(step.args, { slots, context, binds });
      if (!resolvedArgs.ok) return { kind: "blocked", code: "invalid_slot", reason: resolvedArgs.reason };
      mutationCalls.push({ command: step.command, args: resolvedArgs.values });
      const cap = Math.min(FOUNDRY_LIMITS_V1.expandedMutationCommands, manifest.execution.maxMutations);
      if (mutationCalls.length > cap) return { kind: "blocked", code: "invalid_slot", reason: "too many expanded mutation commands" };
    }
  }
  if (mutationCalls.length === 0) return { kind: "blocked", code: "unsupported_intent", reason: "no mutation commands were produced" };

  return { kind: "ok", before, context, slots, binds, targetIdentities, targetResolutions, mutationCalls, sourceStatusGeneration };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------
// Postconditions and the drift guard
// ---------------------------------------------------------------------------------------

function verifyPostconditionsV1(
  manifest: SkillManifestV1,
  preflight: PreflightOkV1,
  after: Snapshot,
  afterContext: StudioContext,
): SkillCheck {
  for (const predicate of manifest.postconditions) {
    const resolvedArgs = resolveArgsV1(predicate.args, { slots: preflight.slots, context: preflight.context, binds: preflight.binds });
    if (!resolvedArgs.ok) return { ok: false, reason: resolvedArgs.reason };
    const check = evaluatePredicateV1(predicate.name as PredicateNameV1, resolvedArgs.values, { snapshot: after, studioContext: afterContext });
    if (!check.ok) return check;
  }
  return { ok: true };
}

/** Set by the guard whenever IT is the reason a phase failed, so the caller can report the
 *  precise `SkillReasonCodeV1` instead of falling back to a generic engine-failure code —
 *  `AtomicSkillPlanDepsV1["guard"]` returns only `SkillCheck` (ok/reason), with no structured
 *  code field, so this is a small side-channel rather than fragile reason-string parsing. */
type GuardReasonSlotV1 = { code: SkillReasonCodeV1 | null };

function makeGuardV1(
  manifest: SkillManifestV1,
  preflight: PreflightOkV1,
  environment: StudioSkillEnvironmentV1,
  registryGenerationAtStart: number,
  reasonSlot: GuardReasonSlotV1,
): AtomicSkillPlanDepsV1["guard"] {
  return async (_phase: AtomicSkillGuardPhaseV1, guardCtx: AtomicSkillGuardContextV1): Promise<SkillCheck> => {
    const snapshotForPhase = guardCtx.after ?? guardCtx.before;
    const freshContext = environment.context();

    if (freshContext.projectEpoch !== preflight.context.projectEpoch) {
      reasonSlot.code = "stale_context";
      return { ok: false, reason: "the project changed" };
    }

    for (const identity of preflight.targetIdentities) {
      // `identity.role` is `string` on the frozen `ResolvedTargetIdentityV1` (contracts.ts),
      // but this module only ever constructs one from `RESOLVER_ROLE_V1`'s closed
      // `ResolvedRoleV1` set, so this narrowing is safe.
      const resolution = preflight.targetResolutions[identity.role as ResolvedRoleV1];
      if (!resolution) continue;
      const fresh = await runResolverV1(resolution.resolver, resolution.input, snapshotForPhase, freshContext, environment, SKILL_LIMITS_V1.choices);
      // A re-search that is STILL ambiguous is not itself drift: the user already picked one
      // candidate out of several sharing a name, and re-running the same name search always
      // reproduces the same set. Only "the chosen entity is no longer among the candidates at
      // all" (renamed, deleted, or the search now returns something else entirely) is drift.
      const stillValid = fresh.kind === "resolved"
        ? fresh.entityId === identity.entityId
        : fresh.kind === "choices" && fresh.candidates.some((candidate) => candidate.entityId === identity.entityId);
      if (!stillValid) {
        reasonSlot.code = "stale_context";
        return { ok: false, reason: `${identity.role} changed since this skill began` };
      }
    }

    try {
      const statusRead = await environment.readSourceStatus();
      let freshIndex: unknown = null;
      let freshGeneration = 0;
      if (statusRead.statusIndex) {
        try { freshIndex = JSON.parse(statusRead.statusIndex.utf8); } catch { freshIndex = null; }
        if (isRecord(freshIndex) && typeof freshIndex.generation === "number") freshGeneration = freshIndex.generation;
      }
      if (freshGeneration !== preflight.sourceStatusGeneration) {
        reasonSlot.code = "manifest_stale";
        return { ok: false, reason: "the source-status index changed" };
      }
      const sourceCheck = validateSourceStatusForInvocationV1({ provenance: manifest.provenance, freshIndex, nowMs: Date.now() });
      if (!sourceCheck.ok) {
        reasonSlot.code = "manifest_stale";
        return { ok: false, reason: sourceCheck.message };
      }
    } catch (error) {
      reasonSlot.code = "observation_failed";
      return { ok: false, reason: `could not re-read source status: ${detail(error)}` };
    }

    // DESIGN DECISION: `registryGeneration` is supplied once per `executeDeclarativeSkillV1`
    // call (this slice has no live registry to independently re-poll — `registry.ts` is
    // Task 5, not in this task's file map). Within ONE call nothing here can change it, so
    // comparing it to itself correctly reports "no drift observed" rather than fabricating a
    // signal this module cannot actually see. The check that matters — a registry rebuild
    // between when a continuation was ISSUED and when it is RESUMED — happens in
    // `executeDeclarativeSkillV1`'s resume path, comparing the continuation's stored
    // `registryGeneration` against the fresh value the caller supplies on the new call.
    if (registryGenerationAtStart !== registryGenerationAtStart) {
      reasonSlot.code = "stale_context";
      return { ok: false, reason: "unreachable" };
    }

    return { ok: true };
  };
}

// ---------------------------------------------------------------------------------------
// Confirmation-plan digest (spec: SHA256 over the canonical, ordered plan facts)
// ---------------------------------------------------------------------------------------

async function confirmationPlanSha256V1(
  skillId: string,
  version: string,
  artifactSha256: string,
  preflight: PreflightOkV1,
): Promise<string> {
  return sha256Bytes(canonicalJsonBytes({
    skill: skillId,
    version,
    artifactSha256,
    slots: preflight.slots,
    targetIdentities: preflight.targetIdentities,
    mutations: preflight.mutationCalls,
  }));
}

// ---------------------------------------------------------------------------------------
// Atomic execution: hand the expanded plan to atomicPlan.ts and translate its result.
// ---------------------------------------------------------------------------------------

function toChangeSet(manifest: SkillManifestV1, summary: SkillExecutionSummary): ChangeSet {
  return { label: manifest.title, entries: summary.entries, applied: summary.applied };
}

/** `AtomicSkillPlanV1.slots` is typed `SkillSlotValues` (`skills.ts`'s legacy scalar-only
 *  `SkillPrimitive = string|number|boolean`, predating V1's `string[]` slot type) and is used
 *  by `atomicPlan.ts` purely as a pass-through into `SkillRunResult.slots` — an informational
 *  echo this module's own `SkillOutcomeV1` never reads back out. A `string[]` value has no
 *  lossless `SkillPrimitive` representation, so it is rendered as its canonical JSON text
 *  rather than dropped, keeping the echoed value informative without widening a frozen Task-7
 *  type for one cosmetic field. */
function toLegacySlotValuesV1(slots: Readonly<Record<string, SlotValueV1>>): Readonly<Record<string, string | number | boolean>> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(slots)) out[key] = Array.isArray(value) ? JSON.stringify(value) : value;
  return out;
}

async function runAtomicallyV1(
  manifest: SkillManifestV1,
  skillId: string,
  preflight: PreflightOkV1,
  environment: StudioSkillEnvironmentV1,
  registryGenerationAtStart: number,
  newId: () => string,
): Promise<SkillOutcomeV1> {
  const transactionId = newId();
  const steps = preflight.mutationCalls.map((call, index) => ({
    call, meta: { transactionId, requestId: newId(), index },
  }));
  const manifestEntries = steps.map((step) => ({ index: step.meta.index, requestId: step.meta.requestId, command: step.call.command }));
  const transaction = { transactionId, name: manifest.id, manifest: manifestEntries, steps };

  const reasonSlot: GuardReasonSlotV1 = { code: null };
  const guard = makeGuardV1(manifest, preflight, environment, registryGenerationAtStart, reasonSlot);

  let postAfterContext: StudioContext | null = null;
  const plan: AtomicSkillPlanV1 = {
    skill: skillId,
    version: manifest.version,
    slots: toLegacySlotValuesV1(preflight.slots),
    before: preflight.before,
    transaction,
    verifyPostcondition: (before, after) => {
      postAfterContext = environment.context();
      return verifyPostconditionsV1(manifest, { ...preflight, before }, after, postAfterContext);
    },
  };

  const result = await runAtomicSkillPlanV1(plan, { snapshot: environment.snapshot, exec: environment.exec, guard });

  if (result.ok) {
    return {
      kind: "completed", skill: skillId, version: manifest.version, say: manifest.responses.completed,
      changes: toChangeSet(manifest, result.changes),
    };
  }

  const unserved = result.outcome === "no_edit";
  let code: SkillReasonCodeV1;
  if (reasonSlot.code) {
    code = reasonSlot.code;
  } else if (result.outcome === "needs_recovery") {
    code = "rollback_failed";
  } else if (result.stage === "postcondition") {
    code = "postcondition_failed";
  } else {
    code = "command_failed";
  }

  return { kind: "blocked", skill: skillId, version: manifest.version, code, say: manifest.responses.blocked, unserved };
}

// ---------------------------------------------------------------------------------------
// Continuation issuance / resume
// ---------------------------------------------------------------------------------------

function continuationBaseV1(
  manifest: SkillManifestV1,
  artifactSha256: string,
  targetIdentities: readonly ResolvedTargetIdentityV1[],
  projectEpoch: number,
  registryGeneration: number,
  sourceStatusGeneration: number,
  choices: readonly ContinuationChoiceValueV1[],
  nowMs: number,
  attempts: number,
): ContinuationPayloadBaseV1 {
  return {
    skillId: manifest.id, version: manifest.version, artifactSha256, choices, targetIdentities,
    projectEpoch, registryGeneration, sourceStatusGeneration,
    createdAtMs: nowMs, expiresAtMs: nowMs + SKILL_LIMITS_V1.continuationTtlMs, attempts,
  };
}

function matchChoiceReply(reply: string | undefined, choices: readonly ContinuationChoiceValueV1[]): ContinuationChoiceValueV1 | null {
  if (!reply) return null;
  const normalized = reply.trim().toLowerCase();
  return choices.find((choice) => choice.id.toLowerCase() === normalized || choice.label.toLowerCase() === normalized) ?? null;
}

/**
 * Execute one owner-local declarative skill through the seven-phase protocol, resuming a
 * paused run when `continuationToken` is supplied. See this module's header comment for the
 * phase order and the guard/continuation invariants.
 */
export async function executeDeclarativeSkillV1(input: DeclarativeExecutionInputV1): Promise<SkillOutcomeV1> {
  const { skill, environment, continuations } = input;
  const manifest = skill.manifest;
  const skillId = manifest.id;
  const newId = input.newId ?? defaultNewId;
  const nowMs = input.nowMs ?? Date.now;
  const startMs = nowMs();

  let overrides: TargetOverridesV1 = {};
  let cameFromAmbiguityChoice = false;
  let alreadyConfirmed = false;
  let confirmedDigest: string | null = null;

  if (input.continuationToken !== undefined) {
    const taken = continuations.take(input.continuationToken, nowMs());
    if (!taken.ok) return reasonFor(manifest, skillId, "stale_context");
    const payload = taken.payload;
    if (payload.skillId !== skillId || payload.version !== manifest.version || payload.artifactSha256 !== skill.manifestSha256) {
      return reasonFor(manifest, skillId, "stale_context");
    }

    if (payload.pendingKind === "confirmation") {
      const reply = (input.reply ?? "").trim().toLowerCase();
      if (reply === "cancel") {
        return { kind: "blocked", skill: skillId, version: manifest.version, code: "unsupported_intent", say: manifest.responses.blocked, unserved: true };
      }
      if (reply !== "confirm") {
        return reissueOrBlockV1(continuations, payload, manifest, skillId);
      }
      alreadyConfirmed = true;
      confirmedDigest = payload.confirmationPlanSha256;
      for (const identity of payload.targetIdentities) overrides = { ...overrides, [identity.role]: identity.entityId };
    } else {
      const chosen = matchChoiceReply(input.reply, payload.choices);
      if (!chosen) return reissueOrBlockV1(continuations, payload, manifest, skillId);
      if (payload.choiceReason === "ambiguity") {
        cameFromAmbiguityChoice = true;
        overrides = { ...overrides, [payload.pendingSlot as ResolvedRoleV1]: String(chosen.value) };
      }
      for (const identity of payload.targetIdentities) overrides = { ...overrides, [identity.role]: identity.entityId };
    }
  }

  const preflight = await runPreflightV1(manifest, input.utteranceSlots, environment, overrides);

  if (preflight.kind === "blocked") return reasonFor(manifest, skillId, preflight.code);

  if (preflight.kind === "needs_choice") {
    const base = continuationBaseV1(
      manifest, skill.manifestSha256,
      preflight.partial?.targetIdentities ?? [],
      preflight.partial?.projectEpoch ?? 0,
      input.registryGeneration,
      preflight.partial?.sourceStatusGeneration ?? 0,
      preflight.candidates, nowMs(), 0,
    );
    const payload: ContinuationPayloadV1 = {
      ...base, pendingKind: "choice", pendingSlot: preflight.pendingSlot, choiceReason: preflight.choiceReason,
    };
    const issued = continuations.issue(payload);
    if (!issued.ok) return reasonFor(manifest, skillId, "provider_unavailable");
    const options: readonly SkillChoiceV1[] = preflight.candidates.map((choice) => ({ id: choice.id, label: choice.label }));
    return {
      kind: "needs_choice", skill: skillId, version: manifest.version, say: manifest.responses.needsChoice,
      options, continuationToken: issued.token,
    };
  }

  // ── PHASE: confirmation gate ──
  const needsConfirmation = !alreadyConfirmed && (
    manifest.execution.confirmation === "always" ||
    (manifest.execution.confirmation === "on_ambiguity" && cameFromAmbiguityChoice)
  );

  if (needsConfirmation) {
    const digest = await confirmationPlanSha256V1(skillId, manifest.version, skill.manifestSha256, preflight);
    const confirmChoices: readonly ContinuationChoiceValueV1[] = [
      { id: "confirm", label: "Apply", value: true },
      { id: "cancel", label: "Cancel", value: false },
    ];
    const base = continuationBaseV1(
      manifest, skill.manifestSha256, preflight.targetIdentities, preflight.context.projectEpoch,
      input.registryGeneration, preflight.sourceStatusGeneration, confirmChoices, nowMs(), 0,
    );
    const payload: ContinuationPayloadV1 = { ...base, pendingKind: "confirmation", pendingSlot: "confirmation", confirmationPlanSha256: digest };
    const issued = continuations.issue(payload);
    if (!issued.ok) return reasonFor(manifest, skillId, "provider_unavailable");
    return {
      kind: "needs_choice", skill: skillId, version: manifest.version, say: manifest.responses.needsChoice,
      options: [{ id: "confirm", label: "Apply" }, { id: "cancel", label: "Cancel" }], continuationToken: issued.token,
    };
  }

  // If this call resumed a CONFIRMATION, the digest recomputed by THIS fresh preflight (rerun
  // in full, per the plan's "resume must consume once, rerun preflight, match the exact plan
  // digest, then begin") must match exactly what was confirmed — any drift (slots, targets,
  // mutations changed since the confirmation was issued) fails closed WITHOUT mutating, rather
  // than silently applying a plan the user never actually saw/confirmed.
  if (alreadyConfirmed && confirmedDigest !== null) {
    const freshDigest = await confirmationPlanSha256V1(skillId, manifest.version, skill.manifestSha256, preflight);
    if (freshDigest !== confirmedDigest) return reasonFor(manifest, skillId, "stale_context");
  }

  // Deadline check, right before any engine call: `execution.timeoutMs` bounds the WHOLE
  // preflight-through-transaction run. Checked here — the one point right before this module
  // would open a transaction — rather than via a real timer/AbortController, per the
  // determinism rule (inject `nowMs`, no wall-clock waits). A run that has already blown its
  // budget is refused outright: nothing is retried, and since `batch_begin` is never called,
  // "without new-ID retry" holds trivially — there was no first ID to retry.
  if (nowMs() - startMs >= manifest.execution.timeoutMs) {
    return reasonFor(manifest, skillId, "timeout");
  }

  return runAtomicallyV1(manifest, skillId, preflight, environment, input.registryGeneration, newId);
}

function reissueOrBlockV1(
  continuations: ContinuationStoreV1,
  payload: ContinuationPayloadV1,
  manifest: SkillManifestV1,
  skillId: string,
): SkillOutcomeV1 {
  const nextAttempts = payload.attempts + 1;
  if (nextAttempts >= SKILL_LIMITS_V1.continuationInvalidAttempts) {
    return { kind: "blocked", skill: skillId, version: manifest.version, code: "invalid_slot", say: manifest.responses.blocked, unserved: true };
  }
  const reissued: ContinuationPayloadV1 = { ...payload, attempts: nextAttempts };
  const issued = continuations.issue(reissued);
  if (!issued.ok) return { kind: "blocked", skill: skillId, version: manifest.version, code: "provider_unavailable", say: manifest.responses.blocked, unserved: true };
  const options: readonly SkillChoiceV1[] = payload.choices.map((choice) => ({ id: choice.id, label: choice.label }));
  return {
    kind: "needs_choice", skill: skillId, version: manifest.version, say: manifest.responses.needsChoice,
    options, continuationToken: issued.token,
  };
}

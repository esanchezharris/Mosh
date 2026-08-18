// Task 8 — the closed owner-local PRIMITIVE RUNTIME: the functions that actually execute an
// observation, a resolver, or a predicate from `catalogs.ts`'s closed vocabulary against live
// (or captured) session state. `catalogs.ts`/`validate.ts` (Task 2) only type-check that a
// manifest references these names correctly; nothing there ever calls them. This module is
// the other half — the exact, deterministic, non-throwing behavior behind each name — and
// `declarativeExecutor.ts` is its only caller.
//
// SCOPE: no ValueRefV1 resolution happens here (that is `declarativeExecutor.ts`'s job, per
// the plan's Task 8 Step 4 instruction "Resolve typed refs ... before planning") — every
// function below takes already-resolved plain values. No transaction/continuation/hashing
// logic lives here either. This module only answers three questions: what does this
// observation return, what does this resolver find, and does this predicate hold.

import type { AvailablePlugin, Snapshot, Track } from "../../types";
import type { StudioContext } from "../studioSkills";
import type { SkillCheck } from "../skills";
import type { StudioSkillEnvironmentV1, SlotValueV1 } from "./contracts";

// ---------------------------------------------------------------------------------------
// Observations — current_snapshot, list_plugins (catalogs.ts's OWNER_PRIMITIVES_V1.observations)
// ---------------------------------------------------------------------------------------

export type ObservationOutcomeV1 =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: string };

/** `current_snapshot` is deliberately NOT a fresh `environment.snapshot()` call: the seven-
 *  phase order captures ONE "before" snapshot ahead of the observations/resolvers phase, and
 *  `current_snapshot` binds to exactly that value — a second independent read here would
 *  create two different "before" states for the same preflight pass. This function exists
 *  (rather than the executor binding `before` directly) only so the observation has the same
 *  call shape as `list_plugins` and is independently testable. */
export function observeCurrentSnapshotV1(before: Snapshot): ObservationOutcomeV1 {
  return { ok: true, value: before };
}

// Mirrors the bound used for the same concept in studioSkills.ts's `observePlugins`/
// `parsePluginCatalog` — kept as a local constant (not imported) so this module has no
// dependency on a UI-adjacent file; the number itself is chosen for parity with that
// established bound rather than re-derived from a different budget.
const MAX_PLUGIN_CATALOG_V1 = 4_096;
const MAX_PLUGIN_FIELD_CHARS_V1 = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAvailablePlugin(value: unknown): AvailablePlugin | null {
  if (!isRecord(value)) return null;
  const { id, name, format, manufacturer, isInstrument } = value;
  if (
    typeof id !== "string" || typeof name !== "string" || typeof format !== "string" ||
    typeof manufacturer !== "string" || typeof isInstrument !== "boolean"
  ) return null;
  if (
    !id || !name || id.length > MAX_PLUGIN_FIELD_CHARS_V1 || name.length > MAX_PLUGIN_FIELD_CHARS_V1 ||
    format.length > MAX_PLUGIN_FIELD_CHARS_V1 || manufacturer.length > MAX_PLUGIN_FIELD_CHARS_V1
  ) return null;
  return { id, name, format, manufacturer, isInstrument };
}

/** Parse and bound-check the raw `list_plugins` bridge payload. Exported separately from
 *  `runListPluginsV1` so `plugin_by_name` (below) can reuse the exact same parse/bound logic
 *  without a second `exec` call. */
export function parseInstalledPluginCatalogV1(data: unknown): readonly AvailablePlugin[] | null {
  if (!isRecord(data) || !Array.isArray(data.plugins) || data.plugins.length > MAX_PLUGIN_CATALOG_V1) return null;
  const entries: AvailablePlugin[] = [];
  for (const raw of data.plugins) {
    const plugin = parseAvailablePlugin(raw);
    if (!plugin) return null;
    entries.push(plugin);
  }
  return entries;
}

export async function observeListPluginsV1(environment: StudioSkillEnvironmentV1): Promise<ObservationOutcomeV1> {
  let result: Awaited<ReturnType<StudioSkillEnvironmentV1["exec"]>>;
  try {
    result = await environment.exec("list_plugins", {});
  } catch (error) {
    return { ok: false, reason: `list_plugins transport failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!result.ok) return { ok: false, reason: result.error ?? "list_plugins was refused" };
  const plugins = parseInstalledPluginCatalogV1(result.data);
  if (!plugins) return { ok: false, reason: "list_plugins returned malformed or oversized data" };
  return { ok: true, value: plugins };
}

export async function runObservationV1(
  command: "current_snapshot" | "list_plugins",
  before: Snapshot,
  environment: StudioSkillEnvironmentV1,
): Promise<ObservationOutcomeV1> {
  if (command === "current_snapshot") return observeCurrentSnapshotV1(before);
  return observeListPluginsV1(environment);
}

// ---------------------------------------------------------------------------------------
// Resolvers — selected_track, track_by_unique_name, plugin_by_name
// (catalogs.ts's OWNER_PRIMITIVES_V1.resolvers)
// ---------------------------------------------------------------------------------------

/** The closed set of `ResolvedTargetIdentityV1.role` values V1's three resolvers can ever
 *  produce (contracts.ts's `ResolvedTargetIdentityV1` comment: `role` is the manifest's fixed
 *  argument-name convention for an entity kind, not a per-manifest bind name).
 *
 *  DESIGN DECISION: the plan gives one example (`role: "trackId"`) and describes `role` in
 *  prose as "the manifest slot name that resolved the target" without an exact derivation
 *  rule. `catalogs.ts`'s `TRACK_ID_ARG`/`PLUGIN_ID_ARG` are consumed under the SAME fixed
 *  argument names (`trackId`, `pluginId`) by every primitive that accepts them — Task 6's own
 *  `continuations.test.ts` fixture uses exactly `role: "trackId"` for a track target. So each
 *  resolver is pinned to the one role name its bound value is always consumed as, rather than
 *  to the resolve step's manifest-author-chosen `bind` name (which can vary skill to skill and
 *  would not let a guard know what to re-check without also carrying resolver+input — see
 *  `declarativeExecutor.ts`'s `TargetResolutionV1`, which carries both). */
export type ResolvedRoleV1 = "trackId" | "pluginId";

export const RESOLVER_ROLE_V1: Readonly<Record<"selected_track" | "track_by_unique_name" | "plugin_by_name", ResolvedRoleV1>> = {
  selected_track: "trackId",
  track_by_unique_name: "trackId",
  plugin_by_name: "pluginId",
};

export type ResolverCandidateV1 = { readonly entityId: string; readonly label: string };

export type ResolverOutcomeV1 =
  | { readonly kind: "resolved"; readonly role: ResolvedRoleV1; readonly entityId: string }
  | { readonly kind: "choices"; readonly role: ResolvedRoleV1; readonly candidates: readonly ResolverCandidateV1[] }
  | { readonly kind: "none" }
  | { readonly kind: "too_many"; readonly count: number }
  | { readonly kind: "failed"; readonly reason: string };

/** Unicode-normalize, casefold, and collapse surrounding whitespace — used identically for
 *  track names and plugin names so "  Bass Guitar " and "bass guitar" are the same exact
 *  match. Deliberately NOT the fuzzy substring/vendor-aware ranking `pluginBrowserUtil.ts`'s
 *  `resolvePluginMatch` uses for producer-facing plugin search: this is a closed, auditable
 *  manifest primitive (spec 8.4's "exact ... resolution"), not a fuzzy UI search box, and the
 *  plan's own Task 8 Step 1 says "normalized case-insensitive EXACT unique track name" for the
 *  track resolver. `plugin_by_name` uses the identical exact-match rule for the same reason
 *  and to keep the two name-resolvers behaviorally consistent — ambiguity is still safely
 *  surfaced as a choice, so exactness does not lose reachability, only fuzziness. */
function normalizeNameV1(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Bucket already-matched candidates into none/resolved/choices/too_many, deduping by
 *  `entityId` first — a backend anomaly that reports the same entity twice (or a name that
 *  legitimately matches only one real track under two rows) must never manufacture a false
 *  ambiguity. `maxChoices` is the step's own declared cap (1..5, `FOUNDRY_LIMITS_V1.maxChoices`
 *  already bounds it at parse time); exceeding it is `too_many`, never a silently truncated
 *  choice list — offering fewer options than actually matched would hide a real candidate. */
function bucketCandidatesV1(
  role: ResolvedRoleV1,
  rawCandidates: readonly ResolverCandidateV1[],
  maxChoices: number,
): ResolverOutcomeV1 {
  const byId = new Map<string, ResolverCandidateV1>();
  for (const candidate of rawCandidates) if (!byId.has(candidate.entityId)) byId.set(candidate.entityId, candidate);
  const candidates = [...byId.values()];
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "resolved", role, entityId: candidates[0]!.entityId };
  if (candidates.length > maxChoices) return { kind: "too_many", count: candidates.length };
  return { kind: "choices", role, candidates };
}

function resolveSelectedTrackV1(before: Snapshot, context: StudioContext): ResolverOutcomeV1 {
  if (context.selectedTrackId === null) return { kind: "none" };
  const track = before.tracks.find((candidate: Track) => candidate.id === context.selectedTrackId);
  if (!track) return { kind: "none" }; // stale selection: the selected track no longer exists
  return { kind: "resolved", role: "trackId", entityId: track.id };
}

function resolveTrackByUniqueNameV1(before: Snapshot, name: string, maxChoices: number): ResolverOutcomeV1 {
  const needle = normalizeNameV1(name);
  const candidates: ResolverCandidateV1[] = before.tracks
    .filter((track: Track) => normalizeNameV1(track.name) === needle)
    .map((track: Track) => ({ entityId: track.id, label: track.name }));
  return bucketCandidatesV1("trackId", candidates, maxChoices);
}

async function resolvePluginByNameV1(
  environment: StudioSkillEnvironmentV1,
  name: string,
  maxChoices: number,
): Promise<ResolverOutcomeV1> {
  const observed = await observeListPluginsV1(environment);
  if (!observed.ok) return { kind: "failed", reason: observed.reason };
  const plugins = observed.value as readonly AvailablePlugin[];
  const needle = normalizeNameV1(name);
  const candidates: ResolverCandidateV1[] = plugins
    .filter((plugin) => normalizeNameV1(plugin.name) === needle)
    .map((plugin) => ({
      entityId: plugin.id,
      label: plugin.manufacturer ? `${plugin.name} — ${plugin.manufacturer}` : plugin.name,
    }));
  return bucketCandidatesV1("pluginId", candidates, maxChoices);
}

export type ResolverNameV1 = keyof typeof RESOLVER_ROLE_V1;

export async function runResolverV1(
  resolver: ResolverNameV1,
  input: { readonly name?: string },
  before: Snapshot,
  context: StudioContext,
  environment: StudioSkillEnvironmentV1,
  maxChoices: number,
): Promise<ResolverOutcomeV1> {
  if (resolver === "selected_track") return resolveSelectedTrackV1(before, context);
  if (resolver === "track_by_unique_name") {
    if (typeof input.name !== "string" || input.name.length === 0) {
      return { kind: "failed", reason: "track_by_unique_name requires a non-empty name" };
    }
    return resolveTrackByUniqueNameV1(before, input.name, maxChoices);
  }
  if (typeof input.name !== "string" || input.name.length === 0) {
    return { kind: "failed", reason: "plugin_by_name requires a non-empty name" };
  }
  return resolvePluginByNameV1(environment, input.name, maxChoices);
}

// ---------------------------------------------------------------------------------------
// Predicates — catalogs.ts's OWNER_PREDICATES_V1
// ---------------------------------------------------------------------------------------

export type PredicateEvalContextV1 = {
  readonly snapshot: Snapshot;
  readonly studioContext: StudioContext;
};

function findTrack(snapshot: Snapshot, trackId: unknown): Track | undefined {
  if (typeof trackId !== "string") return undefined;
  return snapshot.tracks.find((track: Track) => track.id === trackId);
}

function fail(reason: string): SkillCheck {
  return { ok: false, reason };
}
const OK: SkillCheck = { ok: true };

/**
 * DESIGN DECISION: `not_recording()`'s data source is not named anywhere in the plan or spec
 * beyond the zero-arg signature. `StudioSkillEnvironmentV1`/`StudioContext` (both frozen by
 * earlier tasks and out of this task's file map) carry no recording flag, so the only
 * candidate already reachable from a `Snapshot` is `Snapshot.controller?.record`
 * (`"idle"|"armed"|"recording"` — the capture-review-choose-take controller's own state,
 * `ui/src/types.ts:319-323`). Modeled as: recording iff that field is literally `"recording"`;
 * absent controller or `"idle"`/`"armed"` both count as not-recording.
 */
function evalNotRecording(ctx: PredicateEvalContextV1): SkillCheck {
  if (ctx.snapshot.controller?.record === "recording") return fail("a take is currently recording");
  return OK;
}

/**
 * DESIGN DECISION: `epoch` is resolved from `{context: "projectEpoch"}` ONCE, at preflight
 * time (before any mutation), by `declarativeExecutor.ts` — the SAME resolved value is reused
 * whether this predicate runs as a precondition (checked against the pre-transaction context,
 * where it is tautologically true) or a postcondition (checked against the POST-transaction
 * context, where it genuinely detects "the project was replaced/reloaded while this skill was
 * running"). This is the only reading under which the predicate is not vacuous either way: a
 * context ref re-resolved against whichever context it is being checked against would always
 * equal itself.
 */
function evalProjectEpochUnchanged(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const capturedEpoch = args.epoch;
  if (typeof capturedEpoch !== "number") return fail("project_epoch_unchanged requires a numeric epoch argument");
  if (ctx.studioContext.projectEpoch !== capturedEpoch) return fail("the project changed since this skill began");
  return OK;
}

function evalSelectedTrackIs(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  if (typeof trackId !== "string") return fail("selected_track_is requires a trackId argument");
  if (ctx.studioContext.selectedTrackId !== trackId) return fail(`track ${trackId} is not selected`);
  return OK;
}

function evalTrackExists(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  if (typeof trackId !== "string") return fail("track_exists requires a trackId argument");
  return findTrack(ctx.snapshot, trackId) ? OK : fail(`track ${trackId} does not exist`);
}

function evalTrackVolumeEquals(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  const db = args.db;
  if (typeof trackId !== "string" || typeof db !== "number") return fail("track_volume_equals requires trackId and db arguments");
  const track = findTrack(ctx.snapshot, trackId);
  if (!track) return fail(`track ${trackId} does not exist`);
  return track.volumeDb === db ? OK : fail(`track ${trackId} volume is ${track.volumeDb ?? "unset"}, expected ${db}`);
}

function evalTrackMuteEquals(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  const mute = args.mute;
  if (typeof trackId !== "string" || typeof mute !== "boolean") return fail("track_mute_equals requires trackId and mute arguments");
  const track = findTrack(ctx.snapshot, trackId);
  if (!track) return fail(`track ${trackId} does not exist`);
  const actual = track.mute ?? false;
  return actual === mute ? OK : fail(`track ${trackId} mute is ${actual}, expected ${mute}`);
}

function evalTrackSoloEquals(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  const solo = args.solo;
  if (typeof trackId !== "string" || typeof solo !== "boolean") return fail("track_solo_equals requires trackId and solo arguments");
  const track = findTrack(ctx.snapshot, trackId);
  if (!track) return fail(`track ${trackId} does not exist`);
  const actual = track.solo ?? false;
  return actual === solo ? OK : fail(`track ${trackId} solo is ${actual}, expected ${solo}`);
}

/** Passes only when EXACTLY ONE plug-in on the target track carries the resolved `catalogId`
 *  (`Plugin.catalogId`, `PluginHost::idFor` — Task 2's `MoshOpsInternal.h` change). Zero means
 *  the load did not take; two or more means either a duplicate/replay or a catalog identity
 *  collision — both are refused rather than silently accepted, per the plan's Step 1
 *  instruction. A plug-in with no stamped `catalogId` at all can never satisfy this (it cannot
 *  equal a real resolved ID), which is exactly the "missing identity fails closed" case. */
function evalPluginInstanceAddedOnce(args: Readonly<Record<string, SlotValueV1>>, ctx: PredicateEvalContextV1): SkillCheck {
  const trackId = args.trackId;
  const pluginId = args.pluginId;
  if (typeof trackId !== "string" || typeof pluginId !== "string") {
    return fail("plugin_instance_added_once requires trackId and pluginId arguments");
  }
  const track = findTrack(ctx.snapshot, trackId);
  if (!track) return fail(`track ${trackId} does not exist`);
  const matches = (track.plugins ?? []).filter((plugin) => plugin.catalogId === pluginId).length;
  return matches === 1 ? OK : fail(`track ${trackId} has ${matches} plug-in instances matching ${pluginId}, expected exactly 1`);
}

export type PredicateNameV1 =
  | "not_recording" | "project_epoch_unchanged" | "selected_track_is" | "track_exists"
  | "track_volume_equals" | "track_mute_equals" | "track_solo_equals" | "plugin_instance_added_once";

export function evaluatePredicateV1(
  name: PredicateNameV1,
  args: Readonly<Record<string, SlotValueV1>>,
  ctx: PredicateEvalContextV1,
): SkillCheck {
  switch (name) {
    case "not_recording": return evalNotRecording(ctx);
    case "project_epoch_unchanged": return evalProjectEpochUnchanged(args, ctx);
    case "selected_track_is": return evalSelectedTrackIs(args, ctx);
    case "track_exists": return evalTrackExists(args, ctx);
    case "track_volume_equals": return evalTrackVolumeEquals(args, ctx);
    case "track_mute_equals": return evalTrackMuteEquals(args, ctx);
    case "track_solo_equals": return evalTrackSoloEquals(args, ctx);
    case "plugin_instance_added_once": return evalPluginInstanceAddedOnce(args, ctx);
    default: {
      const _exhaustive: never = name;
      return fail(`unknown predicate: ${String(_exhaustive)}`);
    }
  }
}

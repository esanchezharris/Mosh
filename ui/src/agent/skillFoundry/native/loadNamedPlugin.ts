// Skill Foundry Slice B, Task 5 — the native `load-named-plugin` handler (canonical id
// "load-named-plugin", handlerKey "loadNamedPluginV1", legacy alias "load_named_plugin").
//
// Migrates the proven resolution logic out of the legacy `studioSkills.ts`
// (`LOAD_NAMED_PLUGIN_SKILL`) onto the SAME atomic-executor discipline
// `explicitBalance.ts` established: `runAtomicSkillPlanV1`, never a bare `exec`, with a
// two-checkpoint guard (project epoch, target track existence, source status) and an
// exact postcondition. The catalog parser, the utterance query regex, the choice
// labeling, and `resolvePluginMatch` (pluginBrowserUtil.ts) are UNCHANGED behavior,
// just relocated here; `studioSkills.ts` keeps its own copy until Slice B's Task 7
// retires it as a routing path (this module does not delete that file).
//
// Bounded catalog cap is TIGHTENED to 64 (was 4096 in the legacy skill) per this task's
// instruction; the per-field length cap (1024 UTF-16 code units) is unchanged.

import type { AvailablePlugin, Snapshot } from "../../../types";
import { addPluginRecent, installedEntry, resolvePluginMatch, type PluginEntry } from "../../../ui/pluginBrowserUtil";
import type { SkillCheck } from "../../skills";
import {
  runAtomicSkillPlanV1,
  type AtomicSkillGuardContextV1,
  type AtomicSkillGuardPhaseV1,
  type AtomicSkillPlanDepsV1,
  type AtomicSkillPlanV1,
} from "../atomicPlan";
import { createContinuationStoreV1 } from "../continuations";
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
  StudioSkillEnvironmentV1,
} from "../contracts";

const MAX_PLUGIN_CATALOG_V1 = 64;
const MAX_PLUGIN_FIELD_LENGTH_V1 = 1_024;

const LOAD_PLUGIN_UTTERANCE_V1 =
  /^(?:(?:can|could|would|will)\s+you\s+|please\s+|hey\s+moshi[, ]+)*(?:load|add|insert|put)\s+(?:(?:the|a)\s+)?(?:plugin\s+)?(.+?)(?:\s+(?:on|onto)\s+(?:the\s+)?(?:selected|current|this)\s+track)?[?!.]*$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePlugin(value: unknown): AvailablePlugin | null {
  if (!isRecord(value)) return null;
  const { id, name, format, manufacturer, isInstrument } = value;
  if (typeof id !== "string" || typeof name !== "string" || typeof format !== "string"
    || typeof manufacturer !== "string" || typeof isInstrument !== "boolean") return null;
  if (!id || !name || id.length > MAX_PLUGIN_FIELD_LENGTH_V1 || name.length > MAX_PLUGIN_FIELD_LENGTH_V1
    || format.length > MAX_PLUGIN_FIELD_LENGTH_V1 || manufacturer.length > MAX_PLUGIN_FIELD_LENGTH_V1) return null;
  return { id, name, format, manufacturer, isInstrument };
}

export function parsePluginCatalogV1(data: unknown): readonly PluginEntry[] | null {
  if (!isRecord(data) || !Array.isArray(data.plugins) || data.plugins.length > MAX_PLUGIN_CATALOG_V1) return null;
  const entries: PluginEntry[] = [];
  for (const raw of data.plugins) {
    const plugin = parsePlugin(raw);
    if (!plugin) return null;
    entries.push(installedEntry(plugin));
  }
  return entries;
}

export function pluginQueryV1(utterance: string): string | null {
  const match = utterance.trim().match(LOAD_PLUGIN_UTTERANCE_V1);
  const query = match?.[1]?.trim();
  return query ? query : null;
}

type PluginChoiceV1 = { readonly label: string; readonly entry: PluginEntry };

function pluginChoicesV1(entries: readonly PluginEntry[]): readonly PluginChoiceV1[] {
  const baseLabels = entries.map((entry) => `${entry.name} — ${entry.meta}`);
  const totals = new Map<string, number>();
  for (const label of baseLabels) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  return entries.map((entry, index) => {
    const base = baseLabels[index] ?? entry.name;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { entry, label: (totals.get(base) ?? 0) > 1 ? `${base} (${occurrence})` : base };
  });
}

function numberedChoicesV1(choices: readonly PluginChoiceV1[]): string {
  return choices.map((choice, index) => `${index + 1}. ${choice.label}`).join("; ");
}

async function observePluginsV1(environment: StudioSkillEnvironmentV1): Promise<{ ok: true; value: readonly PluginEntry[] } | { ok: false; reason: string }> {
  let result;
  try {
    result = await environment.exec("list_plugins", {});
  } catch (error) {
    return { ok: false, reason: `list_plugins transport failed: ${detail(error)}` };
  }
  if (!result.ok) return { ok: false, reason: result.error ?? "the plug-in catalog could not be read" };
  const plugins = parsePluginCatalogV1(result.data);
  if (!plugins) return { ok: false, reason: "the plug-in catalog returned invalid or oversized data" };
  return { ok: true, value: plugins };
}

// ---------------------------------------------------------------------------------------
// Source-status snapshot — identical discipline to explicitBalance.ts.
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
// Private continuation store — this handler's only user (mirrors explicitBalance.ts).
// ---------------------------------------------------------------------------------------

const loadNamedPluginContinuations: ContinuationStoreV1 = createContinuationStoreV1();

export function clearLoadNamedPluginContinuationsV1(): void {
  loadNamedPluginContinuations.clear();
}

// ---------------------------------------------------------------------------------------
// Postcondition: the target track's matching-catalogId count increases by exactly one;
// every OTHER track's matching count is unchanged.
// ---------------------------------------------------------------------------------------

function countMatchingPlugins(snapshot: Snapshot, trackId: string, catalogId: string): number {
  const track = snapshot.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return 0;
  return (track.plugins ?? []).filter((plugin) => plugin.catalogId === catalogId).length;
}

function verifyPluginAddedOnceV1(before: Snapshot, after: Snapshot, trackId: string, catalogId: string): SkillCheck {
  for (const track of after.tracks) {
    const beforeCount = countMatchingPlugins(before, track.id, catalogId);
    const afterCount = countMatchingPlugins(after, track.id, catalogId);
    const expected = track.id === trackId ? beforeCount + 1 : beforeCount;
    if (afterCount !== expected) {
      return { ok: false, reason: `track ${track.id} matching-plugin count changed unexpectedly (${beforeCount} -> ${afterCount}, expected ${expected})` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// Blocked-outcome helper + instrument/audio mismatch guidance
// ---------------------------------------------------------------------------------------

function blocked(payload: NativeSkillPayloadV1, code: SkillReasonCodeV1, say: string): SkillOutcomeV1 {
  return { kind: "blocked", skill: payload.id, version: payload.version, code, say, unserved: true };
}

function mismatchGuidance(error: string): string {
  return /instrument.*audio|audio.*instrument/i.test(error)
    ? "select or create an instrument track and try again"
    : error;
}

function defaultNewId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------------------
// Atomic execution of one load_plugin(trackId, pluginId) command.
// ---------------------------------------------------------------------------------------

async function runAtomicLoadV1(
  payload: NativeSkillPayloadV1,
  environment: StudioSkillEnvironmentV1,
  before: Snapshot,
  trackId: string,
  entry: PluginEntry,
  epochAtStart: number,
  sourceAtStart: SourceStatusSnapshotV1,
): Promise<SkillOutcomeV1> {
  const newId = environment.newId ?? defaultNewId;
  const transactionId = newId();
  const requestId = newId();
  const catalogId = entry.loadKey;
  const steps = [{ call: { command: "load_plugin", args: { trackId, pluginId: catalogId } }, meta: { transactionId, requestId, index: 0 } }];
  const transaction = { transactionId, name: payload.id, manifest: [{ index: 0, requestId, command: "load_plugin" }], steps };

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
    slots: { trackId, pluginId: catalogId },
    before,
    transaction,
    verifyPostcondition: (_before, after) => verifyPluginAddedOnceV1(before, after, trackId, catalogId),
  };

  const result = await runAtomicSkillPlanV1(plan, { snapshot: environment.snapshot, exec: environment.exec, guard });

  if (result.ok) {
    addPluginRecent(entry.uid);
    return { kind: "completed", skill: payload.id, version: payload.version, say: payload.responses.completed, changes: null };
  }

  const unserved = result.outcome === "no_edit";
  let code: SkillReasonCodeV1;
  if (reasonCode) code = reasonCode;
  else if (result.outcome === "needs_recovery") code = "rollback_failed";
  else if (result.stage === "postcondition") code = "postcondition_failed";
  else code = "command_failed";

  // A command_failed (the load_plugin call itself was refused, e.g. an instrument
  // plug-in on a plain audio track) gets producer-facing guidance derived from the
  // engine's own refusal text — every other reason keeps the payload's generic blocked
  // response.
  const say = code === "command_failed" ? mismatchGuidance(result.reason) : payload.responses.blocked;
  return { kind: "blocked", skill: payload.id, version: payload.version, code, say, unserved };
}

// ---------------------------------------------------------------------------------------
// Continuation issue/resume (mirrors explicitBalance.ts's real-clock discipline)
// ---------------------------------------------------------------------------------------

function matchChoiceReply(reply: string, choices: readonly ContinuationChoiceValueV1[], entries: readonly PluginEntry[]): string | null {
  const normalized = reply.trim().toLowerCase();
  const numbered = normalized.match(/^(?:option\s+)?([1-5])$/)?.[1];
  if (numbered) return choices[Number(numbered) - 1]?.value as string ?? null;
  const exact = choices.find((choice) => choice.id.toLowerCase() === normalized || choice.label.toLowerCase() === normalized);
  if (exact) return exact.value as string;
  const fuzzy = resolvePluginMatch(entries, reply);
  return fuzzy.kind === "unique" ? fuzzy.entry.loadKey : null;
}

async function issueChoiceV1(
  payload: NativeSkillPayloadV1,
  environment: StudioSkillEnvironmentV1,
  choices: readonly PluginChoiceV1[],
  trackId: string,
): Promise<SkillOutcomeV1> {
  const nowMs = Date.now();
  const candidates: ContinuationChoiceValueV1[] = choices.map((choice, index) => ({
    id: String(index + 1), label: choice.label, value: choice.entry.loadKey,
  }));
  const targetIdentities: readonly ResolvedTargetIdentityV1[] = [{ role: "trackId", entityKind: "track", entityId: trackId }];
  const payloadRecord: ContinuationPayloadV1 = {
    skillId: payload.id, version: payload.version, artifactSha256: payload.compatibility.nativeSourceSha256,
    choices: candidates, targetIdentities, projectEpoch: environment.context().projectEpoch,
    registryGeneration: 0, sourceStatusGeneration: 0, createdAtMs: nowMs, expiresAtMs: nowMs + 600_000,
    attempts: 0, pendingKind: "choice", pendingSlot: "pluginName", choiceReason: "ambiguity",
  };
  const issued = loadNamedPluginContinuations.issue(payloadRecord);
  if (!issued.ok) return blocked(payload, "provider_unavailable", payload.responses.blocked);
  const options: readonly SkillChoiceV1[] = candidates.map((choice) => ({ id: choice.id, label: choice.label }));
  return {
    kind: "needs_choice", skill: payload.id, version: payload.version,
    say: `choose 1–${choices.length}: ${numberedChoicesV1(choices)}`,
    options, continuationToken: issued.token,
  };
}

// ---------------------------------------------------------------------------------------
// Handler entry point
// ---------------------------------------------------------------------------------------

export const loadNamedPluginV1: NativeSkillHandlerV1 = async ({ payload, environment, utterance, slots, continuationToken }) => {
  if (continuationToken) {
    const taken = loadNamedPluginContinuations.take(continuationToken, Date.now());
    if (!taken.ok) return blocked(payload, "stale_context", "That choice has expired — ask again.");
    if (taken.payload.skillId !== payload.id || taken.payload.artifactSha256 !== payload.compatibility.nativeSourceSha256) {
      return blocked(payload, "stale_context", "That choice is no longer valid — ask again.");
    }
    if (environment.context().projectEpoch !== taken.payload.projectEpoch) {
      return blocked(payload, "stale_context", "The project changed — ask again.");
    }
    const trackId = taken.payload.targetIdentities[0]?.entityId;
    if (!trackId || environment.context().selectedTrackId !== trackId) {
      return blocked(payload, "stale_context", "The selected track changed — ask again.");
    }

    // Re-read list_plugins on resume — the chosen catalog id must remain loadable.
    const observed = await observePluginsV1(environment);
    if (!observed.ok) return blocked(payload, "observation_failed", observed.reason);
    const replyText = typeof slots.reply === "string" ? slots.reply : utterance;
    const catalogId = matchChoiceReply(replyText, taken.payload.choices, observed.value);
    if (!catalogId) {
      return blocked(payload, "invalid_slot", `choose 1–${taken.payload.choices.length}`);
    }
    const entry = observed.value.find((candidate) => candidate.loadKey === catalogId);
    if (!entry) return blocked(payload, "stale_context", "That plug-in is no longer available — rescan and try again.");

    let before: Snapshot;
    try {
      before = await environment.snapshot();
    } catch (error) {
      return blocked(payload, "observation_failed", `Could not read session state: ${detail(error)}.`);
    }
    const sourceAtStart = await readSourceStatusSnapshotV1(environment);
    if (!sourceAtStart) return blocked(payload, "observation_failed", "Could not verify source status.");
    return runAtomicLoadV1(payload, environment, before, trackId, entry, taken.payload.projectEpoch, sourceAtStart);
  }

  const query = typeof slots.pluginName === "string" && slots.pluginName.length > 0
    ? slots.pluginName
    : pluginQueryV1(utterance);
  if (!query) return blocked(payload, "unsupported_intent", payload.responses.blocked);

  const initial = environment.context();
  if (!initial.selectedTrackId) return blocked(payload, "missing_target", "Select the track you want me to load it on.");
  const track = initial.tracks.find((candidate) => candidate.id === initial.selectedTrackId);
  if (!track) return blocked(payload, "stale_context", "That selected track is no longer available.");

  let before: Snapshot;
  try {
    before = await environment.snapshot();
  } catch (error) {
    return blocked(payload, "observation_failed", `Could not read session state: ${detail(error)}.`);
  }
  const epochAtStart = initial.projectEpoch;

  const observed = await observePluginsV1(environment);
  if (!observed.ok) return blocked(payload, "observation_failed", observed.reason);
  if (environment.context().projectEpoch !== epochAtStart) {
    return blocked(payload, "stale_context", "The project changed while I was finding that plug-in — try again.");
  }

  const match = resolvePluginMatch(observed.value, query);
  if (match.kind === "none") {
    return blocked(payload, "missing_target", `I couldn't find ${query} — open Plug-in Manager or rescan, then try again.`);
  }
  if (match.kind === "ambiguous") {
    const choices = pluginChoicesV1(match.entries);
    return issueChoiceV1(payload, environment, choices, track.id);
  }

  const sourceAtStart = await readSourceStatusSnapshotV1(environment);
  if (!sourceAtStart) return blocked(payload, "observation_failed", "Could not verify source status.");
  return runAtomicLoadV1(payload, environment, before, track.id, match.entry, epochAtStart, sourceAtStart);
};

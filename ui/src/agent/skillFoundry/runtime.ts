// Skill Foundry Slice B, Task 6 — the one studio-skill runtime: registry construction,
// continuation-first resume, deterministic native matching, and dispatch.
//
// SCOPE: this module owns SELECTION (which registered skill, if any, an utterance names)
// and DISPATCH (native handler call, or — once Slice D/E ship declarative candidates —
// `executeDeclarativeSkillV1`). It does not implement a second copy of any Slice A
// validation/adaptation logic: registry construction goes through `registry.ts`'s
// `buildStudioSkillRegistryV1` over candidates `loadCertifiedOwnerSkillsV1`/
// `loadBundledNativeSkillsV1` (Task 9, `loadCertifiedSkills.ts`) already validated.
//
// Native continuation routing: `NativeSkillHandlerV1`'s signature (contracts.ts, frozen)
// takes only an opaque `continuationToken?` — no continuation store. Each native handler
// that issues one (explicitBalanceV1, loadNamedPluginV1) owns a PRIVATE
// `ContinuationStoreV1` and validates/consumes its own tokens; this runtime does not
// reach into that. What the runtime DOES need, and a handler cannot provide on its own,
// is ROUTING: given a bare token on resume, which of the four native handlers issued it?
// This module answers that with its own lightweight, in-memory `token -> handlerKey`
// table, populated the instant a handler's outcome carries a fresh `continuationToken`
// (Task 6's own "AgentComposer stores only string|null" — the token is opaque to every
// caller BUT the runtime, which is the one thing that has to route it back). This table
// is cleared on `onProjectReplaced()` alongside the constructor-supplied `continuations`
// store (reserved for a future declarative-skill dispatch path — Slice B ships none).

import { matchExplicitBalanceUtteranceV1, matchTakeCycleActionV1 } from "./native/matchers";
import { matchSessionControlActionV1 } from "./native/sessionControl";
import { clearLoadNamedPluginContinuationsV1, pluginQueryV1 } from "./native/loadNamedPlugin";
import { clearExplicitBalanceContinuationsV1 } from "./native/explicitBalance";
import { createContinuationStoreV1 } from "./continuations";
import { buildStudioSkillRegistryV1 } from "./registry";
import { loadBundledNativeSkillsV1, loadCertifiedOwnerSkillsV1 } from "./loadCertifiedSkills";
import { readBundledNativeSkillsV1, readCertifiedSkillPackagesV1 } from "./nativeReads";
import { catalogFingerprintV1 } from "./catalogs";
import { NATIVE_HANDLERS_V1, NATIVE_PAYLOADS_V1 } from "./native/index";
import { adaptCodeBoundNativeSkillV1 } from "./nativeAdapter";
import type {
  NativeSkillPayloadV1,
  RegisteredSkillV1,
  SkillCompatibilityContextV1,
  SkillOutcomeV1,
  SlotValueV1,
  StudioSkillEnvironmentV1,
  StudioSkillRuntimeInputV1,
  StudioSkillRuntimeV1,
} from "./contracts";

function isNativePayload(manifest: RegisteredSkillV1["manifest"]): manifest is NativeSkillPayloadV1 {
  return (manifest as { implementation?: string }).implementation === "native";
}

function nativeById(
  registry: StudioSkillRuntimeInputV1["registry"],
  id: NativeSkillPayloadV1["id"],
): RegisteredSkillV1 | null {
  const registered = registry.get(id);
  if (!registered || registered.origin !== "native" || !isNativePayload(registered.manifest)) return null;
  return registered;
}

/** DESIGN DECISION: the deterministic core-phrase match, in a FIXED order (session-control,
 *  capture-review-choose-take, explicit-balance, load-named-plugin). Each native id's own
 *  matcher decides recognition; the first that recognizes the utterance wins — there is no
 *  scoring/ranking step because these four vocabularies do not overlap (a phrase like
 *  "stop" cannot also parse as an explicit-balance or plug-in ask). This is the "retrieve
 *  at most three, deterministic when unique" half of spec 9.2's pipeline; the "otherwise
 *  ask the brain" half is out of this slice's scope (see matchers.ts's own note). */
function matchDeterministicV1(
  utterance: string,
): { readonly id: NativeSkillPayloadV1["id"]; readonly slots: Readonly<Record<string, SlotValueV1>> } | null {
  const sessionAction = matchSessionControlActionV1(utterance);
  if (sessionAction) return { id: "session-control", slots: { action: sessionAction } };

  const takeAction = matchTakeCycleActionV1(utterance);
  if (takeAction) return { id: "capture-review-choose-take", slots: { action: takeAction } };

  const balance = matchExplicitBalanceUtteranceV1(utterance);
  if (balance) {
    const slots: Record<string, SlotValueV1> = { action: balance.action };
    if (balance.db !== undefined) slots.db = balance.db;
    if (balance.trackName !== undefined) slots.trackName = balance.trackName;
    return { id: "explicit-balance", slots };
  }

  if (pluginQueryV1(utterance)) return { id: "load-named-plugin", slots: {} };

  return null;
}

function unsupported(say: string): SkillOutcomeV1 {
  return { kind: "unsupported", code: "no_match", say };
}

export function createStudioSkillRuntimeV1(input: StudioSkillRuntimeInputV1): StudioSkillRuntimeV1 {
  // token -> handlerKey routing table (see module header). Cleared with the constructor's
  // own `continuations` store on project/registry replacement.
  const tokenRoutes = new Map<string, NativeSkillPayloadV1["handlerKey"]>();

  async function dispatchNativeV1(
    registered: RegisteredSkillV1,
    utterance: string,
    environment: StudioSkillEnvironmentV1,
    slots: Readonly<Record<string, SlotValueV1>>,
    continuationToken?: string,
  ): Promise<SkillOutcomeV1> {
    const payload = registered.manifest as NativeSkillPayloadV1;
    const handler = input.nativeHandlers[payload.handlerKey];
    if (continuationToken) tokenRoutes.delete(continuationToken);
    const outcome = await handler({ payload, environment, utterance, slots, continuationToken });
    if (outcome.kind === "needs_choice") tokenRoutes.set(outcome.continuationToken, payload.handlerKey);
    return outcome;
  }

  return {
    run: async (utterance, environment, continuationToken) => {
      // ── continuation FIRST — a pending choice always resumes before any new match ──
      if (continuationToken) {
        const handlerKey = tokenRoutes.get(continuationToken);
        if (!handlerKey) {
          return { kind: "blocked", skill: "", version: "", code: "stale_context", say: "That choice has expired — ask again.", unserved: true };
        }
        const registered = input.registry.list().find(
          (candidate) => candidate.origin === "native" && isNativePayload(candidate.manifest) && candidate.manifest.handlerKey === handlerKey,
        );
        if (!registered) {
          tokenRoutes.delete(continuationToken);
          return { kind: "blocked", skill: "", version: "", code: "stale_context", say: "That skill is no longer available — ask again.", unserved: true };
        }
        return dispatchNativeV1(registered, utterance, environment, {}, continuationToken);
      }

      // ── deterministic core-phrase match over the PUBLISHED registry only ──
      const matched = matchDeterministicV1(utterance);
      if (!matched) return unsupported("I can't do that reliably yet.");

      const registered = nativeById(input.registry, matched.id);
      if (!registered) return unsupported("I can't do that reliably yet.");

      return dispatchNativeV1(registered, utterance, environment, matched.slots);
    },
    onProjectReplaced: () => {
      tokenRoutes.clear();
      input.continuations.clear();
      // Each native handler that issues its own continuations owns a PRIVATE store (see
      // module header) — clear those too, or a stale choice from before the replacement
      // could still be answered.
      clearExplicitBalanceContinuationsV1();
      clearLoadNamedPluginContinuationsV1();
    },
  };
}

// ---------------------------------------------------------------------------------------
// Default asynchronous construction — studioSkills.ts's public `runStudioSkill` delegate
// awaits this once and reuses the resulting runtime for every subsequent call.
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: not given an exact shape — the default boot needs SOME
// `SkillCompatibilityContextV1` to hand `loadCertifiedOwnerSkillsV1`/`loadBundledNativeSkillsV1`,
// but nothing in this slice's file map owns "read the running build's own git commit/app
// version" (that is native, packaged-app infrastructure outside ui/src). Slice B has zero
// bundled resources to load either way (same posture Slice A documents for its own loaders),
// so the exact values here only matter for the SHAPE of the boot, not for admitting any real
// package — a fixed, clearly-labeled "unknown build" identity keeps the boot itself honest
// (never silently claims a specific commit it cannot actually verify) while still exercising
// the full loader pipeline every launch.
async function defaultCompatibilityContextV1(): Promise<SkillCompatibilityContextV1> {
  const catalogFingerprint = await catalogFingerprintV1();
  return {
    appVersion: "0.0.0",
    gitCommit: "0".repeat(40),
    gitState: "unknown",
    moshBuildIdentity: "unknown",
    catalogFingerprint,
    nativeSourceSha256ByHandler: {
      sessionControlV1: "0".repeat(64),
      takeCycleV1: "0".repeat(64),
      explicitBalanceV1: "0".repeat(64),
      loadNamedPluginV1: "0".repeat(64),
    },
  };
}

let defaultRuntimePromise: Promise<StudioSkillRuntimeV1> | null = null;

// DESIGN DECISION — CODE-BOUND SEEDING (owner decision): builds one registry candidate per
// compiled-in payload (`NATIVE_PAYLOADS_V1`, native/payloads.ts) via `adaptCodeBoundNativeSkillV1`
// (nativeAdapter.ts — see its own header for the full trust-root reasoning). Takes NO
// parameters: the only data it can ever process is the compiled-in constant it imports
// directly, so there is no route from here to a byte a user, a plugin, or a resource on disk
// supplied. This is the ONLY call site of `adaptCodeBoundNativeSkillV1` in production code —
// see codeBoundNativeBoundary.test.ts for the durable guard that keeps it that way.
//
// A payload literal failing adaptation here would mean `native/payloads.ts` itself is broken
// (a build-time bug in a compiled-in constant, not a runtime attacker) — quarantined rather
// than thrown, matching every other loader's "one bad candidate never takes down the boot"
// discipline, but this path should never actually see a failure in practice.
function buildCodeBoundNativeSkillCandidatesV1(): {
  readonly accepted: readonly RegisteredSkillV1[];
  readonly quarantined: readonly { readonly id: string; readonly code: string; readonly message: string }[];
} {
  const accepted: RegisteredSkillV1[] = [];
  const quarantined: { id: string; code: string; message: string }[] = [];
  for (const payload of NATIVE_PAYLOADS_V1) {
    const adapted = adaptCodeBoundNativeSkillV1(payload);
    if (adapted.ok) accepted.push(adapted.value);
    else quarantined.push({ id: adapted.id, code: adapted.code, message: adapted.message });
  }
  return { accepted, quarantined };
}

// PRECEDENCE (owner decision): a bundled-index-accepted native candidate (`bundledAccepted` —
// `loadBundledNativeSkillsV1`'s real `.accepted`, an EXTERNAL artifact-graph loader) WINS over
// a code-bound one (`codeBoundAccepted` — `buildCodeBoundNativeSkillCandidatesV1()`'s
// compiled-in seed) with the SAME id — post-ship native staging (Slice E) can then update a
// core skill without an app release, and should be able to shadow the compiled-in default once
// it does. Only code-bound ids ABSENT from `bundledAccepted` are appended; duplicate ids within
// one `native` candidate list would otherwise be rejected by `buildStudioSkillRegistryV1` as a
// same-origin collision (registry.ts) rather than resolved by precedence. Exported (pure, no
// I/O) so the precedence rule itself is directly testable without standing up a full
// artifact-graph fixture through the bridge — see runtime.precedence.test.ts.
export function mergeCodeBoundNativeCandidatesV1(
  bundledAccepted: readonly RegisteredSkillV1[],
  codeBoundAccepted: readonly RegisteredSkillV1[],
): readonly RegisteredSkillV1[] {
  const bundledIds = new Set(bundledAccepted.map((candidate) => candidate.id));
  return [...bundledAccepted, ...codeBoundAccepted.filter((candidate) => !bundledIds.has(candidate.id))];
}

/** Builds the default runtime exactly once per process: reads both certified-package
 *  sources, validates every candidate through Slice A's real chain checks (a failure
 *  quarantines that ONE package, never the whole boot), adapts native survivors, and
 *  publishes ONE atomic registry generation. Never adapts the handler map directly —
 *  `NATIVE_HANDLERS_V1` is the closed map every call goes through regardless of which
 *  (if any) native packages were admitted.
 *
 *  CODE-BOUND SEEDING (owner decision): both `ownerLoad`/`nativeLoad` above are EXTERNAL
 *  artifact-graph loaders (owner packages under $MOSH_AGENT_DIR, the app's staged bundled
 *  native resources) — both empty in a shipped app until Slice E's post-ship staging lands
 *  (bridge.ts's `realNative()` gate; nativeReads.ts's EMPTY_* envelope note). Without a
 *  second seed, the registry would be empty and the four core skills — including
 *  `load_named_plugin`, which works in production today via the legacy `studioSkills.ts`
 *  path — would be INACTIVE (the regression flagged in 0e860fea's own commit message).
 *  `buildCodeBoundNativeSkillCandidatesV1()` seeds those same four ids directly from the
 *  compiled-in `NATIVE_PAYLOADS_V1`, whose trust root is the app's own code signature rather
 *  than an external artifact graph. `mergeCodeBoundNativeCandidatesV1` (above) applies the
 *  precedence rule between the two. */
async function buildDefaultRuntimeV1(): Promise<StudioSkillRuntimeV1> {
  const compatibility = await defaultCompatibilityContextV1();

  const ownerLoad = await loadCertifiedOwnerSkillsV1({ readPackages: readCertifiedSkillPackagesV1, compatibility });
  const nativeLoad = await loadBundledNativeSkillsV1({ readBundledNative: readBundledNativeSkillsV1, compatibility });

  const codeBound = buildCodeBoundNativeSkillCandidatesV1();
  const nativeCandidates = mergeCodeBoundNativeCandidatesV1(nativeLoad.accepted, codeBound.accepted);

  const registryResult = await buildStudioSkillRegistryV1({
    generation: 1,
    native: nativeCandidates,
    builtin: [],
    owner: ownerLoad.accepted,
  });

  // A same-origin/cross-origin collision at this late stage is already impossible in
  // practice (loadCertifiedOwnerSkillsV1/loadBundledNativeSkillsV1 each de-duplicate their
  // own accepted set), but the atomic-publish discipline still applies: never publish a
  // partial registry. Fail closed to an EMPTY registry generation rather than throwing
  // across the boot boundary.
  const registry = registryResult.ok
    ? registryResult.registry
    : { generation: 0, get: () => null, list: () => [] };

  return createStudioSkillRuntimeV1({
    registry,
    continuations: createContinuationStoreV1(),
    nativeHandlers: NATIVE_HANDLERS_V1,
  });
}

function defaultRuntimeV1(): Promise<StudioSkillRuntimeV1> {
  if (!defaultRuntimePromise) defaultRuntimePromise = buildDefaultRuntimeV1();
  return defaultRuntimePromise;
}

/** `createStudioSkillRuntimeV1(...).onProjectReplaced()` clears its injected store — this
 *  is the compatibility seam `studioSkills.ts`'s `clearStudioSkillContinuations()`
 *  delegates ONLY to (Task 6's own instruction): await the default runtime and call its
 *  `onProjectReplaced()`, never rebuild the registry itself. Rebuilding the registry from
 *  disk again is a separate, heavier operation this function does not perform. */
export async function clearDefaultStudioSkillContinuationsV1(): Promise<void> {
  const runtime = await defaultRuntimeV1();
  runtime.onProjectReplaced();
}

/** Test-only seam: forces the next call to rebuild the default runtime from scratch (a
 *  fresh registry generation). Never called from production code — a real registry
 *  rebuild happens only via `clearDefaultStudioSkillContinuationsV1()`'s `onProjectReplaced()`
 *  path plus the app's own relaunch, per spec 9.1 ("V1 scans packages only at app startup"). */
export function __resetDefaultStudioSkillRuntimeForTestsV1(): void {
  defaultRuntimePromise = null;
}

/** The locked public entry point (Cross-Slice APIs block): awaits the lazily-constructed
 *  default runtime, then calls its `run`. Exact signature preserved. */
export async function runStudioSkillV1(
  utterance: string,
  environment: StudioSkillEnvironmentV1,
  continuationToken?: string,
): Promise<SkillOutcomeV1> {
  const runtime = await defaultRuntimeV1();
  return runtime.run(utterance, environment, continuationToken);
}

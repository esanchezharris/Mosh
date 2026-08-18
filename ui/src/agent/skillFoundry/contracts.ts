// Task 1 — Skill Foundry v1 wire types (spec Sections 6.2, 7.2, 8.1-8.6, 10.3, and the
// plan's Cross-Slice APIs block). This module is the single source of truth for every
// `*V1` TYPE in the slice: it declares shapes only, never logic. Every other Skill
// Foundry module imports its types from here rather than redeclaring them, so a type
// named once never drifts into two incompatible shapes across files.
//
// A number of types below are REFERENCED by name in the plan (because a later task's
// function signature or a Cross-Slice API entry needs them) but are not given an exact
// field-for-field shape anywhere in the plan or spec. Each such type is marked
// `// DESIGN DECISION` with the reasoning; see this task's final report for the full
// list. Every type that DOES have an exact shape in the spec or plan is copied
// field-for-field and is not a judgment call.

import type { AgentCommandCall, ChangeSet } from "../executor";
import type { BridgeResult } from "../skillHarness";
import type { TxnMeta } from "../skillTransaction";
import type { StudioContext } from "../studioSkills";
import type { Snapshot } from "../../types";

// ---------------------------------------------------------------------------------------
// Parsing primitives (Cross-Slice APIs — "// contracts.ts")
// ---------------------------------------------------------------------------------------

export type ParseIssueV1 = { readonly code: string; readonly path: string; readonly message: string };

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ParseIssueV1[] };

// ---------------------------------------------------------------------------------------
// 6.2 — Source-card admission
// ---------------------------------------------------------------------------------------

export type SourceStatusV1 = {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly updatedAt: string;
  readonly entries: readonly {
    readonly sourceCardId: string;
    readonly sourceSnapshotSha256: string;
    readonly state: "current" | "stale" | "superseded" | "revoked";
    readonly checkedAt: string;
    readonly reviewAfter: string;
  }[];
};

// ---------------------------------------------------------------------------------------
// 7.2 — Optional Ableton reference session evidence
// ---------------------------------------------------------------------------------------

export type AbletonReferenceV1 = {
  readonly schemaVersion: 1;
  readonly journeyId: string;
  readonly liveVersion: string;
  readonly startedAt: string;
  readonly goal: string;
  readonly checkpoints: readonly {
    readonly name: string;
    readonly narration: string;
    readonly observedState?: Readonly<Record<string, unknown>>;
    readonly unobservedOrAmbiguous: readonly string[];
  }[];
  readonly beforeSet?: { readonly path: string; readonly sha256: string };
  readonly afterSet?: { readonly path: string; readonly sha256: string };
  readonly ownerRules: { readonly variables: readonly string[]; readonly forbidden: readonly string[] };
};

// ---------------------------------------------------------------------------------------
// 8.1 — Manifest, release, activation, provenance, certification, approval
// ---------------------------------------------------------------------------------------

export type SkillReasonCodeV1 =
  | "no_match"
  | "ambiguous_skill"
  | "missing_slot"
  | "invalid_slot"
  | "missing_target"
  | "ambiguous_target"
  | "stale_context"
  | "observation_failed"
  | "manifest_stale"
  | "command_failed"
  | "rollback_failed"
  | "postcondition_failed"
  | "missing_primitive"
  | "provider_unavailable"
  | "timeout"
  | "unsupported_intent";

export type SkillManifestV1 = {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description: string;
  readonly implementation: "declarative";
  readonly intents: {
    readonly positiveExamples: readonly string[];
    readonly negativeExamples: readonly string[];
    readonly tags: readonly string[];
  };
  readonly slots: readonly SkillSlotV1[];
  readonly preconditions: readonly PredicateV1[];
  readonly steps: readonly SkillStepV1[];
  readonly postconditions: readonly PredicateV1[];
  readonly execution: {
    readonly mode: "atomic" | "lifecycle" | "best_effort";
    // Review-bound: this exact value is what confirmation-review hashing binds to. Never
    // defaulted or normalized before that hash is computed — see packageValidation.ts.
    readonly confirmation: "never" | "on_ambiguity" | "always";
    readonly maxMutations: number;
    readonly timeoutMs: number;
  };
  readonly responses: {
    readonly completed: string;
    readonly needsChoice: string;
    readonly blocked: string;
  };
  readonly provenance: readonly SourceRefV1[];
  readonly compatibility: {
    readonly minMoshVersion: string;
    readonly commandCatalogSha256: string;
    readonly predicateCatalogVersion: number;
    readonly resolverCatalogVersion: number;
  };
};

export type SkillReleaseV1 = {
  readonly schemaVersion: 1;
  readonly state: "certified";
  readonly skillId: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
  readonly certifiedAt: string;
};

export type SkillActivationIndexV1 = {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly skills: Readonly<Record<string, {
    readonly version: string;
    readonly manifestSha256: string;
    readonly releaseSha256: string;
  }>>;
};

export type SourceRefV1 = {
  readonly sourceCardId: string;
  readonly claimIds: readonly string[];
  readonly sourceSnapshotSha256: string;
};

export type SkillArtifactRefV1 =
  | { readonly kind: "declarative_manifest"; readonly sha256: string }
  | { readonly kind: "native_payload"; readonly sha256: string };

export type CertificationReportV1 = {
  readonly schemaVersion: 1;
  readonly state: "acceptance_green";
  readonly runId: string;
  readonly skillId: string;
  readonly version: string;
  readonly artifact: SkillArtifactRefV1;
  readonly evalSha256: string;
  readonly gitCommit: string;
  readonly moshBuildIdentity: string;
  readonly commandCatalogSha256: string;
  readonly predicateCatalogVersion: number;
  readonly resolverCatalogVersion: number;
  readonly sourceStatusIndexSha256: string;
  readonly gates: readonly {
    readonly name: "schema" | "mock" | "native" | "packaged" | "acceptance";
    readonly status: "passed";
    readonly startedAt: string;
    readonly finishedAt: string;
    readonly passed: number;
    readonly total: number;
    readonly artifactHashes: readonly string[];
  }[];
  readonly manualEvidenceSha256: readonly string[];
  readonly frozenAt: string;
};

export type SkillApprovalV1 = {
  readonly schemaVersion: 1;
  readonly state: "owner_approved";
  readonly reviewSha256: string;
  readonly artifact: SkillArtifactRefV1;
  readonly certificationReportSha256: string;
  readonly exactStatement: string;
  readonly actor: string;
  readonly channel: string;
  readonly conversationLocator?: string;
  readonly approvedAt: string;
};

export type NativeSkillPayloadV1 = {
  readonly schemaVersion: 1;
  readonly id: "session-control" | "capture-review-choose-take" | "explicit-balance" | "load-named-plugin";
  readonly version: string;
  readonly implementation: "native";
  readonly handlerKey: "sessionControlV1" | "takeCycleV1" | "explicitBalanceV1" | "loadNamedPluginV1";
  readonly title: string;
  readonly description: string;
  readonly intents: SkillManifestV1["intents"];
  readonly slots: readonly SkillSlotV1[];
  readonly execution: {
    readonly mode: "atomic" | "lifecycle" | "best_effort";
    readonly confirmation: "never" | "on_ambiguity" | "always";
  };
  readonly responses: SkillManifestV1["responses"];
  readonly provenance: readonly SourceRefV1[];
  readonly legacyAliases: readonly string[];
  readonly compatibility: SkillManifestV1["compatibility"] & { readonly nativeSourceSha256: string };
};

export type NativeSkillBundleEntryV1 = {
  readonly schemaVersion: 1;
  readonly state: "owner_approved";
  readonly skillId: NativeSkillPayloadV1["id"];
  readonly version: string;
  readonly nativePayloadSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
  readonly moshBuildIdentity: string;
  readonly bundledAt: string;
};

export type NativeReleaseVerificationV1 = {
  readonly schemaVersion: 1;
  readonly state: "release_packaged_green";
  readonly nativePayloadSha256: string;
  readonly certificationReportSha256: string;
  readonly approvalSha256: string;
  readonly bundleEntrySha256: string;
  readonly moshBuildIdentity: string;
  readonly bundleSha256: string;
  readonly codeSignatureCDHash: string;
  readonly checks: readonly {
    readonly name: "native_selftest" | "live_shell" | "protools_shell" | "resource_index" | "candidate_loader_absent";
    readonly status: "passed";
    readonly artifactHashes: readonly string[];
  }[];
  readonly verifiedAt: string;
};

// ---------------------------------------------------------------------------------------
// 8.2 — Slots
// ---------------------------------------------------------------------------------------

export type SlotValueV1 = string | number | boolean | string[];

export type SkillSlotV1 = {
  readonly name: string;
  readonly type: "string" | "number" | "boolean" | "enum" | "string[]";
  readonly required: boolean;
  readonly source: "utterance" | "context" | "observation";
  readonly default?: SlotValueV1;
  readonly enumValues?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly description: string;
};

// ---------------------------------------------------------------------------------------
// 8.3 — Typed value references
// ---------------------------------------------------------------------------------------

export type ValueRefV1 =
  | { readonly literal: string | number | boolean }
  | { readonly slot: string }
  | { readonly context: "selectedTrackId" | "projectEpoch" }
  | { readonly binding: string }
  | { readonly each: string; readonly field?: string };

// ---------------------------------------------------------------------------------------
// 8.4 — Steps and predicates
// ---------------------------------------------------------------------------------------

export type SkillStepV1 =
  | { readonly kind: "observe"; readonly command: string; readonly args: Readonly<Record<string, ValueRefV1>>; readonly bind: string }
  | { readonly kind: "resolve"; readonly resolver: string; readonly input?: ValueRefV1; readonly bind: string; readonly maxChoices: number }
  | { readonly kind: "mutate"; readonly command: string; readonly args: Readonly<Record<string, ValueRefV1>>; readonly forEach?: string };

export type PredicateV1 = {
  readonly name: string;
  readonly args: Readonly<Record<string, ValueRefV1>>;
};

// ---------------------------------------------------------------------------------------
// 8.6 — Outcomes
// ---------------------------------------------------------------------------------------

export type SkillChoiceV1 = {
  readonly id: string;
  readonly label: string;
};

// The spec's pseudocode types `code` as a bare `string`; this task uses the exact
// `SkillReasonCodeV1` union instead (the plan explicitly calls for defining and using
// that union). This is a stricter, not a looser, reading — every `SkillReasonCodeV1` is a
// valid `string`, so nothing that satisfied the spec's literal shape stops satisfying
// this one.
export type SkillOutcomeV1 =
  | { readonly kind: "completed"; readonly skill: string; readonly version: string; readonly say: string; readonly changes: ChangeSet | null }
  | { readonly kind: "needs_choice"; readonly skill: string; readonly version: string; readonly say: string; readonly options: readonly SkillChoiceV1[]; readonly continuationToken: string }
  | { readonly kind: "blocked"; readonly skill: string; readonly version: string; readonly code: SkillReasonCodeV1; readonly say: string; readonly unserved: boolean }
  | { readonly kind: "unsupported"; readonly code: SkillReasonCodeV1; readonly say: string };

// ---------------------------------------------------------------------------------------
// 10.3 — Manual (physical/taste) evidence
// ---------------------------------------------------------------------------------------

export type ManualEvidenceV1 = {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly caseId: string;
  readonly artifact: SkillArtifactRefV1;
  readonly evalSha256: string;
  readonly expectedObservation: string;
  readonly decision: "passed" | "failed" | "physical_not_required";
  readonly observed: string;
  readonly actor: string;
  readonly recordedAt: string;
  readonly artifacts: readonly {
    readonly kind: "audio" | "image" | "video" | "log" | "other";
    readonly localPath: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
};

// ---------------------------------------------------------------------------------------
// Native-read wire types (Task 1 Step 3's "exact bytes" block)
// ---------------------------------------------------------------------------------------

export type CertifiedSkillFileV1 = {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly utf8: string;
};

// DESIGN DECISION: not given an exact shape anywhere. Modeled as a bounded, generic
// `{path, code, message}` diagnostic (mirroring `ParseIssueV1`'s shape) since it is the
// low-level per-entry diagnostic the native loader (Task 4's `CertifiedSkillLoader`)
// attaches to a package/index it could not admit, before any semantic (JS-side)
// validation runs. Distinct from `loadCertifiedSkills.ts`'s higher-level quarantine
// record (Task 9), which additionally carries the candidate's `id`.
export type CertifiedSkillLoadDiagnosticV1 = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type CertifiedSkillPackageBytesV1 = {
  readonly directoryName: string;
  readonly skillIdFromDirectory: string;
  readonly versionFromDirectory: string;
  readonly files: {
    readonly skill: CertifiedSkillFileV1;
    readonly certification: CertifiedSkillFileV1;
    readonly approval: CertifiedSkillFileV1;
    readonly release: CertifiedSkillFileV1;
  };
};

export type CertifiedSkillLoadV1 = {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly activeIndex: CertifiedSkillFileV1 | null;
  readonly sourceStatusIndex: CertifiedSkillFileV1 | null;
  readonly packages: readonly CertifiedSkillPackageBytesV1[];
  readonly diagnostics: readonly CertifiedSkillLoadDiagnosticV1[];
  readonly totalBytes: number;
};

export type SkillSourceStatusReadV1 = {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly statusIndex: CertifiedSkillFileV1 | null;
  readonly diagnostics: readonly CertifiedSkillLoadDiagnosticV1[];
};

// DESIGN DECISION: not given an exact shape. Modeled as the native-payload analogue of
// `CertifiedSkillPackageBytesV1`'s four-file topology, substituting the spec's own
// renamed fields for native packages: `skill` -> `payload` (the payload has no
// `manifestSha256`-shaped self-identity the way a declarative manifest does) and
// `release` -> `bundleEntry` (native packages ship a `NativeSkillBundleEntryV1`, not a
// `SkillReleaseV1`). Spec 8.1's "four-file topology" language for native packages
// supports this directly; the exact key names are this task's judgment call.
export type CertifiedNativeSkillPackageBytesV1 = {
  readonly directoryName: string;
  readonly skillIdFromDirectory: string;
  readonly versionFromDirectory: string;
  readonly files: {
    readonly payload: CertifiedSkillFileV1;
    readonly certification: CertifiedSkillFileV1;
    readonly approval: CertifiedSkillFileV1;
    readonly bundleEntry: CertifiedSkillFileV1;
  };
};

export type CertifiedNativeSkillLoadV1 = {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly build: {
    readonly appVersion: string;
    readonly gitCommit: string;
    readonly gitState: "clean" | "dirty" | "unknown";
    readonly moshBuildIdentity: string;
  };
  readonly resourceIndex: CertifiedSkillFileV1 | null;
  readonly packages: readonly CertifiedNativeSkillPackageBytesV1[];
  readonly diagnostics: readonly CertifiedSkillLoadDiagnosticV1[];
  readonly totalBytes: number;
};

// ---------------------------------------------------------------------------------------
// Identity inputs (Task 1 Step 3's "exact identity inputs" block)
// ---------------------------------------------------------------------------------------

export type NativeSourceByteSetV1 = {
  readonly schemaVersion: 1;
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
};

export type MoshBuildIdentityInputV1 = {
  readonly appVersion: string;
  readonly gitCommit: string;
  readonly gitState: "clean" | "dirty" | "unknown";
  readonly target: string;
  readonly configuration: string;
  readonly architecture: string;
};

export type ContinuationChoiceValueV1 = { readonly id: string; readonly label: string; readonly value: SlotValueV1 };

// DESIGN DECISION: not given an exact shape anywhere in the plan or spec. Section 8.3/8.5
// only say a continuation "captures ... resolved target identity" so a stale answer (the
// target renamed, removed, or re-resolved to a different entity between issue and resume)
// can be detected. Modeled minimally as an entity kind + ID pair, tagged with the manifest
// role (e.g. `"trackId"`) that resolved it, so `atomicPlan`/`declarativeExecutor` can
// re-resolve the same role and compare.
// Widened ADDITIVELY for Slice B (2026-08-14 four-core-runtime plan, correction 1):
// `capture-review-choose-take`'s native take handler resolves clips and stable take ids
// (state/TakeIdentity.h), not just tracks/plugins. "track" | "plugin" is Slice A's
// original, narrower union — "clip" | "take" are net-new roles a resolved target
// identity may now carry; nothing that matched the old union stops matching this one.
export type ResolvedTargetIdentityV1 = {
  readonly role: string;
  readonly entityKind: "track" | "plugin" | "clip" | "take";
  readonly entityId: string;
};

// DESIGN DECISION: `CatalogFingerprintV1`'s shape is not given explicitly. `catalogs.ts`
// (Task 2) owns `catalogFingerprintV1(): Promise<CatalogFingerprintV1>`, but the plan's
// own text right after this block (`SkillCompatibilityContextV1 carries exact ... a
// CatalogFingerprintV1 ...`) requires the TYPE here, in contracts.ts, to avoid a reverse
// import (catalogs.ts already consumes contracts.ts, per the plan's own Task 2
// "Consumes" line — the type cannot also flow the other way). Modeled to reuse the exact
// field names `SkillManifestV1.compatibility` already carries for the same concepts
// (`commandCatalogSha256`, `predicateCatalogVersion`, `resolverCatalogVersion`), so a
// compatibility check is a direct field-by-field comparison against a manifest's own
// `compatibility` block.
export type CatalogFingerprintV1 = {
  readonly schemaVersion: 1;
  readonly commandCatalogSha256: string;
  readonly predicateCatalogVersion: number;
  readonly resolverCatalogVersion: number;
};

// DESIGN DECISION: shape inferred from the plan's own prose ("SkillCompatibilityContextV1
// carries exact appVersion, gitCommit, gitState, moshBuildIdentity, CatalogFingerprintV1,
// and the canonical source-set SHA keyed by native handler"). The "keyed by native
// handler" instruction is encoded as a record over `NativeSkillPayloadV1["handlerKey"]`.
export type SkillCompatibilityContextV1 = {
  readonly appVersion: string;
  readonly gitCommit: string;
  readonly gitState: "clean" | "dirty" | "unknown";
  readonly moshBuildIdentity: string;
  readonly catalogFingerprint: CatalogFingerprintV1;
  readonly nativeSourceSha256ByHandler: Readonly<Record<NativeSkillPayloadV1["handlerKey"], string>>;
};

// ---------------------------------------------------------------------------------------
// Continuations (Task 6's exact types — hosted here so `ContinuationStoreV1`, defined
// below per the Cross-Slice APIs block, does not need a reverse import from
// continuations.ts; continuations.ts imports these from contracts.ts instead).
// ---------------------------------------------------------------------------------------

export type ContinuationPayloadBaseV1 = {
  readonly skillId: string;
  readonly version: string;
  readonly artifactSha256: string;
  readonly choices: readonly ContinuationChoiceValueV1[];
  readonly targetIdentities: readonly ResolvedTargetIdentityV1[];
  readonly projectEpoch: number;
  readonly registryGeneration: number;
  readonly sourceStatusGeneration: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly attempts: number;
};

export type ContinuationPayloadV1 = ContinuationPayloadBaseV1 & (
  | { readonly pendingKind: "choice"; readonly pendingSlot: string; readonly choiceReason: "ambiguity" | "missing_slot"; readonly confirmationPlanSha256?: never }
  | { readonly pendingKind: "confirmation"; readonly pendingSlot: "confirmation"; readonly confirmationPlanSha256: string }
);

export type ContinuationIssueResultV1 =
  | { readonly ok: true; readonly token: string; readonly expiresAtMs: number }
  | { readonly ok: false; readonly code: "invalid_payload" | "token_collision" };

export type ContinuationTakeResultV1 =
  | { readonly ok: true; readonly payload: ContinuationPayloadV1 }
  | { readonly ok: false; readonly code: "unknown_token" | "expired" };

export interface ContinuationStoreV1 {
  issue(payload: ContinuationPayloadV1): ContinuationIssueResultV1;
  take(token: string, nowMs: number): ContinuationTakeResultV1;
  clear(): void;
}

// ---------------------------------------------------------------------------------------
// Recording lifecycle (Cross-Slice APIs — "// contracts.ts")
// ---------------------------------------------------------------------------------------

// DESIGN DECISION: `RecordingLifecycleResultV1`'s shape is not given anywhere; only the
// `RecordingLifecycleEnvironmentV1` method signatures returning it are given. Section 8.5
// says lifecycle mode "reports the observed state" per bounded transition with "no atomic
// rollback claimed" — so, unlike `SkillOutcomeV1`, there is no rollback/blocked-vs-open
// transaction concept, just success-with-state or failure-with-reason. Modeled as a
// two-armed result echoing `SkillOutcomeV1`'s `say`/`changes` shape on success (for
// environment-call symmetry) and `SkillReasonCodeV1` on failure.
export type RecordingLifecycleResultV1 =
  | { readonly ok: true; readonly state: string; readonly say: string; readonly changes: ChangeSet | null }
  | { readonly ok: false; readonly code: SkillReasonCodeV1; readonly say: string };

export type RecordingLifecycleEnvironmentV1 = {
  readonly start: (bar?: number) => Promise<RecordingLifecycleResultV1>;
  readonly stop: () => Promise<RecordingLifecycleResultV1>;
  readonly audition: (delta: -1 | 1) => Promise<RecordingLifecycleResultV1>;
  readonly keep: () => Promise<RecordingLifecycleResultV1>;
};

// ---------------------------------------------------------------------------------------
// Studio skill environment and runtime (Cross-Slice APIs — "// contracts.ts")
// ---------------------------------------------------------------------------------------

export type StudioSkillEnvironmentV1 = {
  readonly context: () => StudioContext;
  readonly snapshot: () => Promise<Snapshot>;
  readonly exec: (command: string, args: Record<string, unknown>, transaction?: TxnMeta) => Promise<BridgeResult>;
  readonly readSourceStatus: () => Promise<SkillSourceStatusReadV1>;
  readonly runBatch: (label: string, calls: readonly AgentCommandCall[]) => Promise<ChangeSet>;
  readonly refresh: () => Promise<void>;
  readonly recording: RecordingLifecycleEnvironmentV1;
  readonly newId?: () => string;
  readonly nowMs?: () => number;
};

// DESIGN DECISION: not given an exact shape. `NativeSkillHandlerV1` is the function type
// held in the closed `handlerKey -> handler` map (`StudioSkillRuntimeInputV1.nativeHandlers`,
// and Task 5's "Native adapter binds only the closed handler map"). Modeled to take the
// resolved native payload, the environment, the utterance (native handlers parse/route
// their own slots — see 8.4's "may use audited TypeScript implementations for lifecycle or
// resolver behavior"), already-validated slot values, and an optional resume token, and to
// return the same `SkillOutcomeV1` union every skill terminates through (8.6).
export type NativeSkillHandlerV1 = (input: {
  readonly payload: NativeSkillPayloadV1;
  readonly environment: StudioSkillEnvironmentV1;
  readonly utterance: string;
  readonly slots: Readonly<Record<string, SlotValueV1>>;
  readonly continuationToken?: string;
}) => Promise<SkillOutcomeV1>;

export type RegisteredSkillOriginV1 = "native" | "builtin" | "owner";

// DESIGN DECISION: supporting type for `StudioSkillRegistryV1` below (also not given an
// exact shape). One registry entry, carrying enough to route an utterance (metadata) and
// dispatch it (either the native payload/handler pair, or a validated declarative
// manifest) without the caller needing to know the entry's origin ahead of time — matching
// spec 9.1's "presents native built-ins and validated declarative manifests through the
// same interface."
export type RegisteredSkillV1 = {
  readonly id: string;
  readonly origin: RegisteredSkillOriginV1;
  readonly aliases: readonly string[];
  readonly manifest: NativeSkillPayloadV1 | SkillManifestV1;
};

// DESIGN DECISION: not given an exact shape; see `RegisteredSkillV1` above. `get` resolves
// a canonical ID or alias (Task 5: "`get(idOrAlias)` lowercases ASCII and canonicalizes the
// one legacy alias"); `generation` is the atomic-publication counter `buildStudioSkillRegistryV1`
// bumps on each successful (re)build, referenced elsewhere as `registryGeneration`
// (`ContinuationPayloadBaseV1`) and `RegistryBuildInputV1.generation`.
export type StudioSkillRegistryV1 = {
  readonly generation: number;
  readonly get: (idOrAlias: string) => RegisteredSkillV1 | null;
  readonly list: () => readonly RegisteredSkillV1[];
};

export type StudioSkillRuntimeInputV1 = {
  readonly registry: StudioSkillRegistryV1;
  readonly continuations: ContinuationStoreV1;
  readonly nativeHandlers: Readonly<Record<NativeSkillPayloadV1["handlerKey"], NativeSkillHandlerV1>>;
  readonly now?: () => number;
};

export type StudioSkillRuntimeV1 = {
  readonly run: (utterance: string, environment: StudioSkillEnvironmentV1, continuationToken?: string) => Promise<SkillOutcomeV1>;
  readonly onProjectReplaced: () => void;
};

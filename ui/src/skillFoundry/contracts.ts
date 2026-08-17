// Slice D — Skill Foundry CLI/draft/source/eval/process contracts.
//
// This file owns ONLY Slice D's own CLI wire format, local draft/source/eval/process types.
// It imports Slice A runtime-artifact types (SkillManifestV1, CertificationReportV1, ...)
// from `ui/src/agent/skillFoundry/contracts.ts` rather than redefining them — Slice A is the
// semantic authority for every runtime artifact shape. New type groups are appended here,
// task by task, each under its own banner comment naming the task that introduced it.
//
import type {
  SourceStatusV1 as SliceASourceStatusV1,
  PredicateV1,
  SkillReasonCodeV1,
  CatalogFingerprintV1,
  CertificationReportV1,
  SkillArtifactRefV1,
} from "../agent/skillFoundry/contracts";
export type { PredicateV1, SkillReasonCodeV1, CatalogFingerprintV1, CertificationReportV1, SkillArtifactRefV1 };

// Task 1 — the CLI wire contract: the exhaustive `teach-moshi` command union, the stable
// JSON envelope every invocation emits, and the dependency-injection seam `runTeachMoshiV1`
// dispatches through. Concrete command handlers are wired in `commands.ts` (stubbed in Task
// 1, replaced with real service calls in Task 10); this file only fixes their SHAPE so every
// later task can target a stable contract.

// ---------------------------------------------------------------------------------------
// Task 1 — CLI wire contract
// ---------------------------------------------------------------------------------------

/**
 * Stable, additive error-code taxonomy for `CliEnvelopeV1.error.code`. Grows across tasks;
 * removing or renaming a member is a breaking change, adding one is not.
 */
export type FoundryErrorCodeV1 =
  | "usage_error"
  | "unsafe_path"
  | "quota_exceeded"
  | "draft_not_found"
  | "source_card_not_found"
  | "id_collision"
  | "draft_update_incomplete"
  | "certification_driver_unavailable"
  | "missing_reviewer_statement"
  | "stale_evidence"
  | "stale_attestation"
  | "review_sha_mismatch"
  | "package_conflict"
  | "activation_failed"
  | "gc_revalidation_failed"
  | "lock_contention"
  | "not_found"
  | "invalid_artifact"
  | "invalid_source_card"
  | "invalid_reference"
  | "source_stale"
  | "source_revoked"
  | "source_superseded"
  | "wrong_state"
  | "blocked_missing_primitive"
  | "validation_failed"
  | "io_error";

/** Exactly the fifteen `teach-moshi` commands from spec §5.3. */
export type TeachMoshiCommandNameV1 =
  | "init"
  | "add-source"
  | "add-reference"
  | "validate"
  | "certify"
  | "record-evidence"
  | "review"
  | "approve"
  | "install"
  | "rollback"
  | "revoke"
  | "refresh-source"
  | "revoke-source"
  | "gc"
  | "status";

export type TeachMoshiCommandV1 =
  | { command: "init"; goal: string; id?: string }
  | { command: "add-source"; draftId: string; cardPath: string }
  | { command: "add-reference"; draftId: string; filePath: string }
  | { command: "validate"; draftId: string }
  | { command: "certify"; draftId: string; bin: string }
  | { command: "record-evidence"; draftId: string; caseId: string; evidencePath: string }
  | { command: "review"; draftId: string }
  | { command: "approve"; draftId: string; reviewSha: string; attestationPath: string }
  | { command: "install"; draftId: string }
  | { command: "rollback"; skillId: string; version: string }
  | { command: "revoke"; skillId: string }
  | { command: "refresh-source"; cardPath: string }
  | { command: "revoke-source"; sourceCardId: string }
  | { command: "gc"; apply: boolean }
  | { command: "status"; draftId: string };

export type CliParseIssueV1 = { code: string; path: string; message: string };

export type CliArgsParseResultV1 =
  | { ok: true; value: TeachMoshiCommandV1 }
  | { ok: false; issues: readonly CliParseIssueV1[] };

/** The exactly-one-JSON-object-plus-LF envelope every `teach-moshi` invocation emits. */
export type CliEnvelopeV1<T = unknown> =
  | { schemaVersion: 1; ok: true; command: TeachMoshiCommandNameV1; result: T }
  | {
      schemaVersion: 1;
      ok: false;
      command: string;
      error: { code: FoundryErrorCodeV1; message: string; details: Record<string, unknown> };
    };

export type CliExecutionV1 = { exitCode: 0 | 1 | 2; envelope: CliEnvelopeV1 };

/** What a single command handler returns before it is wrapped into a `CliEnvelopeV1`. */
export type CommandHandlerResultV1 =
  | { ok: true; result: unknown }
  | { ok: false; code: FoundryErrorCodeV1; message: string; details?: Record<string, unknown> };

/**
 * One async handler per command, keyed by command name. `commands.ts` exports a stub
 * implementation (Task 1) that Task 10 replaces with real service wiring; `cli.ts` never
 * constructs deps itself, so tests can inject fakes.
 */
export type TeachMoshiDepsV1 = {
  [K in TeachMoshiCommandV1["command"]]: (
    command: Extract<TeachMoshiCommandV1, { command: K }>,
  ) => Promise<CommandHandlerResultV1>;
};

// ---------------------------------------------------------------------------------------
// Task 3 — exact foundry LOCAL STORAGE caps (plan Global Constraints, "Exact foundry caps").
//
// DELIBERATELY a separate name from Slice A's `FOUNDRY_LIMITS_V1` (declarative-manifest
// GRAMMAR bounds, `ui/src/agent/skillFoundry/limits.ts`) — these bound the Skill Foundry's
// own draft/source/reference/eval/state/evidence/run-artifact filesystem storage, a
// completely different axis. Never import or alias the two together.
// ---------------------------------------------------------------------------------------

export const FOUNDRY_STORAGE_LIMITS_V1 = Object.freeze({
  /** Drafts. */
  maxDrafts: 32,
  /** One draft's metadata tree, in bytes (64 MiB). */
  maxDraftBytes: 67108864,
  /** All draft metadata combined, in bytes (1 GiB). */
  maxAllDraftBytes: 1073741824,
  /** Source cards per draft. */
  maxSourceCardsPerDraft: 32,
  /** One imported source card OR attestation, in bytes (1 MiB). */
  maxSourceCardBytes: 1048576,
  /** Reference locators per draft. */
  maxReferencesPerDraft: 32,
  /** One referenced external regular file, in bytes (4 GiB). */
  maxExternalReferenceBytes: 4294967296,
  /** Eval cases. */
  maxEvalCases: 512,
  /** `evals.jsonl`, in bytes (4 MiB). */
  maxEvalsJsonlBytes: 4194304,
  /** `state.jsonl` records. */
  maxStateRecords: 4096,
  /** `state.jsonl`, in bytes (4 MiB). */
  maxStateLedgerBytes: 4194304,
  /** `manual-evidence.jsonl` records. */
  maxManualEvidenceRecords: 128,
  /** `manual-evidence.jsonl`, in bytes (4 MiB). */
  maxManualEvidenceBytes: 4194304,
  /** One certification run artifact tree, in bytes (2 GiB). */
  maxRunArtifactBytes: 2147483648,
  /** All foundry-owned run artifacts, in bytes (20 GiB). */
  maxAllRunArtifactBytes: 21474836480,
});

// ---------------------------------------------------------------------------------------
// Task 3 — safe roots, durable writes, lock, quota
// ---------------------------------------------------------------------------------------

/** Every path the foundry reads or writes, resolved once per invocation. */
export type FoundryPathsV1 = {
  homeDir: string;
  uid: number;
  /** `<homeDir>/Library/Mosh/teach` */
  teachRoot: string;
  draftsRoot: string;
  artifactsRoot: string;
  /** Mirrored current reviewed source-card metadata (Task 5). */
  sourceCardsRoot: string;
  /** A DIRECTORY (not a file) — lock acquisition renames a staged dir onto this path. */
  lockPath: string;
  /** `$MOSH_AGENT_DIR` if set (validated absolute+safe) else `<homeDir>/Library/Mosh/agent`. */
  agentRoot: string;
  certifiedRoot: string;
  activePath: string;
  sourceStatusPath: string;
};

export type UnsafePathFailureV1 = { code: "unsafe_path"; path: string; reason: string };

export type InspectedExternalFileV1 = {
  bytes: number;
  device: number;
  inode: number;
  mtimeNs: string;
  sha256: string;
};

export type InspectExternalFileFailureCodeV1 =
  | "not_found"
  | "symlink"
  | "not_regular_file"
  | "wrong_owner"
  | "hard_linked"
  | "oversized";

export type InspectExternalFileFailureV1 = { ok: false; code: InspectExternalFileFailureCodeV1; message: string };
export type InspectExternalFileResultV1 = { ok: true; value: InspectedExternalFileV1 } | InspectExternalFileFailureV1;

export type FoundryLockMetadataV1 = {
  schemaVersion: 1;
  nonce: string;
  pid: number;
  processStartIdentity: string;
  command: string;
  acquiredAt: string;
};

export type FoundryQuotaSnapshotV1 = {
  draftCount: number;
  draftBytesById: Readonly<Record<string, number>>;
  allDraftBytes: number;
  allRunArtifactBytes: number;
};

export type QuotaMutationDeltaV1 = {
  /** Set when creating a brand-new draft; absent for a mutation to an existing draft. */
  newDraft?: true;
  draftId?: string;
  draftBytesDelta?: number;
  runArtifactBytesDelta?: number;
};

// ---------------------------------------------------------------------------------------
// Task 4 — hash-chained state ledger and draft store
// ---------------------------------------------------------------------------------------

/** The declarative-path monotonic chain plus native's fork, blocked/stale, and terminals. */
export type DraftLifecycleStateV1 =
  | "draft"
  | "source_reviewed"
  | "schema_valid"
  | "mock_green"
  | "native_green"
  | "packaged_green"
  | "acceptance_green"
  | "owner_approved"
  | "release_packaged_green"
  | "certified"
  | "blocked"
  | "stale"
  | "rejected"
  | "superseded"
  | "revoked";

export type DraftArtifactKindV1 = "declarative" | "native";

export type ExecutionIdentityV1 = {
  gitCommit: string;
  appVersion: string;
  build: { kind: "offline"; toolVersion: "teach-moshi-v1" } | { kind: "mosh"; moshBuildIdentity: string };
};

export type FoundryStateRecordResultV1 = "passed" | "failed" | "blocked";

export type FoundryStateRecordV1 = {
  schemaVersion: 1;
  sequence: number;
  previousRecordSha256: string;
  state: DraftLifecycleStateV1;
  artifactHashes: Readonly<Record<string, string>>;
  executionIdentity: ExecutionIdentityV1;
  testCommand: string;
  startedAt: string;
  finishedAt: string;
  result: FoundryStateRecordResultV1;
  recordSha256: string;
};

export type AppendStateTransitionInputV1 = {
  state: DraftLifecycleStateV1;
  artifactKind: DraftArtifactKindV1;
  artifactHashes: Readonly<Record<string, string>>;
  executionIdentity: ExecutionIdentityV1;
  testCommand: string;
  startedAt: string;
  finishedAt: string;
  result: FoundryStateRecordResultV1;
};

export type ClockV1 = { now(): Date };

export type DraftArtifactNameV1 =
  | "request"
  | "candidate"
  | "evals"
  | "state"
  | "manualEvidence"
  | "certification"
  | "approval"
  | "releaseVerification";

export type DraftSnapshotV1 = {
  draftId: string;
  draftDir: string;
  statePath: string;
  requestPath: string;
  sourcesDir: string;
  referencesDir: string;
  state: readonly FoundryStateRecordV1[];
  currentState: DraftLifecycleStateV1 | null;
};

export type ArtifactWriteResultV1 =
  | { ok: true; sha256: string; bytes: number }
  | { ok: false; code: "already_exists" | "hash_mismatch" | "not_found"; message: string };

export type CreateDraftInputV1 = { goal: string; id?: string };
export type CreateDraftResultV1 = {
  skillId: string;
  draftDir: string;
  statePath: string;
  requestPath: string;
};

// ---------------------------------------------------------------------------------------
// Task 5 — source cards, source status/freshness, and external reference locators
// ---------------------------------------------------------------------------------------

// Mirrors service/corpus/recipe_source_intake.py's `project_skill_source` output exactly
// (camelCase field names; same closed enums) — see that module's RIGHTS_VALUES /
// ACQUISITION_VALUES / PLATFORM_HANDLING_VALUES / CLAIM_ORIGIN_VALUES / SOURCE_STATE_VALUES.
export type SourceCardRightsV1 =
  | "official_public_documentation"
  | "creator_authorized"
  | "user_owned_or_licensed"
  | "manual_paraphrase_only";
export type SourceCardAcquisitionV1 =
  | "official_https_page"
  | "creator_authorized_file"
  | "user_supplied_local_file"
  | "manual_viewing_notes";
export type SourceCardPlatformHandlingV1 = "metadata_and_short_paraphrases_only" | "local_locator_only";
export type SourceCardClaimOriginV1 = "source_text" | "owner_observation" | "asr_ocr" | "codex_inference";
export type SourceCardStateV1 = "current" | "stale" | "superseded" | "revoked";

export type SourceCardClaimV1 = {
  claimId: string;
  origin: SourceCardClaimOriginV1;
  workflowMoment: string;
  paraphrase: string;
  boundary: string;
};

export type SourceCardV1 = {
  schemaVersion: 1;
  sourceCardId: string;
  sourceVersion: string;
  rights: SourceCardRightsV1;
  acquisition: SourceCardAcquisitionV1;
  platformHandling: SourceCardPlatformHandlingV1;
  evidenceSha256: string;
  reviewer: string;
  reviewedAt: string;
  state: SourceCardStateV1;
  dependentIds: readonly string[];
  claims: readonly SourceCardClaimV1[];
  sourceSnapshotSha256: string;
};

// Slice A ALREADY defines `SourceStatusV1` and `AbletonReferenceV1` structurally identically
// (`ui/src/agent/skillFoundry/contracts.ts`) — this module re-exports them rather than
// forking a second copy. `SourceStatusEntryV1` is a locally named alias for Slice A's inline
// entry shape (Slice A does not name it separately); Slice D is the sole durable WRITER of
// this index, but the type itself is Slice A's, since Slice A's runtime is the reader.
export type { SourceStatusV1, AbletonReferenceV1 } from "../agent/skillFoundry/contracts";
export type SourceStatusEntryV1 = SliceASourceStatusV1["entries"][number];

export type ReferenceFileIdentityV1 = { device: number; inode: number; mtimeNs: string };

export type ReferenceLocatorV1 = {
  schemaVersion: 1;
  referenceId: string;
  absolutePath: string;
  sha256: string;
  bytes: number;
  fileIdentity: ReferenceFileIdentityV1;
  recordedAt: string;
};

// ---------------------------------------------------------------------------------------
// Task 6 — evals, candidate authoring, native draft seeding, process supervision
// ---------------------------------------------------------------------------------------

/** LOCKED exactly for Slice E — do not add/remove/rename a member without updating both slices. */
export type SelectedJourneyActionV1 =
  | { journeyId: "session-control"; action: "play" | "stop" | "from_start" | "save" | "undo" | "redo" }
  | { journeyId: "capture-review-choose-take"; action: "record_start" | "record_stop" | "audition" | "again" | "keep" }
  | { journeyId: "explicit-balance"; action: "mute" | "unmute" | "solo" | "set_level" }
  | { journeyId: "load-named-plugin"; action: "load" };

export type EvalExpectedOutcomeV1 =
  | { kind: "completed"; code: null }
  | { kind: "needs_choice"; code: "ambiguous_skill" | "ambiguous_target" }
  | {
      kind: "blocked";
      code: Exclude<SkillReasonCodeV1, "no_match" | "ambiguous_skill" | "ambiguous_target" | "unsupported_intent">;
    }
  | { kind: "unsupported"; code: "no_match" | "unsupported_intent" };

export type EvalNegativeCategoryV1 = "negative" | "ambiguity" | "stale_state" | "malformed_input" | "injection" | "expected_failure";
export type InvalidFillPhaseV1 = "none" | "candidate_selection" | "slot_validation" | "entity_resolution" | "preflight";

export type EvalCaseV1 = {
  schemaVersion: 1;
  id: string;
  selected: SelectedJourneyActionV1;
  supported: boolean;
  utterance: string;
  fixtureSha256: string;
  initialStateSha256: string;
  expectedOutcome: EvalExpectedOutcomeV1;
  finalStatePredicates: readonly PredicateV1[];
  prohibitedEffects: readonly string[];
  evidenceLevel: "schema" | "mock" | "native" | "packaged" | "physical";
  scoringCategory: "selection" | EvalNegativeCategoryV1;
  invalidFillPhase: InvalidFillPhaseV1;
  expectedObservation?: string;
};

export type ProcessKindV1 = "mock" | "native_or_packaged" | "native_or_packaged_gate" | "repair_cycle";

export type ProcessSpecV1 = {
  kind: ProcessKindV1;
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  logDirectory: string;
};

export type ProcessResultV1 = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
  pid: number;
  startedAt: string;
  finishedAt: string;
};

export type ProcessSupervisorV1 = { run(spec: ProcessSpecV1): Promise<ProcessResultV1> };

export type CertificationInvocationV1 = {
  draftId: string;
  runId: string;
  bin: string;
  artifact: SkillArtifactRefV1;
  evalSha256: string;
  catalogFingerprint: CatalogFingerprintV1;
  sourceStatusIndexSha256: string;
};

export type CertificationDriverResultV1 =
  | { kind: "completed"; report: CertificationReportV1 }
  | {
      kind: "needs_manual_evidence";
      runId: string;
      caseId: string;
      expectedObservation: string;
      artifact: SkillArtifactRefV1;
      evalSha256: string;
    }
  | { kind: "blocked"; code: string; message: string };

export type CertificationRunnerPortV1 = { run(input: CertificationInvocationV1, supervisor: ProcessSupervisorV1): Promise<CertificationDriverResultV1> };

export type SeedNativeCoreDraftInputV1 = { goal: string; nativePayloadBytes: Uint8Array; evalsJsonlBytes: Uint8Array };
export type SeedNativeCoreDraftResultV1 = {
  draft: DraftSnapshotV1;
  artifact: { kind: "native_payload"; sha256: string };
  evalSha256: string;
};

export type AuthorCandidateArtifactsInputV1 = { draftId: string; candidateBytes: Uint8Array; evalsBytes: Uint8Array };
export type AuthorCandidateArtifactsResultV1 = {
  changed: boolean;
  candidateSha256: string;
  evalSha256: string;
};

// ---------------------------------------------------------------------------------------
// Task 7 — manual evidence and review/approval
// ---------------------------------------------------------------------------------------

export type ManualEvidenceArtifactV1 = { kind: "audio" | "image" | "video" | "log" | "other"; localPath: string; sha256: string; bytes: number };

export type ManualEvidenceV1 = {
  schemaVersion: 1;
  runId: string;
  caseId: string;
  artifact: SkillArtifactRefV1;
  evalSha256: string;
  expectedObservation: string;
  decision: "passed" | "failed" | "physical_not_required";
  observed: string;
  actor: string;
  recordedAt: string;
  artifacts: readonly ManualEvidenceArtifactV1[];
};

export type PendingManualEvidenceV1 = {
  runId: string;
  caseId: string;
  expectedObservation: string;
  artifact: SkillArtifactRefV1;
  evalSha256: string;
};

export type RecordManualEvidenceInputV1 = { draftId: string; evidenceBytes: Uint8Array; pending: PendingManualEvidenceV1 };
export type ManualEvidenceRecordResultV1 =
  | { ok: true; record: ManualEvidenceV1; changed: boolean }
  | { ok: false; code: "invalid_artifact" | "stale_evidence" | "missing_reviewer_statement" | "quota_exceeded"; message: string };

export type SkillReviewV1 = { reviewSha256: string; markdown: string; artifactSha256: string; certificationReportSha256: string };

export type ApprovalAttestationV1 = {
  schemaVersion: 1;
  reviewSha256: string;
  exactStatement: string;
  actor: string;
  channel: string;
  conversationLocator?: string;
  approvedAt: string;
};

export type SkillApprovalV1 = {
  schemaVersion: 1;
  state: "owner_approved";
  reviewSha256: string;
  artifact: SkillArtifactRefV1;
  certificationReportSha256: string;
  exactStatement: string;
  actor: string;
  channel: string;
  conversationLocator?: string;
  approvedAt: string;
};

export type ApproveDraftInputV1 = { draftId: string; reviewSha256: string; attestationBytes: Uint8Array };

export type DraftStoreV1 = {
  createDraft(input: CreateDraftInputV1): Promise<CreateDraftResultV1>;
  loadDraft(draftId: string): Promise<DraftSnapshotV1>;
  readArtifactBytes(draftId: string, name: DraftArtifactNameV1, options?: { missing?: "throw" }): Promise<Uint8Array>;
  readArtifactBytes(draftId: string, name: DraftArtifactNameV1, options: { missing: "null" }): Promise<Uint8Array | null>;
  writeArtifactBytes(
    draftId: string,
    name: DraftArtifactNameV1,
    bytes: Uint8Array,
    options: { createOnly: boolean; expectedSha256?: string },
  ): Promise<ArtifactWriteResultV1>;
  createRunArtifactRoot(runId: string): Promise<string>;
};

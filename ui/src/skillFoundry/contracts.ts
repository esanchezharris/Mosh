// Slice D — Skill Foundry CLI/draft/source/eval/process contracts.
//
// This file owns ONLY Slice D's own CLI wire format, local draft/source/eval/process types.
// It imports Slice A runtime-artifact types (SkillManifestV1, CertificationReportV1, ...)
// from `ui/src/agent/skillFoundry/contracts.ts` rather than redefining them — Slice A is the
// semantic authority for every runtime artifact shape. New type groups are appended here,
// task by task, each under its own banner comment naming the task that introduced it.
//
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

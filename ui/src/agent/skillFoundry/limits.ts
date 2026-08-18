// Task 1 — exact v1 quotas for the Skill Foundry (spec Section 8.1).
//
// `SKILL_LIMITS_V1` covers package/startup-loading bounds: how many skills load, how big
// each artifact file and the whole startup byte budget may be, and the continuation
// store's own caps. `FOUNDRY_LIMITS_V1` covers the declarative-manifest GRAMMAR bounds:
// string/collection lengths inside a manifest's content (title, examples, slots, steps,
// ...) plus the numeric ranges `execution.maxMutations`, `execution.timeoutMs`, and
// `maxChoices` must fall within. Both are frozen; nothing here is meant to be tuned at
// runtime.
//
// NOTE (design decision, not given an explicit shape in the plan or spec): the plan's
// "Produces" line names `FOUNDRY_LIMITS_V1` without specifying its fields. Its values
// below are copied field-for-field from the spec Section 8.1 table; the field NAMES and
// the SKILL_LIMITS_V1 / FOUNDRY_LIMITS_V1 split are this task's own judgment call — see
// the report for the reasoning. `SKILL_LIMITS_V1`'s tested fields (see contracts.test.ts)
// are load-bearing and exact; its few extra byte-cap fields extend the same "package
// bytes" grouping the tested fields already belong to.

/** Package/startup-loading bounds. The `toMatchObject` fields are load-bearing. */
export const SKILL_LIMITS_V1 = Object.freeze({
  /** Certified local skills loaded at startup. */
  maxLoadedLocalSkills: 64,
  /** One manifest, in bytes (64 KiB). */
  manifestBytes: 65536,
  /** One certification report, in bytes (256 KiB). */
  certificationBytes: 262144,
  /** One approval record, in bytes (16 KiB). */
  approvalBytes: 16384,
  /** One release envelope, in bytes (4 KiB). */
  releaseBytes: 4096,
  /** One native release verification, in bytes (64 KiB). */
  nativeReleaseVerificationBytes: 65536,
  /** All accepted package bytes at startup (8 MiB). */
  startupPackageBytes: 8388608,
  /** Activation index entry count. */
  activationEntries: 64,
  /** Activation index, in bytes (64 KiB). */
  activationIndexBytes: 65536,
  /** Source-status index entry count. */
  sourceStatusEntries: 256,
  /** Source-status index, in bytes (256 KiB). */
  sourceStatusBytes: 262144,
  /** Choice options per continuation. */
  choices: 5,
  /** Continuation store capacity (oldest-unused eviction beyond this). */
  continuations: 16,
  /** Continuation expiry, in milliseconds (ten minutes). */
  continuationTtlMs: 600000,
  /** Invalid replies to one continuation before it terminally blocks. */
  continuationInvalidAttempts: 3,
});

/** Declarative-manifest grammar bounds (spec Section 8.1). */
export const FOUNDRY_LIMITS_V1 = Object.freeze({
  /** Skill ID, in ASCII slug characters. */
  skillIdChars: 64,
  /** Title, in Unicode scalar values. */
  titleChars: 80,
  /** Description or a fixed response string, in Unicode scalar values. */
  descriptionChars: 512,
  /** Positive intent examples. */
  positiveExamples: 32,
  /** Negative intent examples. */
  negativeExamples: 32,
  /** One example, in Unicode scalar values. */
  exampleChars: 256,
  /** Intent tags. */
  tags: 16,
  /** Enum values in one slot. */
  enumValues: 32,
  /** Slots. */
  slots: 16,
  /** Preconditions. */
  preconditions: 16,
  /** Declared step nodes. */
  declaredStepNodes: 32,
  /** Expanded preflight observation/resolver calls. */
  expandedPreflightCalls: 32,
  /** Expanded mutation commands (also the ceiling on `execution.maxMutations`). */
  expandedMutationCommands: 32,
  /** Postconditions. */
  postconditions: 16,
  /** Arguments on one command, resolver, or predicate. */
  argumentsPerCall: 16,
  /** Provenance references. */
  provenanceReferences: 32,
  /** Claim IDs in one provenance reference. */
  claimIdsPerReference: 16,
  /** Choice options a step's `resolve.maxChoices` may declare (1..5). */
  maxChoices: 5,
  /** One string slot, in Unicode scalar values. */
  stringSlotChars: 1024,
  /** One list slot, in items (each item inherits `stringSlotChars`). */
  listSlotItems: 16,
  /** Inclusive lower bound for `execution.maxMutations`. */
  maxMutationsMin: 1,
  /** Inclusive upper bound for `execution.maxMutations`. */
  maxMutationsMax: 32,
  /** Inclusive lower bound for `execution.timeoutMs`. */
  timeoutMsMin: 100,
  /** Inclusive upper bound for `execution.timeoutMs`. */
  timeoutMsMax: 120000,
});

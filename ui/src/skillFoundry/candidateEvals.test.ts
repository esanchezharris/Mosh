// Task 6 — RED-first pin for `EvalCaseV1` validation (exact branch/category/phase rules,
// 512/+1 boundary) and `validateDraftCandidateV1` (stale/missing primitive, valid path).

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOUNDRY_STORAGE_LIMITS_V1 } from "./contracts";
import { parseEvalCasesV1 } from "./evals";
import { validateDraftCandidateV1 } from "./candidate";
import { createDraftStoreV1 } from "./draftStore";
import { appendStateTransitionV1 } from "./stateLedger";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { catalogFingerprintV1 } from "../agent/skillFoundry/catalogs";
import { canonicalJsonBytes } from "../agent/skillFoundry/hash";

const FAKE_IDENTITY_DEPS = { resolveGitCommit: async () => "a".repeat(40), resolveAppVersion: async () => "1.0.0" };
const CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };

function validCaseFields(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "case-1",
    selected: { journeyId: "session-control", action: "play" },
    supported: true,
    utterance: "play it",
    fixtureSha256: "a".repeat(64),
    initialStateSha256: "b".repeat(64),
    expectedOutcome: { kind: "completed", code: null },
    finalStatePredicates: [],
    prohibitedEffects: [],
    evidenceLevel: "mock",
    scoringCategory: "selection",
    invalidFillPhase: "none",
    ...overrides,
  };
}

function jsonl(cases: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

describe("parseEvalCasesV1", () => {
  it("accepts one valid supported case", () => {
    const result = parseEvalCasesV1(jsonl([validCaseFields()]));
    expect(result.ok).toBe(true);
  });

  it("rejects a supported case with scoringCategory != selection", () => {
    const result = parseEvalCasesV1(jsonl([validCaseFields({ scoringCategory: "negative", supported: true })]));
    expect(result.ok).toBe(false);
  });

  it("rejects a non-supported case using scoringCategory selection", () => {
    const result = parseEvalCasesV1(
      jsonl([
        validCaseFields({
          supported: false,
          scoringCategory: "selection",
          expectedOutcome: { kind: "unsupported", code: "no_match" },
        }),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts every one of the six negative categories with a matching non-none phase where required", () => {
    const categories = ["negative", "ambiguity", "stale_state", "malformed_input", "injection", "expected_failure"] as const;
    for (const scoringCategory of categories) {
      const invalidFillPhase = scoringCategory === "malformed_input" ? "slot_validation" : "preflight";
      const result = parseEvalCasesV1(
        jsonl([
          validCaseFields({
            id: `case-${scoringCategory}`,
            supported: false,
            scoringCategory,
            invalidFillPhase,
            expectedOutcome: { kind: "blocked", code: "stale_context" },
          }),
        ]),
      );
      expect(result.ok).toBe(true);
    }
  });

  it("rejects malformed_input with invalidFillPhase 'none'", () => {
    const result = parseEvalCasesV1(
      jsonl([
        validCaseFields({
          supported: false,
          scoringCategory: "malformed_input",
          invalidFillPhase: "none",
          expectedOutcome: { kind: "blocked", code: "stale_context" },
        }),
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an expectedOutcome.kind='blocked' code from the excluded set", () => {
    const result = parseEvalCasesV1(
      jsonl([validCaseFields({ supported: false, scoringCategory: "negative", expectedOutcome: { kind: "blocked", code: "no_match" } })]),
    );
    expect(result.ok).toBe(false);
  });

  it("requires expectedObservation for evidenceLevel physical", () => {
    const missing = parseEvalCasesV1(jsonl([validCaseFields({ evidenceLevel: "physical" })]));
    expect(missing.ok).toBe(false);
    const present = parseEvalCasesV1(jsonl([validCaseFields({ evidenceLevel: "physical", expectedObservation: "audible take" })]));
    expect(present.ok).toBe(true);
  });

  it("rejects duplicate case IDs", () => {
    const result = parseEvalCasesV1(jsonl([validCaseFields({ id: "dup" }), validCaseFields({ id: "dup" })]));
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown journeyId/action combination", () => {
    const result = parseEvalCasesV1(jsonl([validCaseFields({ selected: { journeyId: "session-control", action: "keep" } })]));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing trailing newline (not strict LF-terminated)", () => {
    const bytes = jsonl([validCaseFields()]);
    const truncated = bytes.slice(0, -1);
    const result = parseEvalCasesV1(truncated);
    expect(result.ok).toBe(false);
  });

  it("accepts exactly 512 cases and rejects 513", () => {
    const cases = Array.from({ length: FOUNDRY_STORAGE_LIMITS_V1.maxEvalCases }, (_, i) => validCaseFields({ id: `case-${i}` }));
    const atCap = parseEvalCasesV1(jsonl(cases));
    expect(atCap.ok).toBe(true);

    const overCap = [...cases, validCaseFields({ id: "case-over" })];
    const overResult = parseEvalCasesV1(jsonl(overCap));
    expect(overResult.ok).toBe(false);
  });

  it("rejects a byte size over the 4 MiB cap", () => {
    const hugeCase = validCaseFields({ utterance: "x".repeat(FOUNDRY_STORAGE_LIMITS_V1.maxEvalsJsonlBytes) });
    const result = parseEvalCasesV1(jsonl([hugeCase]));
    expect(result.ok).toBe(false);
  });
});

describe("validateDraftCandidateV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  async function buildAdvancedDraft() {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    await appendStateTransitionV1(created.statePath, {
      state: "source_reviewed",
      artifactKind: "declarative",
      artifactHashes: {},
      executionIdentity: { gitCommit: "a".repeat(40), appVersion: "1.0.0", build: { kind: "offline", toolVersion: "teach-moshi-v1" } },
      testCommand: "test",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      result: "passed",
    });
    return { store, created };
  }

  async function validManifest(fingerprint: Awaited<ReturnType<typeof catalogFingerprintV1>>) {
    return {
      schemaVersion: 1,
      id: "owner-park-backgrounds",
      version: "1.0.0",
      title: "Park backgrounds",
      description: "Sets the background vocals track level and mutes it.",
      implementation: "declarative",
      intents: { positiveExamples: ["park the backgrounds"], negativeExamples: ["play the track"], tags: ["mixing"] },
      slots: [],
      preconditions: [],
      steps: [
        { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
        { kind: "mutate", command: "set_track_mute", args: { trackId: { binding: "track" }, mute: { literal: true } } },
      ],
      postconditions: [],
      execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
      responses: { completed: "Done.", needsChoice: "Which track?", blocked: "Could not complete." },
      provenance: [],
      compatibility: {
        minMoshVersion: "0.0.1",
        commandCatalogSha256: fingerprint.commandCatalogSha256,
        predicateCatalogVersion: fingerprint.predicateCatalogVersion,
        resolverCatalogVersion: fingerprint.resolverCatalogVersion,
      },
    };
  }

  it("validates a well-formed candidate and appends schema_valid", async () => {
    const { store, created } = await buildAdvancedDraft();
    const fingerprint = await catalogFingerprintV1();
    const manifest = await validManifest(fingerprint);
    await store.writeArtifactBytes(created.skillId, "candidate", canonicalJsonBytes(manifest), { createOnly: true });
    await store.writeArtifactBytes(
      created.skillId,
      "evals",
      new TextEncoder().encode(`${JSON.stringify(validCaseFields())}\n`),
      { createOnly: true },
    );

    const result = await validateDraftCandidateV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    expect(result).toMatchObject({ ok: true, state: "schema_valid" });
  });

  it("rejects a candidate referencing an unknown primitive as blocked_missing_primitive", async () => {
    const { store, created } = await buildAdvancedDraft();
    const fingerprint = await catalogFingerprintV1();
    const manifest = {
      ...(await validManifest(fingerprint)),
      steps: [{ kind: "mutate", command: "delete_everything", args: {} }],
    };
    await store.writeArtifactBytes(created.skillId, "candidate", canonicalJsonBytes(manifest), { createOnly: true });
    await store.writeArtifactBytes(created.skillId, "evals", new TextEncoder().encode(`${JSON.stringify(validCaseFields())}\n`), { createOnly: true });

    const result = await validateDraftCandidateV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    expect(result).toMatchObject({ ok: false, code: "blocked_missing_primitive" });
  });

  it("rejects a candidate whose provenance references a STALE/missing source", async () => {
    const { store, created } = await buildAdvancedDraft();
    const fingerprint = await catalogFingerprintV1();
    const manifest = {
      ...(await validManifest(fingerprint)),
      provenance: [{ sourceCardId: "never-added", claimIds: ["c1"], sourceSnapshotSha256: "a".repeat(64) }],
    };
    await mkdir(join(foundry.paths.agentRoot, "skills"), { recursive: true });
    await store.writeArtifactBytes(created.skillId, "candidate", canonicalJsonBytes(manifest), { createOnly: true });
    await store.writeArtifactBytes(created.skillId, "evals", new TextEncoder().encode(`${JSON.stringify(validCaseFields())}\n`), { createOnly: true });

    const result = await validateDraftCandidateV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    expect(result).toMatchObject({ ok: false, code: "source_stale" });
  });

  it("rejects validate when the draft is not yet source_reviewed", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const created = await store.createDraft({ goal: "Park backgrounds" });
    const result = await validateDraftCandidateV1({ draftId: created.skillId }, { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS });
    expect(result).toMatchObject({ ok: false, code: "wrong_state" });
  });
});

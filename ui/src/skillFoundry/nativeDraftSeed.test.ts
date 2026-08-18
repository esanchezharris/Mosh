// Task 6 — RED-first pin for native-core draft seeding: the four-ID allowlist, malformed
// payload, missing/malformed/mixed-journey evals, and atomic payload+eval publication.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedNativeCoreDraftV1 } from "./nativeDraftSeed";
import { createDraftStoreV1 } from "./draftStore";
import { createIsolatedFoundryV1, type IsolatedFoundryV1 } from "./testHelpers";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const FAKE_IDENTITY_DEPS = { resolveGitCommit: async () => "a".repeat(40), resolveAppVersion: async () => "1.0.0" };
const CLOCK = { now: () => new Date("2026-01-01T00:00:00.000Z") };

function validNativePayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "session-control",
    version: "1.0.0",
    implementation: "native",
    handlerKey: "sessionControlV1",
    title: "Session control",
    description: "Play, stop, save, undo, redo.",
    intents: { positiveExamples: ["play it"], negativeExamples: ["mute the track"], tags: ["transport"] },
    slots: [],
    execution: { mode: "atomic", confirmation: "never" },
    responses: { completed: "Done.", needsChoice: "Which one?", blocked: "Could not complete." },
    provenance: [],
    legacyAliases: [],
    compatibility: {
      minMoshVersion: "0.0.1",
      commandCatalogSha256: "a".repeat(64),
      predicateCatalogVersion: 1,
      resolverCatalogVersion: 1,
      nativeSourceSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

function validEvalCase(journeyId = "session-control", action = "play", id = "case-1") {
  return {
    schemaVersion: 1,
    id,
    selected: { journeyId, action },
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
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
function jsonl(cases: readonly unknown[]): Uint8Array {
  return new TextEncoder().encode(cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

describe("seedNativeCoreDraftV1", () => {
  let foundry: IsolatedFoundryV1;

  beforeEach(async () => {
    foundry = await createIsolatedFoundryV1();
  });

  afterEach(async () => {
    await foundry.cleanup();
  });

  it("seeds a valid native core draft with genesis artifactKind native", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const result = await seedNativeCoreDraftV1(
      { goal: "core journey", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: jsonl([validEvalCase()]) },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    expect(result.draft.draftId).toBe("session-control");
    expect(result.draft.currentState).toBe("draft");
  });

  it("accepts all four canonical native ids", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const cases: Array<[string, string, string]> = [
      ["session-control", "sessionControlV1", "play"],
      ["capture-review-choose-take", "takeCycleV1", "keep"],
      ["explicit-balance", "explicitBalanceV1", "mute"],
      ["load-named-plugin", "loadNamedPluginV1", "load"],
    ];
    for (const [id, handlerKey, action] of cases) {
      const result = await seedNativeCoreDraftV1(
        {
          goal: "core journey",
          nativePayloadBytes: bytes(validNativePayload({ id, handlerKey })),
          evalsJsonlBytes: jsonl([validEvalCase(id, action)]),
        },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      );
      expect(result.draft.draftId).toBe(id);
    }
  });

  it("rejects an id outside the four-canonical allowlist", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload({ id: "owner-fake-native", handlerKey: "sessionControlV1" })), evalsJsonlBytes: jsonl([validEvalCase("owner-fake-native")]) },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow();
  });

  it("rejects a malformed native payload", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes({ not: "a payload" }), evalsJsonlBytes: jsonl([validEvalCase()]) },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow(/invalid native payload/);
  });

  it("rejects empty evals", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: new TextEncoder().encode("") },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed evals JSONL", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: new TextEncoder().encode("not json\n") },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow(/invalid native evals/);
  });

  it("rejects mixed-journey evals", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const mixed = jsonl([validEvalCase("session-control", "play", "case-1"), validEvalCase("explicit-balance", "mute", "case-2")]);
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: mixed },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow(/mixed-journey/);
  });

  it("publishes payload and evals ATOMICALLY: a failed seed leaves no partial draft directory", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    try {
      await seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: new TextEncoder().encode("garbage\n") },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      );
    } catch {
      // expected
    }
    const entries = await readdir(foundry.paths.draftsRoot).catch(() => []);
    expect(entries).not.toContain("session-control");
  });

  it("rejects re-seeding an already-seeded native core (collision)", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    await seedNativeCoreDraftV1(
      { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: jsonl([validEvalCase()]) },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    await expect(
      seedNativeCoreDraftV1(
        { goal: "x", nativePayloadBytes: bytes(validNativePayload()), evalsJsonlBytes: jsonl([validEvalCase()]) },
        { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
      ),
    ).rejects.toThrow(/collision/i);
  });

  it("the published candidate.skill.json holds the exact native payload bytes", async () => {
    const store = createDraftStoreV1(foundry.paths, CLOCK, FAKE_IDENTITY_DEPS);
    const payloadBytes = bytes(validNativePayload());
    await seedNativeCoreDraftV1(
      { goal: "x", nativePayloadBytes: payloadBytes, evalsJsonlBytes: jsonl([validEvalCase()]) },
      { store, paths: foundry.paths, clock: CLOCK, identityDeps: FAKE_IDENTITY_DEPS },
    );
    const { readFile } = await import("node:fs/promises");
    const stored = await readFile(join(foundry.paths.draftsRoot, "session-control", "candidate.skill.json"));
    expect(Buffer.compare(stored, Buffer.from(payloadBytes))).toBe(0);
  });
});

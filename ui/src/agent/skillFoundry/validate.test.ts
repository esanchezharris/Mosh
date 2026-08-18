// Task 2 — Close the Primitive Catalog and Validate Manifests.
//
// RED-first, table-driven pin for `parseSkillManifestV1` and the three native artifact
// parsers. `validOwnerManifest()` is the one known-good fixture every invalid-case test
// mutates from; each invalid case changes exactly one thing and asserts `ok:false` with at
// least one issue, so a regression that silently stops rejecting a case shows up as a
// specific, readable failure rather than a blanket "something changed".

import { describe, expect, it } from "vitest";
import { FOUNDRY_LIMITS_V1 } from "./limits";
import {
  parseNativeReleaseVerificationV1,
  parseNativeSkillBundleEntryV1,
  parseNativeSkillPayloadV1,
  parseSkillManifestV1,
} from "./validate";

// ---------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------

function validOwnerManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "owner-set-volume",
    version: "1.0.0",
    title: "Set track volume",
    description: "Sets the selected track's volume from a spoken dB value.",
    implementation: "declarative",
    intents: {
      positiveExamples: ["turn the drums up"],
      negativeExamples: ["mute the drums"],
      tags: ["mixer"],
    },
    slots: [
      {
        name: "db",
        type: "number",
        required: true,
        source: "utterance",
        minimum: -60,
        maximum: 6,
        description: "target volume in dB",
      },
    ],
    preconditions: [{ name: "not_recording", args: {} }],
    steps: [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      {
        kind: "mutate",
        command: "set_track_volume",
        args: { trackId: { binding: "track" }, db: { slot: "db" } },
      },
    ],
    postconditions: [
      {
        name: "track_volume_equals",
        args: { trackId: { binding: "track" }, db: { slot: "db" } },
      },
    ],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: {
      completed: "Done.",
      needsChoice: "Which track?",
      blocked: "Could not change the volume.",
    },
    provenance: [],
    compatibility: {
      minMoshVersion: "1.0.0",
      commandCatalogSha256: "0".repeat(64),
      predicateCatalogVersion: 1,
      resolverCatalogVersion: 1,
    },
  };
}

function expectRejected(result: ReturnType<typeof parseSkillManifestV1>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
}

describe("parseSkillManifestV1 — valid fixture", () => {
  it("accepts a valid owner manifest", () => {
    const result = parseSkillManifestV1(validOwnerManifest());
    expect(result.ok).toBe(true);
  });
});

describe("parseSkillManifestV1 — invalid namespace (skill ID format)", () => {
  it("rejects an uppercase-containing id", () => {
    expectRejected(parseSkillManifestV1({ ...validOwnerManifest(), id: "Owner-Bad" }));
  });

  it("rejects an id with a space", () => {
    expectRejected(parseSkillManifestV1({ ...validOwnerManifest(), id: "owner bad" }));
  });

  it("rejects an id over the 64-character cap", () => {
    expectRejected(parseSkillManifestV1({ ...validOwnerManifest(), id: "owner-" + "a".repeat(64) }));
  });
});

describe("parseSkillManifestV1 — SemVer build metadata", () => {
  it("rejects a version with build metadata", () => {
    expectRejected(parseSkillManifestV1({ ...validOwnerManifest(), version: "1.0.0+build.5" }));
  });

  it("accepts a version with a prerelease tag (no build metadata)", () => {
    const result = parseSkillManifestV1({ ...validOwnerManifest(), version: "1.0.0-beta.1" });
    expect(result.ok).toBe(true);
  });
});

describe("parseSkillManifestV1 — unknown fields", () => {
  it("rejects an unexpected top-level field", () => {
    expectRejected(parseSkillManifestV1({ ...validOwnerManifest(), extraField: true }));
  });

  it("rejects an unexpected field inside execution", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).unexpected = 1;
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — execution.mode", () => {
  it("rejects lifecycle mode for an owner-local manifest", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).mode = "lifecycle";
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects best_effort mode for an owner-local manifest", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).mode = "best_effort";
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — unknown primitive/predicate", () => {
  it("rejects an unknown observe command", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as unknown[]).unshift({ kind: "observe", command: "list_tracks", args: {}, bind: "tracks" });
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects an unknown resolver", () => {
    const manifest = validOwnerManifest();
    manifest.steps = [{ kind: "resolve", resolver: "track_by_fuzzy_name", bind: "track", maxChoices: 1 }];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects an unknown mutation command", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "delete_track",
      args: { trackId: { binding: "track" } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects an unknown predicate name", () => {
    const manifest = validOwnerManifest();
    manifest.preconditions = [{ name: "always_true", args: {} }];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — optional referenced slot", () => {
  it("rejects a referenced slot that is optional and has no default", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "db",
        type: "number",
        required: false,
        source: "utterance",
        minimum: -60,
        maximum: 6,
        description: "target volume in dB",
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts a referenced slot that is optional but has a valid default", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "db",
        type: "number",
        required: false,
        default: -3,
        source: "utterance",
        minimum: -60,
        maximum: 6,
        description: "target volume in dB",
      },
    ];
    const result = parseSkillManifestV1(manifest);
    expect(result.ok).toBe(true);
  });
});

describe("parseSkillManifestV1 — unsafe ID literal", () => {
  it("rejects a literal trackId in place of a resolver binding", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "set_track_volume",
      args: { trackId: { literal: "7" }, db: { slot: "db" } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a literal pluginId in place of the plugin_by_name binding", () => {
    const manifest = validOwnerManifest();
    manifest.steps = [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      {
        kind: "mutate",
        command: "load_plugin",
        args: { trackId: { binding: "track" }, pluginId: { literal: "some-plugin-id" } },
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — non-finite bounds", () => {
  it("rejects a slot with a non-finite minimum", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "db",
        type: "number",
        required: true,
        source: "utterance",
        minimum: Number.POSITIVE_INFINITY,
        maximum: 6,
        description: "target volume in dB",
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a slot with a NaN maximum", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "db",
        type: "number",
        required: true,
        source: "utterance",
        minimum: -60,
        maximum: Number.NaN,
        description: "target volume in dB",
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a slot whose minimum exceeds its maximum", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "db",
        type: "number",
        required: true,
        source: "utterance",
        minimum: 6,
        maximum: -60,
        description: "target volume in dB",
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — execution.maxMutations bound (1..32)", () => {
  it("accepts the exact lower boundary (1)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).maxMutations = 1;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one under the lower boundary (0)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).maxMutations = 0;
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts the exact upper boundary (32)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).maxMutations = 32;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one over the upper boundary (33)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).maxMutations = 33;
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — execution.timeoutMs bound (100..120000)", () => {
  it("accepts the exact lower boundary (100)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).timeoutMs = 100;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one under the lower boundary (99)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).timeoutMs = 99;
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts the exact upper boundary (120000)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).timeoutMs = 120000;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one over the upper boundary (120001)", () => {
    const manifest = validOwnerManifest();
    (manifest.execution as Record<string, unknown>).timeoutMs = 120001;
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — resolve step maxChoices bound (1..5)", () => {
  it("accepts the exact lower boundary (1)", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[0].maxChoices = 1;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one under the lower boundary (0)", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[0].maxChoices = 0;
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts the exact upper boundary (5)", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[0].maxChoices = 5;
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects one over the upper boundary (6)", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[0].maxChoices = 6;
    expectRejected(parseSkillManifestV1(manifest));
  });
});

// ---------------------------------------------------------------------------------------
// Remaining Section 8.1 caps meaningful on one already-decoded manifest (Task 2 Step 4:
// "Add exact-limit acceptance plus one-over rejection for every Section 8.1 cap"). The
// package/startup-loading caps (manifestBytes, maxLoadedLocalSkills, activationEntries, ...)
// are exact-byte or startup-assembly bounds owned by Task 3/Task 9, not this module.
// `expandedPreflightCalls`/`expandedMutationCommands` are post-`each`-expansion runtime
// bounds owned by Task 8's declarativeExecutor (see validate.ts's SCOPE comment); the
// `declaredStepNodes` cap below covers the raw (unexpanded) step count this module can see.
// ---------------------------------------------------------------------------------------

describe("parseSkillManifestV1 — title cap (80 Unicode scalars)", () => {
  it("accepts exactly 80 characters", () => {
    const manifest = validOwnerManifest();
    manifest.title = "a".repeat(FOUNDRY_LIMITS_V1.titleChars);
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 81 characters", () => {
    const manifest = validOwnerManifest();
    manifest.title = "a".repeat(FOUNDRY_LIMITS_V1.titleChars + 1);
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — description cap (512 Unicode scalars)", () => {
  it("accepts exactly 512 characters", () => {
    const manifest = validOwnerManifest();
    manifest.description = "a".repeat(FOUNDRY_LIMITS_V1.descriptionChars);
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 513 characters", () => {
    const manifest = validOwnerManifest();
    manifest.description = "a".repeat(FOUNDRY_LIMITS_V1.descriptionChars + 1);
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — intent example count and length caps", () => {
  it("accepts exactly 32 positive examples", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).positiveExamples = Array.from(
      { length: FOUNDRY_LIMITS_V1.positiveExamples },
      (_, i) => `example ${i}`,
    );
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 33 positive examples", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).positiveExamples = Array.from(
      { length: FOUNDRY_LIMITS_V1.positiveExamples + 1 },
      (_, i) => `example ${i}`,
    );
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts exactly 32 negative examples", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).negativeExamples = Array.from(
      { length: FOUNDRY_LIMITS_V1.negativeExamples },
      (_, i) => `example ${i}`,
    );
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 33 negative examples", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).negativeExamples = Array.from(
      { length: FOUNDRY_LIMITS_V1.negativeExamples + 1 },
      (_, i) => `example ${i}`,
    );
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts exactly 256 characters in one example", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).positiveExamples = ["a".repeat(FOUNDRY_LIMITS_V1.exampleChars)];
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 257 characters in one example", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).positiveExamples = ["a".repeat(FOUNDRY_LIMITS_V1.exampleChars + 1)];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts exactly 16 tags", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).tags = Array.from(
      { length: FOUNDRY_LIMITS_V1.tags },
      (_, i) => `tag${i}`,
    );
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 17 tags", () => {
    const manifest = validOwnerManifest();
    (manifest.intents as Record<string, unknown>).tags = Array.from(
      { length: FOUNDRY_LIMITS_V1.tags + 1 },
      (_, i) => `tag${i}`,
    );
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — enumValues cap (32)", () => {
  function withEnumSlot(count: number): Record<string, unknown> {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "mode",
        type: "enum",
        required: true,
        source: "utterance",
        enumValues: Array.from({ length: count }, (_, i) => `mode${i}`),
        description: "mode",
      },
    ];
    manifest.preconditions = [];
    manifest.steps = [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      {
        kind: "mutate",
        command: "set_track_mute",
        args: { trackId: { binding: "track" }, mute: { literal: true } },
      },
    ];
    manifest.postconditions = [];
    return manifest;
  }

  it("accepts exactly 32 enum values", () => {
    expect(parseSkillManifestV1(withEnumSlot(FOUNDRY_LIMITS_V1.enumValues)).ok).toBe(true);
  });

  it("rejects 33 enum values", () => {
    expectRejected(parseSkillManifestV1(withEnumSlot(FOUNDRY_LIMITS_V1.enumValues + 1)));
  });
});

describe("parseSkillManifestV1 — slots cap (16)", () => {
  function withSlotCount(count: number): Record<string, unknown> {
    const manifest = validOwnerManifest();
    manifest.slots = Array.from({ length: count }, (_, i) => ({
      name: `s${i}`,
      type: "number",
      required: false,
      default: 0,
      source: "utterance",
      description: "unused",
    }));
    // None of these generated slots are named "db" — clear the fixture's steps/pre/post
    // conditions so nothing dangles a reference to the slot this replaced.
    manifest.preconditions = [];
    manifest.postconditions = [];
    manifest.steps = [{ kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 }];
    return manifest;
  }

  it("accepts exactly 16 slots", () => {
    expect(parseSkillManifestV1(withSlotCount(FOUNDRY_LIMITS_V1.slots)).ok).toBe(true);
  });

  it("rejects 17 slots", () => {
    expectRejected(parseSkillManifestV1(withSlotCount(FOUNDRY_LIMITS_V1.slots + 1)));
  });
});

describe("parseSkillManifestV1 — preconditions/postconditions caps (16)", () => {
  function withPredicateCount(field: "preconditions" | "postconditions", count: number): Record<string, unknown> {
    const manifest = validOwnerManifest();
    manifest[field] = Array.from({ length: count }, () => ({ name: "not_recording", args: {} }));
    return manifest;
  }

  it("accepts exactly 16 preconditions", () => {
    expect(parseSkillManifestV1(withPredicateCount("preconditions", FOUNDRY_LIMITS_V1.preconditions)).ok).toBe(true);
  });

  it("rejects 17 preconditions", () => {
    expectRejected(parseSkillManifestV1(withPredicateCount("preconditions", FOUNDRY_LIMITS_V1.preconditions + 1)));
  });

  it("accepts exactly 16 postconditions", () => {
    expect(parseSkillManifestV1(withPredicateCount("postconditions", FOUNDRY_LIMITS_V1.postconditions)).ok).toBe(true);
  });

  it("rejects 17 postconditions", () => {
    expectRejected(parseSkillManifestV1(withPredicateCount("postconditions", FOUNDRY_LIMITS_V1.postconditions + 1)));
  });
});

describe("parseSkillManifestV1 — declared step nodes cap (32)", () => {
  function withStepCount(count: number): Record<string, unknown> {
    const manifest = validOwnerManifest();
    manifest.steps = Array.from({ length: count }, (_, i) => ({
      kind: "observe",
      command: "current_snapshot",
      args: {},
      bind: `snap${i}`,
    }));
    manifest.preconditions = [];
    manifest.postconditions = [];
    return manifest;
  }

  it("accepts exactly 32 declared steps", () => {
    expect(parseSkillManifestV1(withStepCount(FOUNDRY_LIMITS_V1.declaredStepNodes)).ok).toBe(true);
  });

  it("rejects 33 declared steps", () => {
    expectRejected(parseSkillManifestV1(withStepCount(FOUNDRY_LIMITS_V1.declaredStepNodes + 1)));
  });
});

describe("parseSkillManifestV1 — provenance caps (32 references, 16 claimIds each)", () => {
  function withProvenanceCount(count: number): Record<string, unknown> {
    const manifest = validOwnerManifest();
    manifest.provenance = Array.from({ length: count }, (_, i) => ({
      sourceCardId: `card${i}`,
      claimIds: ["claim1"],
      sourceSnapshotSha256: "0".repeat(64),
    }));
    return manifest;
  }

  it("accepts exactly 32 provenance references", () => {
    expect(parseSkillManifestV1(withProvenanceCount(FOUNDRY_LIMITS_V1.provenanceReferences)).ok).toBe(true);
  });

  it("rejects 33 provenance references", () => {
    expectRejected(parseSkillManifestV1(withProvenanceCount(FOUNDRY_LIMITS_V1.provenanceReferences + 1)));
  });

  it("accepts exactly 16 claimIds on one reference", () => {
    const manifest = validOwnerManifest();
    manifest.provenance = [
      {
        sourceCardId: "card0",
        claimIds: Array.from({ length: FOUNDRY_LIMITS_V1.claimIdsPerReference }, (_, i) => `claim${i}`),
        sourceSnapshotSha256: "0".repeat(64),
      },
    ];
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects 17 claimIds on one reference", () => {
    const manifest = validOwnerManifest();
    manifest.provenance = [
      {
        sourceCardId: "card0",
        claimIds: Array.from({ length: FOUNDRY_LIMITS_V1.claimIdsPerReference + 1 }, (_, i) => `claim${i}`),
        sourceSnapshotSha256: "0".repeat(64),
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — string-slot and list-slot caps", () => {
  // Every case here replaces `manifest.slots` with a slot NOT named "db" — also clear the
  // fixture's steps/pre/postconditions so nothing dangles a reference to the "db" slot they
  // replaced (a bare `{slot:"db"}` reference to a now-nonexistent slot would independently
  // fail as "unknown_slot", muddying what each case is actually testing).
  function clearDbReferences(manifest: Record<string, unknown>): void {
    manifest.preconditions = [];
    manifest.postconditions = [];
    manifest.steps = [];
  }

  it("accepts a string default at exactly 1024 characters", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "label",
        type: "string",
        required: false,
        default: "a".repeat(FOUNDRY_LIMITS_V1.stringSlotChars),
        source: "utterance",
        description: "unused",
      },
    ];
    clearDbReferences(manifest);
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects a string default at 1025 characters", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "label",
        type: "string",
        required: false,
        default: "a".repeat(FOUNDRY_LIMITS_V1.stringSlotChars + 1),
        source: "utterance",
        description: "unused",
      },
    ];
    clearDbReferences(manifest);
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("accepts a list default at exactly 16 items", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "names",
        type: "string[]",
        required: false,
        default: Array.from({ length: FOUNDRY_LIMITS_V1.listSlotItems }, (_, i) => `n${i}`),
        source: "utterance",
        description: "unused",
      },
    ];
    clearDbReferences(manifest);
    expect(parseSkillManifestV1(manifest).ok).toBe(true);
  });

  it("rejects a list default at 17 items", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      {
        name: "names",
        type: "string[]",
        required: false,
        default: Array.from({ length: FOUNDRY_LIMITS_V1.listSlotItems + 1 }, (_, i) => `n${i}`),
        source: "utterance",
        description: "unused",
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

// ---------------------------------------------------------------------------------------
// Additional grammar rules Task 2 Step 4 explicitly calls out
// ---------------------------------------------------------------------------------------

describe("parseSkillManifestV1 — duplicate bindings/entities", () => {
  it("rejects two steps that bind the same name", () => {
    const manifest = validOwnerManifest();
    manifest.steps = [
      { kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 },
      { kind: "observe", command: "current_snapshot", args: {}, bind: "track" },
      {
        kind: "mutate",
        command: "set_track_volume",
        args: { trackId: { binding: "track" }, db: { slot: "db" } },
      },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects two slots with the same name", () => {
    const manifest = validOwnerManifest();
    manifest.slots = [
      { name: "db", type: "number", required: true, source: "utterance", minimum: -60, maximum: 6, description: "a" },
      { name: "db", type: "number", required: true, source: "utterance", minimum: -60, maximum: 6, description: "b" },
    ];
    expectRejected(parseSkillManifestV1(manifest));
  });
});

describe("parseSkillManifestV1 — reference-source rules", () => {
  it("rejects a binding that does not exist", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "set_track_volume",
      args: { trackId: { binding: "nonexistent" }, db: { slot: "db" } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a binding whose origin resolver is not permitted for the argument", () => {
    const manifest = validOwnerManifest();
    manifest.steps = [
      { kind: "resolve", resolver: "plugin_by_name", input: { slot: "pluginName" }, bind: "plugin", maxChoices: 1 },
      {
        kind: "mutate",
        command: "set_track_volume",
        args: { trackId: { binding: "plugin" }, db: { slot: "db" } },
      },
    ];
    (manifest.slots as unknown[]).push({
      name: "pluginName",
      type: "string",
      required: true,
      source: "utterance",
      description: "plugin name",
    });
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a context source not permitted for the argument", () => {
    const manifest = validOwnerManifest();
    manifest.preconditions = [{ name: "project_epoch_unchanged", args: { epoch: { context: "selectedTrackId" } } }];
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects an each source where the argument does not permit it", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "set_track_volume",
      args: { trackId: { binding: "track" }, db: { each: "db" } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects an unknown argument on a mutate step", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "set_track_volume",
      args: { trackId: { binding: "track" }, db: { slot: "db" }, extra: { literal: 1 } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });

  it("rejects a missing required argument on a mutate step", () => {
    const manifest = validOwnerManifest();
    (manifest.steps as Record<string, unknown>[])[1] = {
      kind: "mutate",
      command: "set_track_volume",
      args: { trackId: { binding: "track" } },
    };
    expectRejected(parseSkillManifestV1(manifest));
  });
});

// ---------------------------------------------------------------------------------------
// Native artifact parsers
// ---------------------------------------------------------------------------------------

function validNativePayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "session-control",
    version: "1.0.0",
    implementation: "native",
    handlerKey: "sessionControlV1",
    title: "Session control",
    description: "Start/stop/arm the session.",
    intents: { positiveExamples: ["start recording"], negativeExamples: ["stop the song"], tags: ["transport"] },
    slots: [],
    execution: { mode: "atomic", confirmation: "never" },
    responses: { completed: "Done.", needsChoice: "Which?", blocked: "Could not." },
    provenance: [],
    legacyAliases: [],
    compatibility: {
      minMoshVersion: "1.0.0",
      commandCatalogSha256: "0".repeat(64),
      predicateCatalogVersion: 1,
      resolverCatalogVersion: 1,
      nativeSourceSha256: "0".repeat(64),
    },
  };
}

describe("parseNativeSkillPayloadV1", () => {
  it("accepts a valid native payload", () => {
    expect(parseNativeSkillPayloadV1(validNativePayload()).ok).toBe(true);
  });

  it("rejects an id outside the closed native ID universe", () => {
    expect(parseNativeSkillPayloadV1({ ...validNativePayload(), id: "not-a-real-skill" }).ok).toBe(false);
  });

  it("rejects a handlerKey that does not match the pinned id->handler map", () => {
    expect(parseNativeSkillPayloadV1({ ...validNativePayload(), handlerKey: "takeCycleV1" }).ok).toBe(false);
  });

  it("rejects a version with build metadata", () => {
    expect(parseNativeSkillPayloadV1({ ...validNativePayload(), version: "1.0.0+abc" }).ok).toBe(false);
  });

  it("rejects an unexpected top-level field", () => {
    expect(parseNativeSkillPayloadV1({ ...validNativePayload(), extra: 1 }).ok).toBe(false);
  });
});

describe("parseNativeSkillBundleEntryV1", () => {
  function validEntry(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      state: "owner_approved",
      skillId: "session-control",
      version: "1.0.0",
      nativePayloadSha256: "0".repeat(64),
      certificationReportSha256: "0".repeat(64),
      approvalSha256: "0".repeat(64),
      moshBuildIdentity: "git=0000000000000000000000000000000000000a|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64",
      bundledAt: "2026-08-14T00:00:00.000Z",
    };
  }

  it("accepts a valid bundle entry", () => {
    expect(parseNativeSkillBundleEntryV1(validEntry()).ok).toBe(true);
  });

  it("rejects a non-64-hex payload sha", () => {
    expect(parseNativeSkillBundleEntryV1({ ...validEntry(), nativePayloadSha256: "not-hex" }).ok).toBe(false);
  });

  it("rejects a skillId outside the closed native ID universe", () => {
    expect(parseNativeSkillBundleEntryV1({ ...validEntry(), skillId: "not-a-real-skill" }).ok).toBe(false);
  });

  it("rejects an unparseable bundledAt", () => {
    expect(parseNativeSkillBundleEntryV1({ ...validEntry(), bundledAt: "not-a-date" }).ok).toBe(false);
  });
});

describe("parseNativeReleaseVerificationV1", () => {
  function validVerification(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      state: "release_packaged_green",
      nativePayloadSha256: "0".repeat(64),
      certificationReportSha256: "0".repeat(64),
      approvalSha256: "0".repeat(64),
      bundleEntrySha256: "0".repeat(64),
      moshBuildIdentity: "git=0000000000000000000000000000000000000a|version=1.0.0|target=Mosh|configuration=Release|architecture=arm64",
      bundleSha256: "0".repeat(64),
      codeSignatureCDHash: "abc123",
      checks: [{ name: "native_selftest", status: "passed", artifactHashes: ["0".repeat(64)] }],
      verifiedAt: "2026-08-14T00:00:00.000Z",
    };
  }

  it("accepts a valid release verification", () => {
    expect(parseNativeReleaseVerificationV1(validVerification()).ok).toBe(true);
  });

  it("rejects an unknown check name", () => {
    const value = validVerification();
    value.checks = [{ name: "made_up_check", status: "passed", artifactHashes: [] }];
    expect(parseNativeReleaseVerificationV1(value).ok).toBe(false);
  });

  it("rejects an empty checks array", () => {
    expect(parseNativeReleaseVerificationV1({ ...validVerification(), checks: [] }).ok).toBe(false);
  });

  it("rejects a non-hex artifact hash inside a check", () => {
    const value = validVerification();
    value.checks = [{ name: "native_selftest", status: "passed", artifactHashes: ["not-hex"] }];
    expect(parseNativeReleaseVerificationV1(value).ok).toBe(false);
  });
});

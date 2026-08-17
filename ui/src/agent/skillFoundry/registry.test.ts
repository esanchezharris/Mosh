// Task 5 — Construct a Collision-Free Registry and Adapters.
//
// RED-first pin for `buildStudioSkillRegistryV1` and `validateRegistryCandidateV1`:
// ID-shape-by-origin rules, case-folded/cross-origin duplicate rejection (both by exact ID
// and by alias), atomic all-or-nothing construction, and `get(idOrAlias)` resolution
// (ASCII-lowercase, the one legacy alias). `validateReleaseIdentityUniverseV1` — also
// exported from `registry.ts` per the plan's Cross-Slice APIs — is tested in its own file,
// `skillIdentityUniverse.test.ts`, so its collision-across-index-enumerations coverage is
// provably COLLECTED by vitest (see that file's header for why).

import { describe, expect, it } from "vitest";
import type { NativeSkillPayloadV1, RegisteredSkillV1, SkillManifestV1 } from "./contracts";
import {
  buildStudioSkillRegistryV1,
  validateRegistryCandidateV1,
  type RegistryIdentitySetV1,
} from "./registry";

const HASH64 = "a".repeat(64);

const NATIVE_HANDLER_BY_ID: Record<NativeSkillPayloadV1["id"], NativeSkillPayloadV1["handlerKey"]> = {
  "session-control": "sessionControlV1",
  "capture-review-choose-take": "takeCycleV1",
  "explicit-balance": "explicitBalanceV1",
  "load-named-plugin": "loadNamedPluginV1",
};

function nativeManifest(id: NativeSkillPayloadV1["id"]): NativeSkillPayloadV1 {
  return {
    schemaVersion: 1,
    id,
    version: "1.0.0",
    implementation: "native",
    handlerKey: NATIVE_HANDLER_BY_ID[id],
    title: id,
    description: "test native skill",
    intents: { positiveExamples: [], negativeExamples: [], tags: [] },
    slots: [],
    execution: { mode: "atomic", confirmation: "never" },
    responses: { completed: "done", needsChoice: "which one?", blocked: "couldn't do that" },
    provenance: [],
    legacyAliases: [],
    compatibility: { minMoshVersion: "0.0.0", commandCatalogSha256: HASH64, predicateCatalogVersion: 1, resolverCatalogVersion: 1, nativeSourceSha256: HASH64 },
  };
}

/** A raw test-double `RegisteredSkillV1` candidate — built DIRECTLY, not through the real
 *  `nativeAdapter.ts`/`declarativeAdapter.ts`, so tests can construct otherwise-impossible
 *  shapes (uppercase IDs, aliases that only exist to prove cross-origin collision detection)
 *  that a real adapter would never emit. */
function native(id: NativeSkillPayloadV1["id"], aliases: readonly string[] = []): RegisteredSkillV1 {
  return { id, origin: "native", aliases, manifest: nativeManifest(id) };
}

function ownerManifest(id: string, overrides: Partial<SkillManifestV1> = {}): SkillManifestV1 {
  return {
    schemaVersion: 1, id, version: "1.0.0", title: "Set Volume",
    description: "Set the selected track's volume.", implementation: "declarative",
    intents: { positiveExamples: [], negativeExamples: [], tags: [] },
    slots: [],
    preconditions: [],
    steps: [{ kind: "resolve", resolver: "selected_track", bind: "track", maxChoices: 1 }],
    postconditions: [],
    execution: { mode: "atomic", confirmation: "never", maxMutations: 1, timeoutMs: 5000 },
    responses: { completed: "done", needsChoice: "which one?", blocked: "couldn't do that" },
    provenance: [],
    compatibility: { minMoshVersion: "0.0.0", commandCatalogSha256: HASH64, predicateCatalogVersion: 1, resolverCatalogVersion: 1 },
    ...overrides,
  };
}

function owner(id: string, aliases: readonly string[] = [], overrides: Partial<SkillManifestV1> = {}): RegisteredSkillV1 {
  return { id, origin: "owner", aliases, manifest: ownerManifest(id, overrides) };
}

function builtin(id: string, aliases: readonly string[] = []): RegisteredSkillV1 {
  return { id, origin: "builtin", aliases, manifest: ownerManifest(id) };
}

// ---------------------------------------------------------------------------------------
// validateRegistryCandidateV1
// ---------------------------------------------------------------------------------------

describe("validateRegistryCandidateV1", () => {
  it("accepts a valid owner candidate against an empty occupied set", () => {
    expect(validateRegistryCandidateV1(owner("owner-x"), new Set())).toEqual({ ok: true });
  });

  it("rejects an owner id without the owner- prefix", () => {
    const candidate: RegisteredSkillV1 = { id: "not-owner-prefixed", origin: "owner", aliases: [], manifest: ownerManifest("not-owner-prefixed") };
    expect(validateRegistryCandidateV1(candidate, new Set())).toMatchObject({ ok: false, code: "invalid_owner_prefix" });
  });

  it("rejects a builtin id without the builtin- prefix", () => {
    const candidate: RegisteredSkillV1 = { id: "not-builtin-prefixed", origin: "builtin", aliases: [], manifest: ownerManifest("not-builtin-prefixed") };
    expect(validateRegistryCandidateV1(candidate, new Set())).toMatchObject({ ok: false, code: "invalid_builtin_prefix" });
  });

  it("accepts a builtin id with the builtin- prefix", () => {
    expect(validateRegistryCandidateV1(builtin("builtin-metronome"), new Set())).toEqual({ ok: true });
  });

  it("rejects a native id outside the closed NATIVE_SKILL_IDS_V1 set", () => {
    const candidate: RegisteredSkillV1 = { id: "bogus-native-id", origin: "native", aliases: [], manifest: nativeManifest("session-control") };
    expect(validateRegistryCandidateV1(candidate, new Set())).toMatchObject({ ok: false, code: "invalid_native_id" });
  });

  it("rejects a duplicate id already in the occupied set", () => {
    const occupied: RegistryIdentitySetV1 = new Set(["owner-x"]);
    expect(validateRegistryCandidateV1(owner("owner-x"), occupied)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "owner-x" });
  });

  it("rejects a duplicate via one of the candidate's own aliases", () => {
    const occupied: RegistryIdentitySetV1 = new Set(["load_named_plugin"]);
    expect(validateRegistryCandidateV1(native("load-named-plugin", ["load_named_plugin"]), occupied)).toMatchObject({
      ok: false, code: "duplicate_identity", identity: "load_named_plugin",
    });
  });

  it("case-folds before comparing against the occupied set", () => {
    // Prefix casing must stay valid ("owner-") so this exercises the CASE-FOLD comparison,
    // not the (separately tested) prefix-shape rejection — only the suffix differs in case.
    const occupied: RegistryIdentitySetV1 = new Set(["owner-x"]);
    const candidate: RegisteredSkillV1 = { id: "owner-X", origin: "owner", aliases: [], manifest: ownerManifest("owner-X") };
    expect(validateRegistryCandidateV1(candidate, occupied)).toMatchObject({ ok: false, code: "duplicate_identity", identity: "owner-x" });
  });
});

// ---------------------------------------------------------------------------------------
// buildStudioSkillRegistryV1
// ---------------------------------------------------------------------------------------

describe("buildStudioSkillRegistryV1 — success", () => {
  it("admits distinct native/builtin/owner candidates and freezes one registry", async () => {
    const result = await buildStudioSkillRegistryV1({
      generation: 7,
      native: [native("load-named-plugin", ["load_named_plugin"])],
      builtin: [builtin("builtin-metronome")],
      owner: [owner("owner-set-volume")],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.generation).toBe(7);
    expect(result.registry.list()).toHaveLength(3);
    expect(result.registry.get("owner-set-volume")?.id).toBe("owner-set-volume");
    expect(result.registry.get("builtin-metronome")?.id).toBe("builtin-metronome");
  });

  it("get(idOrAlias) lowercases ASCII before resolving", async () => {
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [], owner: [owner("owner-set-volume")] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.get("OWNER-SET-VOLUME")?.id).toBe("owner-set-volume");
  });

  it("get(idOrAlias) canonicalizes the one legacy alias to the native id", async () => {
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [native("load-named-plugin", ["load_named_plugin"])], builtin: [], owner: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.get("load_named_plugin")?.id).toBe("load-named-plugin");
    expect(result.registry.get("LOAD_NAMED_PLUGIN")?.id).toBe("load-named-plugin");
  });

  it("get(idOrAlias) returns null for an unregistered identity", async () => {
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [], owner: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.get("owner-nonexistent")).toBeNull();
  });

  it("similar titles/positive-examples across distinct IDs never create precedence or collision", async () => {
    const a = owner("owner-a", [], { title: "Set track volume", intents: { positiveExamples: ["turn it up"], negativeExamples: [], tags: [] } });
    const b = owner("owner-b", [], { title: "Set track volume", intents: { positiveExamples: ["turn it up"], negativeExamples: [], tags: [] } });
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [], owner: [a, b] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.list()).toHaveLength(2);
    expect(result.registry.get("owner-a")?.id).toBe("owner-a");
    expect(result.registry.get("owner-b")?.id).toBe("owner-b");
  });
});

describe("buildStudioSkillRegistryV1 — rejection is atomic (whole generation, not partial)", () => {
  it("rejects same-origin duplicate owner IDs (the plan's own literal example)", async () => {
    const result = await buildStudioSkillRegistryV1({
      generation: 7,
      native: [native("load-named-plugin")],
      builtin: [],
      owner: [owner("owner-x"), owner("owner-x")],
    });
    expect(result).toMatchObject({ ok: false, code: "duplicate_identity" });
  });

  it("rejects a duplicate against all four native canonical IDs (via an owner candidate's own alias — a real owner id can never LITERALLY equal a native id, since owner ids always carry the disjoint owner- prefix)", async () => {
    for (const id of ["session-control", "capture-review-choose-take", "explicit-balance", "load-named-plugin"] as const) {
      const candidate = owner("owner-x", [id]);
      // eslint-disable-next-line no-await-in-loop
      const result = await buildStudioSkillRegistryV1({ generation: 1, native: [native(id)], builtin: [], owner: [candidate] });
      expect(result).toMatchObject({ ok: false, code: "duplicate_identity", identity: id });
    }
  });

  it("rejects a cross-origin duplicate via a native alias claimed by an owner candidate's own (test-double) alias", async () => {
    // A real declarativeAdapter.ts output never carries aliases (see that module's header) —
    // this constructs the collision directly to prove the CROSS-ORIGIN check fires even
    // when the collision is alias-vs-alias, not id-vs-id.
    const result = await buildStudioSkillRegistryV1({
      generation: 1,
      native: [native("load-named-plugin", ["load_named_plugin"])],
      builtin: [],
      owner: [owner("owner-x", ["load_named_plugin"])],
    });
    expect(result).toMatchObject({ ok: false, code: "duplicate_identity", identity: "load_named_plugin", origin: "owner" });
  });

  it("rejects a cross-origin duplicate between builtin and owner via a shared (test-double) alias — builtin-/owner- prefixes are disjoint, so only an alias can collide", async () => {
    const result = await buildStudioSkillRegistryV1({
      generation: 1,
      native: [],
      builtin: [builtin("builtin-x", ["shared-token"])],
      owner: [owner("owner-y", ["shared-token"])],
    });
    expect(result).toMatchObject({ ok: false, code: "duplicate_identity", identity: "shared-token" });
  });

  it("rejects a case-folded duplicate between a native canonical id and an owner candidate's (differently-cased) alias", async () => {
    const upper = owner("owner-x", ["SESSION-CONTROL"]);
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [native("session-control")], builtin: [], owner: [upper] });
    expect(result).toMatchObject({ ok: false, code: "duplicate_identity", identity: "session-control" });
  });

  it("does not publish a partial registry on rejection — the caller keeps using its own prior registry reference", async () => {
    const priorResult = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [], owner: [owner("owner-a")] });
    expect(priorResult.ok).toBe(true);
    if (!priorResult.ok) return;
    const prior = priorResult.registry;

    const rejected = await buildStudioSkillRegistryV1({ generation: 2, native: [], builtin: [], owner: [owner("owner-b"), owner("owner-b")] });
    expect(rejected.ok).toBe(false);

    // The prior registry object is untouched: still generation 1, still only owner-a.
    expect(prior.generation).toBe(1);
    expect(prior.list()).toHaveLength(1);
    expect(prior.get("owner-b")).toBeNull();
  });

  it("rejects an invalid owner-prefixed ID reaching build via the owner array", async () => {
    const bad: RegisteredSkillV1 = { id: "not-owner-prefixed", origin: "owner", aliases: [], manifest: ownerManifest("not-owner-prefixed") };
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [], owner: [bad] });
    expect(result).toMatchObject({ ok: false, code: "invalid_owner_prefix" });
  });

  it("rejects an invalid builtin-prefixed ID reaching build via the builtin array", async () => {
    const bad: RegisteredSkillV1 = { id: "not-builtin-prefixed", origin: "builtin", aliases: [], manifest: ownerManifest("not-builtin-prefixed") };
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [], builtin: [bad], owner: [] });
    expect(result).toMatchObject({ ok: false, code: "invalid_builtin_prefix" });
  });

  it("rejects an unknown native ID reaching build via the native array", async () => {
    const bad: RegisteredSkillV1 = { id: "bogus-native-id", origin: "native", aliases: [], manifest: nativeManifest("session-control") };
    const result = await buildStudioSkillRegistryV1({ generation: 1, native: [bad], builtin: [], owner: [] });
    expect(result).toMatchObject({ ok: false, code: "invalid_native_id" });
  });
});

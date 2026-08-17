// Task 8 — Closed Primitives.
//
// Exercises `runObservationV1`/`runResolverV1`/`evaluatePredicateV1` in isolation, against
// hand-built `Snapshot`/`StudioContext`/environment fixtures — no real bridge, no store. Each
// function is pure or takes an injected `exec`, so every scenario here is deterministic.

import { describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../../types";
import type { StudioContext } from "../studioSkills";
import type { StudioSkillEnvironmentV1 } from "./contracts";
import {
  evaluatePredicateV1,
  parseInstalledPluginCatalogV1,
  runObservationV1,
  runResolverV1,
} from "./primitives";

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: "track-1", index: 0, name: "Bass", type: "audio", clips: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" },
    tracks: [track()],
    ...overrides,
  } as unknown as Snapshot;
}

function context(overrides: Partial<StudioContext> = {}): StudioContext {
  return { projectEpoch: 1, selectedTrackId: "track-1", tracks: [{ id: "track-1", name: "Bass" }], ...overrides };
}

function envWithExec(exec: StudioSkillEnvironmentV1["exec"]): StudioSkillEnvironmentV1 {
  return {
    context: () => context(),
    snapshot: async () => snapshot(),
    exec,
    readSourceStatus: async () => ({ schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] }),
    runBatch: async () => ({ label: "", entries: [], applied: 0 }),
    refresh: async () => {},
    recording: {
      start: async () => ({ ok: true, state: "recording", say: "", changes: null }),
      stop: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      audition: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      keep: async () => ({ ok: true, state: "idle", say: "", changes: null }),
    },
  };
}

function envAlwaysFails(): StudioSkillEnvironmentV1 {
  return envWithExec(async () => { throw new Error("should never be called"); });
}

function availablePlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "v:vital", name: "Vital", format: "VST3", manufacturer: "Matt Tytel", isInstrument: true, ...overrides };
}

// ---------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------

describe("runObservationV1 — current_snapshot", () => {
  it("binds the already-captured before snapshot without any environment call", async () => {
    const before = snapshot();
    const outcome = await runObservationV1("current_snapshot", before, envAlwaysFails());
    expect(outcome).toEqual({ ok: true, value: before });
  });
});

describe("runObservationV1 — list_plugins", () => {
  it("returns the parsed, bounded plugin catalog", async () => {
    const env = envWithExec(async (command) => {
      expect(command).toBe("list_plugins");
      return { ok: true, data: { plugins: [availablePlugin()] } };
    });
    const outcome = await runObservationV1("list_plugins", snapshot(), env);
    expect(outcome).toEqual({ ok: true, value: [availablePlugin()] });
  });

  it("fails when the bridge refuses the command", async () => {
    const env = envWithExec(async () => ({ ok: false, error: "no service" }));
    const outcome = await runObservationV1("list_plugins", snapshot(), env);
    expect(outcome).toEqual({ ok: false, reason: "no service" });
  });

  it("fails when the transport rejects", async () => {
    const env = envWithExec(async () => { throw new Error("transport down"); });
    const outcome = await runObservationV1("list_plugins", snapshot(), env);
    expect(outcome.ok).toBe(false);
  });

  it("fails on malformed plugin data", async () => {
    const env = envWithExec(async () => ({ ok: true, data: { plugins: [{ id: "x" }] } }));
    const outcome = await runObservationV1("list_plugins", snapshot(), env);
    expect(outcome).toEqual({ ok: false, reason: "list_plugins returned malformed or oversized data" });
  });

  it("fails on an oversized plugin catalog", () => {
    const plugins = Array.from({ length: 4_097 }, (_, i) => availablePlugin({ id: `v:${i}` }));
    expect(parseInstalledPluginCatalogV1({ plugins })).toBeNull();
  });

  it("accepts exactly the catalog cap", () => {
    const plugins = Array.from({ length: 4_096 }, (_, i) => availablePlugin({ id: `v:${i}` }));
    expect(parseInstalledPluginCatalogV1({ plugins })).not.toBeNull();
  });

  it("fails on an oversized plugin field", () => {
    const plugins = [availablePlugin({ name: "x".repeat(1_025) })];
    expect(parseInstalledPluginCatalogV1({ plugins })).toBeNull();
  });

  it("accepts exactly the field-length cap", () => {
    const plugins = [availablePlugin({ name: "x".repeat(1_024) })];
    expect(parseInstalledPluginCatalogV1({ plugins })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------------------

describe("runResolverV1 — selected_track", () => {
  it("resolves the context's selected track", async () => {
    const before = snapshot({ tracks: [track({ id: "track-1", name: "Bass" })] });
    const outcome = await runResolverV1("selected_track", {}, before, context({ selectedTrackId: "track-1" }), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "resolved", role: "trackId", entityId: "track-1" });
  });

  it("reports none when nothing is selected", async () => {
    const before = snapshot();
    const outcome = await runResolverV1("selected_track", {}, before, context({ selectedTrackId: null }), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "none" });
  });

  it("reports none when the selected track no longer exists", async () => {
    const before = snapshot({ tracks: [track({ id: "track-1" })] });
    const outcome = await runResolverV1("selected_track", {}, before, context({ selectedTrackId: "gone" }), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "none" });
  });
});

describe("runResolverV1 — track_by_unique_name", () => {
  it("matches case-insensitively, normalized", async () => {
    const before = snapshot({ tracks: [track({ id: "t1", name: "Lead Vocal" })] });
    const outcome = await runResolverV1("track_by_unique_name", { name: "  LEAD   vocal  " }, before, context(), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "resolved", role: "trackId", entityId: "t1" });
  });

  it("reports none on zero matches", async () => {
    const before = snapshot({ tracks: [track({ id: "t1", name: "Lead Vocal" })] });
    const outcome = await runResolverV1("track_by_unique_name", { name: "Drums" }, before, context(), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "none" });
  });

  it("offers choices up to the declared cap", async () => {
    const before = snapshot({
      tracks: [track({ id: "t1", name: "Guitar" }), track({ id: "t2", name: "guitar" })],
    });
    const outcome = await runResolverV1("track_by_unique_name", { name: "Guitar" }, before, context(), envAlwaysFails(), 5);
    expect(outcome).toEqual({
      kind: "choices",
      role: "trackId",
      candidates: [{ entityId: "t1", label: "Guitar" }, { entityId: "t2", label: "guitar" }],
    });
  });

  it("rejects at exactly the five-choice cap boundary but accepts at four", async () => {
    const fiveTracks = Array.from({ length: 5 }, (_, i) => track({ id: `t${i}`, name: "Guitar" }));
    const before5 = snapshot({ tracks: fiveTracks });
    expect(await runResolverV1("track_by_unique_name", { name: "Guitar" }, before5, context(), envAlwaysFails(), 5)).toMatchObject({
      kind: "choices",
    });

    const sixTracks = Array.from({ length: 6 }, (_, i) => track({ id: `t${i}`, name: "Guitar" }));
    const before6 = snapshot({ tracks: sixTracks });
    expect(await runResolverV1("track_by_unique_name", { name: "Guitar" }, before6, context(), envAlwaysFails(), 5)).toEqual({
      kind: "too_many",
      count: 6,
    });
  });

  it("dedupes a duplicate-id anomaly into one resolved match, not an ambiguity", async () => {
    const before = snapshot({
      tracks: [track({ id: "t1", name: "Guitar" }), track({ id: "t1", name: "Guitar" })],
    });
    const outcome = await runResolverV1("track_by_unique_name", { name: "Guitar" }, before, context(), envAlwaysFails(), 5);
    expect(outcome).toEqual({ kind: "resolved", role: "trackId", entityId: "t1" });
  });

  it("fails closed on an empty name", async () => {
    const outcome = await runResolverV1("track_by_unique_name", { name: "" }, snapshot(), context(), envAlwaysFails(), 5);
    expect(outcome.kind).toBe("failed");
  });
});

describe("runResolverV1 — plugin_by_name", () => {
  it("resolves against a freshly fetched installed catalog", async () => {
    let calls = 0;
    const env = envWithExec(async () => {
      calls += 1;
      return { ok: true, data: { plugins: [availablePlugin({ id: "v:vital", name: "Vital" })] } };
    });
    const outcome = await runResolverV1("plugin_by_name", { name: "vital" }, snapshot(), context(), env, 5);
    expect(outcome).toEqual({ kind: "resolved", role: "pluginId", entityId: "v:vital" });
    expect(calls).toBe(1);
  });

  it("reports none on zero matches", async () => {
    const env = envWithExec(async () => ({ ok: true, data: { plugins: [availablePlugin({ name: "OTT" })] } }));
    const outcome = await runResolverV1("plugin_by_name", { name: "Vital" }, snapshot(), context(), env, 5);
    expect(outcome).toEqual({ kind: "none" });
  });

  it("offers choices for multiple installed plug-ins with the same name", async () => {
    const env = envWithExec(async () => ({
      ok: true,
      data: {
        plugins: [
          availablePlugin({ id: "v:a", name: "Delay", manufacturer: "Vendor A" }),
          availablePlugin({ id: "v:b", name: "Delay", manufacturer: "Vendor B" }),
        ],
      },
    }));
    const outcome = await runResolverV1("plugin_by_name", { name: "Delay" }, snapshot(), context(), env, 5);
    expect(outcome).toEqual({
      kind: "choices",
      role: "pluginId",
      candidates: [
        { entityId: "v:a", label: "Delay — Vendor A" },
        { entityId: "v:b", label: "Delay — Vendor B" },
      ],
    });
  });

  it("fails when the catalog is malformed", async () => {
    const env = envWithExec(async () => ({ ok: true, data: { plugins: [{ bad: true }] } }));
    const outcome = await runResolverV1("plugin_by_name", { name: "Vital" }, snapshot(), context(), env, 5);
    expect(outcome.kind).toBe("failed");
  });

  it("fails closed on an empty name", async () => {
    const outcome = await runResolverV1("plugin_by_name", { name: "" }, snapshot(), context(), envAlwaysFails(), 5);
    expect(outcome.kind).toBe("failed");
  });
});

// ---------------------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------------------

describe("evaluatePredicateV1", () => {
  it("not_recording passes when no controller state is present", () => {
    expect(evaluatePredicateV1("not_recording", {}, { snapshot: snapshot(), studioContext: context() })).toEqual({ ok: true });
  });

  it("not_recording fails while a take is recording", () => {
    const withController = snapshot({ controller: { mode: "capture", record: "recording", take: { exists: false }, agent: "idle" } });
    const result = evaluatePredicateV1("not_recording", {}, { snapshot: withController, studioContext: context() });
    expect(result.ok).toBe(false);
  });

  it("not_recording passes while merely armed", () => {
    const armed = snapshot({ controller: { mode: "capture", record: "armed", take: { exists: false }, agent: "idle" } });
    expect(evaluatePredicateV1("not_recording", {}, { snapshot: armed, studioContext: context() })).toEqual({ ok: true });
  });

  it("project_epoch_unchanged passes when the captured epoch still matches", () => {
    const result = evaluatePredicateV1("project_epoch_unchanged", { epoch: 7 }, { snapshot: snapshot(), studioContext: context({ projectEpoch: 7 }) });
    expect(result).toEqual({ ok: true });
  });

  it("project_epoch_unchanged fails when the project has moved on", () => {
    const result = evaluatePredicateV1("project_epoch_unchanged", { epoch: 7 }, { snapshot: snapshot(), studioContext: context({ projectEpoch: 8 }) });
    expect(result.ok).toBe(false);
  });

  it("selected_track_is passes/fails on an exact match", () => {
    const ctx = { snapshot: snapshot(), studioContext: context({ selectedTrackId: "track-1" }) };
    expect(evaluatePredicateV1("selected_track_is", { trackId: "track-1" }, ctx)).toEqual({ ok: true });
    expect(evaluatePredicateV1("selected_track_is", { trackId: "other" }, ctx).ok).toBe(false);
  });

  it("track_exists passes/fails on presence", () => {
    const s = snapshot({ tracks: [track({ id: "t1" })] });
    const ctx = { snapshot: s, studioContext: context() };
    expect(evaluatePredicateV1("track_exists", { trackId: "t1" }, ctx)).toEqual({ ok: true });
    expect(evaluatePredicateV1("track_exists", { trackId: "gone" }, ctx).ok).toBe(false);
  });

  it("track_volume_equals compares the exact stored dB", () => {
    const s = snapshot({ tracks: [track({ id: "t1", volumeDb: -6 })] });
    const ctx = { snapshot: s, studioContext: context() };
    expect(evaluatePredicateV1("track_volume_equals", { trackId: "t1", db: -6 }, ctx)).toEqual({ ok: true });
    expect(evaluatePredicateV1("track_volume_equals", { trackId: "t1", db: -5 }, ctx).ok).toBe(false);
  });

  it("track_mute_equals treats an absent flag as false", () => {
    const s = snapshot({ tracks: [track({ id: "t1" })] });
    const ctx = { snapshot: s, studioContext: context() };
    expect(evaluatePredicateV1("track_mute_equals", { trackId: "t1", mute: false }, ctx)).toEqual({ ok: true });
    expect(evaluatePredicateV1("track_mute_equals", { trackId: "t1", mute: true }, ctx).ok).toBe(false);
  });

  it("track_solo_equals treats an absent flag as false", () => {
    const s = snapshot({ tracks: [track({ id: "t1", solo: true })] });
    const ctx = { snapshot: s, studioContext: context() };
    expect(evaluatePredicateV1("track_solo_equals", { trackId: "t1", solo: true }, ctx)).toEqual({ ok: true });
    expect(evaluatePredicateV1("track_solo_equals", { trackId: "t1", solo: false }, ctx).ok).toBe(false);
  });

  describe("plugin_instance_added_once", () => {
    const ctxFor = (plugins: { catalogId?: string }[]) => ({
      snapshot: snapshot({ tracks: [track({ id: "t1", plugins: plugins as Track["plugins"] })] }),
      studioContext: context(),
    });

    it("passes when exactly one plug-in carries the resolved catalogId", () => {
      const result = evaluatePredicateV1("plugin_instance_added_once", { trackId: "t1", pluginId: "id-1" }, ctxFor([{ catalogId: "id-1" }]));
      expect(result).toEqual({ ok: true });
    });

    it("fails when zero plug-ins carry the resolved catalogId", () => {
      const result = evaluatePredicateV1("plugin_instance_added_once", { trackId: "t1", pluginId: "id-1" }, ctxFor([]));
      expect(result.ok).toBe(false);
    });

    it("fails when two plug-ins carry the resolved catalogId", () => {
      const result = evaluatePredicateV1(
        "plugin_instance_added_once", { trackId: "t1", pluginId: "id-1" },
        ctxFor([{ catalogId: "id-1" }, { catalogId: "id-1" }]),
      );
      expect(result.ok).toBe(false);
    });

    it("fails when the plug-in has no stamped catalogId at all", () => {
      const result = evaluatePredicateV1("plugin_instance_added_once", { trackId: "t1", pluginId: "id-1" }, ctxFor([{}]));
      expect(result.ok).toBe(false);
    });
  });
});

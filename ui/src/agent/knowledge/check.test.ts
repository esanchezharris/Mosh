import { describe, it, expect } from "vitest";
import { runCheck, type CheckSpec } from "./check";
import type { MidiNote } from "../../types";

const note = (i: number, pitch: number, start: number, velocity = 90, length = 0.25): MidiNote => ({ i, pitch, start, length, velocity });

// minimal snapshot slices — only the fields the readers touch.
const midiTrack = (trackId: string, clipId: string, notes: MidiNote[]) => ({
  id: trackId, index: 0, name: trackId, type: "audio",
  clips: [{ id: clipId, name: clipId, type: "midi", start: 0, length: 4, offset: 0, notes, hasRenderLayer: false }],
  plugins: [], sends: [],
});
const fxTrack = (trackId: string, pluginIndex: number, param: any, sends: any[] = []) => ({
  id: trackId, index: 0, name: trackId, type: "audio", clips: [],
  plugins: [{ index: pluginIndex, name: "eq", type: "builtin", enabled: true, external: false, isInstrument: false, params: [param] }],
  sends,
});
const snapOf = (...tracks: any[]) => ({ tracks });

// runCheck is the dispatcher: a declarative CheckSpec (with $token refs) → the matching
// conformance reader, reading the resolved clip/track/param out of the after-snapshot.
// These prove the dispatch + the $token resolution (the closure→data migration's core).

describe("runCheck · pattern — dispatches with $token clip resolution", () => {
  const pattern = { hits: [{ pitch: 36, beats: [0, 2.5] }, { pitch: 38, beats: [1, 3] }] };
  const full = [note(0, 36, 0), note(1, 36, 2.5), note(2, 38, 1), note(3, 38, 3)];
  const spec: CheckSpec = { kind: "pattern", clip: "$drumClipId", pattern };
  const bindings = { drumClipId: "clip_kit" };
  it("conformant when the bound clip holds the full grid", () => {
    const after = snapOf(midiTrack("trk_d", "clip_kit", full));
    expect(runCheck(spec, snapOf(), after, bindings, {}).conformant).toBe(true);
  });
  it("not conformant when a hit is missing", () => {
    const after = snapOf(midiTrack("trk_d", "clip_kit", full.filter((n) => !(n.pitch === 38 && n.start === 3))));
    expect(runCheck(spec, snapOf(), after, bindings, {}).conformant).toBe(false);
  });
  it("unbound clip token → no such clip → empty notes → not conformant (graceful)", () => {
    const after = snapOf(midiTrack("trk_d", "clip_kit", full));
    expect(runCheck(spec, snapOf(), after, {}, {}).conformant).toBe(false);
  });
});

describe("runCheck · swing — off-beat 8ths pushed late", () => {
  const div = 0.5, swing = 0.58;
  const spec: CheckSpec = { kind: "swing", clip: "$hatsClipId", division: div, swing };
  const swung = Array.from({ length: 8 }, (_, s) => note(s, 42, s * div + (s % 2 ? swing * div : 0)));
  it("conformant when the bound clip is swung", () => {
    const after = snapOf(midiTrack("trk_h", "clip_h", swung));
    expect(runCheck(spec, snapOf(), after, { hatsClipId: "clip_h" }, {}).conformant).toBe(true);
  });
  it("not conformant when straight", () => {
    const straight = Array.from({ length: 8 }, (_, s) => note(s, 42, s * div));
    const after = snapOf(midiTrack("trk_h", "clip_h", straight));
    expect(runCheck(spec, snapOf(), after, { hatsClipId: "clip_h" }, {}).conformant).toBe(false);
  });
});

describe("runCheck · humanize — before vs after of the bound clip", () => {
  const spec: CheckSpec = { kind: "humanize", clip: "$keysClipId", maxOffsetBeats: 0.125 };
  const before = [note(0, 60, 0, 90), note(1, 62, 1, 90), note(2, 64, 2, 90)];
  const b = { keysClipId: "clip_k" };
  it("conformant for bounded jitter", () => {
    const after = [note(0, 60, 0.03, 96), note(1, 62, 0.98, 84), note(2, 64, 2.05, 92)];
    expect(runCheck(spec, snapOf(midiTrack("t", "clip_k", before)), snapOf(midiTrack("t", "clip_k", after)), b, {}).conformant).toBe(true);
  });
  it("not conformant for a no-op (reads BEFORE, not just after)", () => {
    expect(runCheck(spec, snapOf(midiTrack("t", "clip_k", before)), snapOf(midiTrack("t", "clip_k", before)), b, {}).conformant).toBe(false);
  });
});

describe("runCheck · automation — numeric $token indices, missing param guarded", () => {
  const spec: CheckSpec = { kind: "automation", track: "$keysTrackId", pluginIndex: "$pi", paramIndex: "$ri", direction: "up" };
  const b = { keysTrackId: "trk_keys", pi: 3, ri: 7 };
  const param = (points: { t: number; v: number }[]) => ({ index: 7, name: "Frequency", value: 0.5, automated: points.length > 0, points });
  it("conformant for a rising curve at the resolved track/plugin/param", () => {
    const after = snapOf(fxTrack("trk_keys", 3, param([{ t: 0, v: 0.2 }, { t: 4, v: 0.9 }])));
    expect(runCheck(spec, snapOf(), after, b, {}).conformant).toBe(true);
  });
  it("not conformant when the direction is wrong", () => {
    const after = snapOf(fxTrack("trk_keys", 3, param([{ t: 0, v: 0.9 }, { t: 4, v: 0.2 }])));
    expect(runCheck(spec, snapOf(), after, b, {}).conformant).toBe(false);
  });
  it("not conformant (guarded) when the param can't be found", () => {
    const after = snapOf(fxTrack("trk_keys", 99, param([{ t: 0, v: 0.2 }, { t: 4, v: 0.9 }])));
    const r = runCheck(spec, snapOf(), after, b, {});
    expect(r.conformant).toBe(false);
    expect(r.detail).toMatch(/no param|automation/i);
  });
});

describe("runCheck · send — bus token resolves from RUNTIME (captured mid-recipe)", () => {
  const spec: CheckSpec = { kind: "send", track: "$keysTrackId", bus: "$busNumber", db: -12 };
  const b = { keysTrackId: "trk_keys" };
  it("conformant when the track sends to the runtime-captured bus at the level", () => {
    const after = snapOf(fxTrack("trk_keys", 0, { index: 0, name: "x", value: 0 }, [{ bus: 5, db: -12, mute: false }]));
    expect(runCheck(spec, snapOf(), after, b, { busNumber: 5 }).conformant).toBe(true);
  });
  it("not conformant when the level is off", () => {
    const after = snapOf(fxTrack("trk_keys", 0, { index: 0, name: "x", value: 0 }, [{ bus: 5, db: -3, mute: false }]));
    expect(runCheck(spec, snapOf(), after, b, { busNumber: 5 }).conformant).toBe(false);
  });
  it("not conformant (guarded) when the track is missing", () => {
    expect(runCheck(spec, snapOf(), snapOf(), b, { busNumber: 5 }).conformant).toBe(false);
  });
});

describe("runCheck · $token scope — runtime captures override base on a name collision", () => {
  // base.trackId and runtime.trackId both present; a just-created (runtime) id wins, so
  // $trackId resolves to the runtime value. $busNumber (runtime-only) also resolves.
  const spec: CheckSpec = { kind: "send", track: "$trackId", bus: "$busNumber" };
  it("resolves $trackId from runtime (the just-created id), $busNumber from runtime", () => {
    const after = snapOf(fxTrack("runtime_track", 0, { index: 0, name: "x", value: 0 }, [{ bus: 2, db: -6, mute: false }]));
    expect(runCheck(spec, snapOf(), after, { trackId: "base_track" }, { trackId: "runtime_track", busNumber: 2 }).conformant).toBe(true);
  });
});

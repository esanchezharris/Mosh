import { describe, expect, it } from "vitest";
import type { Clip, Snapshot, Track } from "../types";
import {
  buildProToolsFadePlan,
  proToolsFadeTargets,
  type ProToolsFadeOptions,
} from "./proToolsFades";

const wave = (id: string, start: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  name: id.toUpperCase(),
  type: "wave",
  start,
  length,
  offset: 0,
  hasRenderLayer: false,
  ...extra,
});

const track = (id: string, index: number, clips: Clip[]): Track => ({
  id,
  index,
  name: id.toUpperCase(),
  type: "audio",
  clips,
});

const A = wave("a", 0, 5, { autoCrossfade: true });
const B = wave("b", 4, 4, { autoCrossfade: true });
const C = wave("c", 10, 2);
const D = wave("d", 1, 3);
const MIDI: Clip = {
  id: "midi",
  name: "MIDI",
  type: "midi",
  start: 2,
  length: 2,
  offset: 0,
  hasRenderLayer: false,
  notes: [],
};
const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/fades.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [
    track("t1", 0, [A, B, C, MIDI, wave("render", 3, 2, { hidden: true })]),
    track("t2", 1, [D]),
  ],
  transport: {
    playing: false,
    recording: false,
    position: 0,
    looping: false,
    loopStart: 0,
    loopEnd: 0,
  },
};

const OPTIONS: ProToolsFadeOptions = {
  fadeIns: true,
  fadeOuts: true,
  crossfades: true,
  edgeLengthMs: 20,
  curveIn: "convex",
  curveOut: "concave",
};

describe("Pro Tools Fades selection model", () => {
  it("gives the Edit range and associated tracks precedence over object selection", () => {
    const targets = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([D.id]),
      editingClipId: D.id,
      editRange: { start: 3, end: 6 },
      editTrackIds: ["t1"],
    });

    expect(targets.map((target) => target.clip.id)).toEqual([A.id, B.id]);
  });

  it("falls back from selected wave clips to the active audio inspector clip", () => {
    const selected = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([D.id, MIDI.id]),
      editingClipId: A.id,
      editRange: null,
      editTrackIds: [],
    });
    expect(selected.map((target) => target.clip.id)).toEqual([D.id]);

    const active = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([MIDI.id]),
      editingClipId: A.id,
      editRange: null,
      editTrackIds: [],
    });
    expect(active.map((target) => target.clip.id)).toEqual([A.id]);
  });
});

describe("Pro Tools Fades edit plan", () => {
  it("uses the exact overlap for a two-curve crossfade and preserves outer edge fades", () => {
    const targets = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([A.id, B.id]),
      editingClipId: A.id,
      editRange: null,
      editTrackIds: [],
    });
    const plan = buildProToolsFadePlan(targets, OPTIONS);

    expect(plan.crossfades).toEqual([{
      trackId: "t1",
      outgoingClipId: A.id,
      incomingClipId: B.id,
      durationSec: 1,
    }]);
    expect(plan.edits).toEqual([{
      clipId: A.id,
      fadeInSec: 0.02,
      fadeOutSec: 1,
      curveIn: "convex",
      curveOut: "concave",
    }, {
      clipId: B.id,
      fadeInSec: 1,
      fadeOutSec: 0.02,
      curveIn: "convex",
      curveOut: "concave",
    }]);
    expect(plan.disableAutoCrossfadeIds).toEqual([A.id, B.id]);
  });

  it("creates only the first and last requested edge fades when clips do not overlap", () => {
    const targets = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([A.id, C.id]),
      editingClipId: null,
      editRange: null,
      editTrackIds: [],
    });
    const plan = buildProToolsFadePlan(targets, { ...OPTIONS, crossfades: false });

    expect(plan.crossfades).toEqual([]);
    expect(plan.edits).toEqual([{
      clipId: A.id,
      fadeInSec: 0.02,
      curveIn: "convex",
    }, {
      clipId: C.id,
      fadeOutSec: 0.02,
      curveOut: "concave",
    }]);
  });

  it("scales two edge fades proportionally so they never exceed one clip", () => {
    const targets = proToolsFadeTargets({
      snapshot: SNAPSHOT,
      selectedClipIds: new Set([A.id]),
      editingClipId: null,
      editRange: null,
      editTrackIds: [],
    });
    const plan = buildProToolsFadePlan(targets, { ...OPTIONS, crossfades: false, edgeLengthMs: 4_000 });

    expect(plan.edits).toEqual([{
      clipId: A.id,
      fadeInSec: 2.5,
      fadeOutSec: 2.5,
      curveIn: "convex",
      curveOut: "concave",
    }]);
  });
});

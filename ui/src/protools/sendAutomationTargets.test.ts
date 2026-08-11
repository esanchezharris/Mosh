import { describe, expect, it } from "vitest";
import type { Snapshot, Track } from "../types";
import {
  proToolsAutomationTargets,
  resolveProToolsAutomationTarget,
} from "./sendAutomationTargets";

const TRACK: Track = {
  id: "vocal",
  index: 0,
  name: "Lead Vocal",
  type: "audio",
  clips: [],
  sends: [{
    bus: 2,
    db: -6,
    pan: 0,
    mute: false,
    automation: {
      pluginIndex: 4,
      levelParamIndex: 0,
      panParamIndex: 1,
      muteParamIndex: 2,
    },
  }],
  plugins: [{
    index: 4,
    name: "Aux Send",
    type: "auxsend",
    enabled: true,
    external: false,
    isInstrument: false,
    params: [
      { index: 0, name: "Send level", value: 0.7, points: [{ t: 1, v: 0.6 }] },
      { index: 1, name: "Send pan", value: 0.5, points: [] },
      { index: 2, name: "Send mute", value: 0, points: [{ t: 2, v: 1 }], discrete: true, states: 2 },
    ],
  }],
  mixerPlugins: [{
    index: 7,
    name: "Track Fader",
    type: "volume",
    enabled: true,
    external: false,
    isInstrument: false,
    params: [{ index: 0, name: "Volume", value: 0.8, points: [] }],
  }],
};

const SNAPSHOT = {
  schemaVersion: 1,
  session: {
    sampleRate: 48_000,
    tempo: 120,
    editFile: "/tmp/send-targets.mosh",
    key: { tonic: "C", mode: "major" },
  },
  tracks: [TRACK],
  buses: [{ bus: 2, name: "Plate", trackId: "return-2" }],
  transport: {
    playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0,
  },
} satisfies Snapshot;

describe("Pro Tools send automation targets", () => {
  it("orders Volume before each labelled send parameter", () => {
    expect(proToolsAutomationTargets(TRACK, SNAPSHOT).map(({ id, label }) => ({ id, label })))
      .toEqual([
        { id: "volume", label: "Volume" },
        { id: "send:2:level", label: "Plate · Level" },
        { id: "send:2:pan", label: "Plate · Pan" },
        { id: "send:2:mute", label: "Plate · Mute" },
      ]);
  });

  it("resolves the exact physical plug-in parameter and retains discrete mute metadata", () => {
    expect(resolveProToolsAutomationTarget(TRACK, "send:2:mute")).toEqual({
      pluginIndex: 4,
      paramIndex: 2,
      paramName: "Send mute",
      value: 0,
      points: [{ t: 2, v: 1 }],
      discrete: true,
      states: 2,
    });
  });

  it("falls back to Volume when a remembered send no longer exists", () => {
    expect(resolveProToolsAutomationTarget({ ...TRACK, sends: [] }, "send:2:pan"))
      .toMatchObject({ pluginIndex: 7, paramIndex: 0, paramName: "Volume" });
  });
});

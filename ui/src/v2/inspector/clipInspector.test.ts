import { describe, it, expect } from "vitest";
import { clipInspectorModel, GAIN_MIN_DB, GAIN_MAX_DB } from "./clipInspector";
import type { Clip } from "../../types";

const wave: Clip = {
  id: "c1",
  name: "Loop",
  type: "wave",
  start: 0,
  length: 4,
  offset: 0,
  mute: false,
  gainDb: 0,
  hasRenderLayer: false,
};

const midi: Clip = {
  id: "m1",
  name: "Riff",
  type: "midi",
  start: 0,
  length: 8,
  offset: 0,
  mute: true,
  hasRenderLayer: false,
};

describe("clipInspectorModel", () => {
  it("rename always available and emits rename_clip with the new name", () => {
    const m = clipInspectorModel(wave);
    expect(m.canRename).toBe(true);
    expect(m.rename("New name")).toEqual({
      command: "rename_clip",
      args: { clipId: "c1", name: "New name" },
    });
  });

  it("mute always available and emits set_clip_mute with the toggled value", () => {
    const m = clipInspectorModel(wave);
    expect(m.canMute).toBe(true);
    // wave.mute is false → toggling sends mute:true
    expect(m.toggleMute()).toEqual({
      command: "set_clip_mute",
      args: { clipId: "c1", mute: true },
    });
  });

  it("toggleMute respects the current muted state (true → false)", () => {
    const m = clipInspectorModel(midi);
    expect(m.muted).toBe(true);
    expect(m.toggleMute()).toEqual({
      command: "set_clip_mute",
      args: { clipId: "m1", mute: false },
    });
  });

  it("gain is exposed only for wave (audio) clips", () => {
    expect(clipInspectorModel(wave).canSetGain).toBe(true);
    expect(clipInspectorModel(midi).canSetGain).toBe(false);
  });

  it("setGain emits set_clip_gain with gainDb for a wave clip", () => {
    const m = clipInspectorModel(wave);
    expect(m.setGain(6)).toEqual({
      command: "set_clip_gain",
      args: { clipId: "c1", gainDb: 6 },
    });
  });

  it("setGain clamps to the backend range [-48, 24]", () => {
    const m = clipInspectorModel(wave);
    expect(m.setGain(999)?.args.gainDb).toBe(GAIN_MAX_DB);
    expect(m.setGain(-999)?.args.gainDb).toBe(GAIN_MIN_DB);
    expect(GAIN_MIN_DB).toBe(-48);
    expect(GAIN_MAX_DB).toBe(24);
  });

  it("setGain returns null for a non-audio clip (no command emitted)", () => {
    expect(clipInspectorModel(midi).setGain(6)).toBeNull();
  });

  it("reports current values for display defaulting gain to 0", () => {
    expect(clipInspectorModel(wave).gainDb).toBe(0);
    expect(clipInspectorModel({ ...wave, gainDb: -3 }).gainDb).toBe(-3);
    expect(clipInspectorModel(wave).name).toBe("Loop");
  });
});

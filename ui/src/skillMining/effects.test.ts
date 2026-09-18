import { describe, expect, it } from "vitest";
import { checkEffect } from "./effects";
import type { Json } from "./types";

const clip = { id: "c1", name: "One", type: "midi", start: 4, length: 8, offset: 0, notes: [{ i: 0, pitch: 60, start: 0, length: 1, velocity: 90 }] };
const base = { session: { tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, key: { tonic: "C", mode: "major" } }, tracks: [{ id: "t1", name: "Track", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [clip] }] };
const withClip = (value: Json) => ({ ...base, tracks: [{ ...base.tracks[0], clips: [value] }] });

describe("snapshot effect checking", () => {
  it("checks native session tempo and exact requested value", () => {
    expect(checkEffect({ command: "set_tempo", args: { bpm: 93 } }, base, { ...base, session: { ...base.session, tempo: 93 } }).status).toBe("passed");
  });
  it.each([{ ...base, tempo: 93 }, { ...base, session: { ...base.session, tempo: 100 } }])("rejects wrong tempo state %j", after => {
    expect(checkEffect({ command: "set_tempo", args: { bpm: 93 } }, base, after).status).toBe("failed");
  });
  it("checks both native time signature fields", () => {
    expect(checkEffect({ command: "set_time_signature", args: { numerator: 3, denominator: 8 } }, base, { ...base, session: { ...base.session, timeSigNumerator: 3, timeSigDenominator: 4 } }).status).toBe("failed");
  });
  it("rejects a setter affecting the wrong track", () => {
    const before = { ...base, tracks: [...base.tracks, { id: "t2", volumeDb: 0, clips: [] }] };
    const after = { ...base, tracks: [...base.tracks, { id: "t2", volumeDb: -6, clips: [] }] };
    expect(checkEffect({ command: "set_track_volume", args: { trackId: "t1", db: -6 } }, before, after).status).toBe("failed");
  });
  it("rejects move when length changes as collateral damage", () => {
    expect(checkEffect({ command: "move_clip", args: { clipId: "c1", start: 8 } }, base, withClip({ ...clip, start: 8, length: 6 })).status).toBe("failed");
  });
  it("verifies trim start length and preserved offset", () => {
    expect(checkEffect({ command: "trim_clip", args: { clipId: "c1", length: 4 } }, base, withClip({ ...clip, length: 4 })).status).toBe("passed");
  });
  it("rejects note deletion that removes the wrong note", () => {
    const other = { i: 1, pitch: 64, start: 2, length: 1, velocity: 90 };
    expect(checkEffect({ command: "remove_note", args: { clipId: "c1", noteIndex: 0 } }, withClip({ ...clip, notes: [...clip.notes, other] }), base).status).toBe("failed");
  });
  it("rejects notes added at the wrong pitch", () => {
    expect(checkEffect({ command: "add_note", args: { clipId: "c1", pitch: 64, start: 2, length: 1, velocity: 90 } }, base, withClip({ ...clip, notes: [...clip.notes, { i: 1, pitch: 65, start: 2, length: 1, velocity: 90 }] })).status).toBe("failed");
  });
  it.each(["save", "open_plugin_editor", "undo", "redo", "unknown"])("keeps %s unverified from snapshots", command => {
    expect(checkEffect({ command, args: {} }, base, base).status).toBe("unverified");
  });
  it("does not equate an already satisfied setter with observed mutation", () => {
    expect(checkEffect({ command: "set_tempo", args: { bpm: 120 } }, base, base).status).toBe("unverified");
  });
});

describe("native effect state witnesses", () => {
  it.each<{ command: string; arg: string; field: string; prior: Json; value: Json }>([
    { command: "set_track_volume", arg: "db", field: "volumeDb", prior: 0, value: -6 },
    { command: "set_track_pan", arg: "pan", field: "pan", prior: 0, value: 0.25 },
    { command: "set_track_mute", arg: "mute", field: "mute", prior: false, value: true },
    { command: "set_track_solo", arg: "solo", field: "solo", prior: false, value: true },
    { command: "arm_track", arg: "armed", field: "armed", prior: false, value: true },
    { command: "set_input_monitor", arg: "mode", field: "monitor", prior: "off", value: "automatic" },
    { command: "rename_track", arg: "name", field: "name", prior: "Track", value: "Voice" },
  ])("observes the addressed $command field", ({ command, arg, field, prior, value }) => {
    const before = { ...base, tracks: [{ ...base.tracks[0], [field]: prior }] };
    const after = { ...base, tracks: [{ ...base.tracks[0], [field]: value }] };
    expect(checkEffect({ command, args: { trackId: "t1", [arg]: value } }, before, after).status).toBe("passed");
  });
  it.each<{ command: string; arg: string; field: string; prior: Json; value: Json }>([
    { command: "set_clip_gain", arg: "gainDb", field: "gainDb", prior: 0, value: -8 },
    { command: "set_clip_mute", arg: "mute", field: "mute", prior: false, value: true },
    { command: "rename_clip", arg: "name", field: "name", prior: "One", value: "Verse" },
    { command: "move_clip", arg: "start", field: "start", prior: 4, value: 8 },
  ])("observes the addressed $command clip field", ({ command, arg, field, prior, value }) => {
    expect(checkEffect({ command, args: { clipId: "c1", [arg]: value } }, withClip({ ...clip, [field]: prior }), withClip({ ...clip, [field]: value })).status).toBe("passed");
  });
  it("requires new MIDI clip content to match notes and timing", () => {
    const added = { ...clip, id: "c2", name: "MIDI", start: 0, length: 2, notes: [] };
    const after = { ...base, tracks: [{ ...base.tracks[0], clips: [clip, added] }] };
    expect(checkEffect({ command: "add_midi_clip", args: { trackId: "t1" } }, base, after).status).toBe("passed");
  });
  it("preserves the source when duplicating MIDI content at its end", () => {
    const after = { ...base, tracks: [{ ...base.tracks[0], clips: [clip, { ...clip, id: "c2", start: 12 }] }] };
    expect(checkEffect({ command: "duplicate_clip", args: { clipId: "c1" } }, base, after).status).toBe("passed");
  });
  it("checks exact surviving note content after deletion", () => {
    expect(checkEffect({ command: "remove_note", args: { clipId: "c1", noteIndex: 0 } }, base, withClip({ ...clip, notes: [] })).status).toBe("passed");
  });
  it("preserves both sides of an enclosing note when adding an overlapping note", () => {
    const before = withClip({ ...clip, notes: [{ ...clip.notes[0], length: 4 }] });
    const after = withClip({ ...clip, notes: [{ ...clip.notes[0], length: 1 }, { ...clip.notes[0], i: 1, start: 1, length: 1, velocity: 100 }, { ...clip.notes[0], i: 2, start: 2, length: 2 }] });
    expect(checkEffect({ command: "add_note", args: { clipId: "c1", pitch: 60, start: 1, length: 1, velocity: 100 } }, before, after).status).toBe("passed");
  });
  it("requires exactly one new track", () => {
    const after = { ...base, tracks: [...base.tracks, { id: "t2", name: "Voice", type: "audio", clips: [] }] };
    expect(checkEffect({ command: "create_track", args: { name: "Voice" } }, base, after).status).toBe("passed");
  });
  it("checks the addressed section range and preserves its name", () => {
    const section = { id: "s1", name: "Verse", startBeat: 0, endBeat: 16 };
    expect(checkEffect({ command: "move_section", args: { sectionId: "s1", startBeat: 16, endBeat: 32 } }, { ...base, sections: [section] }, { ...base, sections: [{ ...section, startBeat: 16, endBeat: 32 }] }).status).toBe("passed");
  });
  it("checks annotation text and beat instead of count alone", () => {
    expect(checkEffect({ command: "create_annotation", args: { text: "Cue", beat: 8 } }, { ...base, annotations: [] }, { ...base, annotations: [{ id: "a1", text: "Cue", beat: 4 }] }).status).toBe("failed");
  });
  it("checks both piece timing and source identity for a wave split", () => {
    const wave = { ...clip, type: "wave", sourceFile: "/source.wav" };
    const before = withClip(wave);
    const after = { ...base, tracks: [{ ...base.tracks[0], clips: [{ ...wave, length: 4 }, { ...wave, id: "c2", start: 8, length: 4, offset: 4 }] }] };
    expect(checkEffect({ command: "split_clip", args: { clipId: "c1", time: 8 } }, before, after).status).toBe("passed");
  });
  it("keeps absent native snapshot fields unverified", () => {
    expect(checkEffect({ command: "set_master_volume", args: { db: -6 } }, base, { ...base, master: { volumeDb: -6 } }).status).toBe("unverified");
  });
});

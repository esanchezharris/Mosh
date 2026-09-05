import { describe, expect, it } from "vitest";
import { remapProgramTrackIds, templateRoleMap } from "./produceReplayRemap";

// Round 3 (2026-09-02) regression: the replay driver assumed "track/clip ids
// are stable (deterministic prefix)" and replayed the ORIGINAL run's trackIds
// verbatim. The round-3 preflight inserted a highpass per synth track, which
// shifted every later id by one (1025→1026, 1030→1032, …); five of seven
// melodic parts landed on auto-created "Track N" tracks with a default 4OSC
// sine at 0 dB — the owner's "presets sound like naked sine waves".
const oldTemplate = {
  drums: { trackId: "1010" },
  bass: { trackId: "1015" },
  synths: [
    { role: "lead", trackId: "1020" },
    { role: "chords_pad", trackId: "1025" },
    { role: "drone", trackId: "1030" },
    { role: "stab", trackId: "1035" },
  ],
};
const newTemplate = {
  drums: { trackId: "1010" },
  bass: { trackId: "1015" },
  synths: [
    { role: "lead", trackId: "1020" },
    { role: "chords_pad", trackId: "1026" },
    { role: "drone", trackId: "1032" },
    { role: "stab", trackId: "1038" },
  ],
};

describe("templateRoleMap", () => {
  it("maps drums/808/synth roles to their track ids", () => {
    expect(templateRoleMap(oldTemplate)).toEqual({
      drums: "1010", "808": "1015", lead: "1020", chords_pad: "1025", drone: "1030", stab: "1035",
    });
  });
});

describe("remapProgramTrackIds", () => {
  const lines = [
    { command: "add_midi_clip", args: { trackId: "1010", start: 0, notes: [] } },
    { command: "add_midi_clip", args: { trackId: "1025", start: 0, notes: [] } },
    { command: "add_midi_clip", args: { trackId: "1035", start: 0, notes: [] } },
    { command: "set_note", args: { trackId: "1030", index: 2, pitch: 50 } },
  ];

  it("rewrites every trackId by ROLE from the original template to the replay template", () => {
    const { lines: out, remapped } = remapProgramTrackIds(lines, oldTemplate, newTemplate);
    expect(out.map((l) => l.args?.trackId)).toEqual(["1010", "1026", "1038", "1032"]);
    expect(remapped).toEqual({ "1025": "1026", "1035": "1038", "1030": "1032" });
    // untouched fields survive
    expect(out[3]!.args).toMatchObject({ index: 2, pitch: 50 });
    // input is not mutated
    expect(lines[1]!.args!.trackId).toBe("1025");
  });

  it("is the identity when the templates agree", () => {
    const { lines: out, remapped } = remapProgramTrackIds(lines, oldTemplate, oldTemplate);
    expect(out).toEqual(lines);
    expect(remapped).toEqual({});
  });

  it("throws on a trackId the original template does not know (never silently auto-creates a track)", () => {
    const stray = [{ command: "add_midi_clip", args: { trackId: "1099", notes: [] } }];
    expect(() => remapProgramTrackIds(stray, oldTemplate, newTemplate)).toThrow(/1099/);
  });

  it("throws when the replay template lacks a role the program uses", () => {
    const noStab = { ...newTemplate, synths: newTemplate.synths.filter((s) => s.role !== "stab") };
    expect(() => remapProgramTrackIds(lines, oldTemplate, noStab)).toThrow(/stab/);
  });
});

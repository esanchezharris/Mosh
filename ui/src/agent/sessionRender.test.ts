import { describe, it, expect } from "vitest";
import { renderSession } from "./sessionRender";
import type { Snapshot } from "../types";

// The master chain is the one place the prompt names a plugin the model may then
// have to reference in a command. Which string it shows is therefore a contract,
// not cosmetics: load_master_builtin/load_builtin take the builtin's `type` id,
// and the engine's table (MoshOps.cpp kBuiltins) makes type and display name
// deliberately different — "compressor"/"Compressor", "4bandEq"/"4-Band EQ".
//
// Measured 2026-07-28 (docs/agent-bench/REPORT_2026-07-28-session-render.md):
// with the chain rendered as display names, master-eq-before-comp emitted
// `unknown builtin: EQ` in 13 of 13 reps.
const withMasterPlugins = (plugins: unknown[]): Snapshot => ({
  schemaVersion: 1,
  session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
  tracks: [],
  transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  master: { volumeDb: -3, pan: 0, plugins },
} as unknown as Snapshot);

const chainOf = (s: Snapshot): string =>
  renderSession(s).split("\n").find((l) => l.startsWith("master:"))!;

describe("renderSession — master chain names builtins by the id commands take", () => {
  it("renders a builtin by its `type`, not its display name", () => {
    const s = withMasterPlugins([{ index: 0, name: "Compressor", type: "compressor", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[compressor]");
    // the display name must NOT appear — it is the string the engine rejects
    expect(chainOf(s)).not.toContain("Compressor");
  });

  it("renders the EQ builtin as 4bandEq — the case no amount of re-casing reaches", () => {
    // "4-Band EQ" -> "4bandEq" is not a casing difference. A model copying the
    // display name cannot recover by lowercasing it.
    const s = withMasterPlugins([{ index: 0, name: "4-Band EQ", type: "4bandEq", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[4bandEq]");
  });

  it("keeps an EXTERNAL plugin's display name (its `type` is only a format label)", () => {
    // te::ExternalPlugin::getPluginType() returns "vst" — rendering that would
    // make every third-party plugin indistinguishable from every other.
    const s = withMasterPlugins([{ index: 0, name: "Pro-Q 3", type: "vst", builtin: false, external: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[Pro-Q 3]");
  });

  it("mixes builtins and externals in chain order", () => {
    const s = withMasterPlugins([
      { index: 0, name: "4-Band EQ", type: "4bandEq", builtin: true, enabled: true },
      { index: 1, name: "Pro-Q 3", type: "vst", builtin: false, external: true, enabled: true },
      { index: 2, name: "Compressor", type: "compressor", builtin: true, enabled: true },
    ]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[4bandEq, Pro-Q 3, compressor]");
  });

  it("falls back to the name when a plugin carries no type (defensive, not a real snapshot)", () => {
    const s = withMasterPlugins([{ index: 0, name: "Mystery", builtin: true, enabled: true }]);
    expect(chainOf(s)).toBe("master: -3dB pan 0 chain:[Mystery]");
  });

  it("still says empty for a bare master", () => {
    expect(chainOf(withMasterPlugins([]))).toBe("master: -3dB pan 0 chain:[empty]");
  });
});

// W2.1 (produce lane) — the sampler's loaded pads, so the model can see the real
// lane map (and the 808's keyNote) instead of guessing MoshOps pad numbers.
describe("renderSession — drum pads and the melodic (808) pad", () => {
  const withDrumTrack = (drumPads: unknown[]): Snapshot => ({
    schemaVersion: 1,
    session: { sampleRate: 48000, tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4, metronome: false, length: 16, editFile: "" },
    tracks: [
      { id: "9", index: 0, name: "Drums", type: "drum", volumeDb: 0, mute: false, solo: false, clips: [], drumPads },
    ],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
  } as unknown as Snapshot);

  const trackLineOf = (s: Snapshot): string =>
    renderSession(s).split("\n").find((l) => l.trim().startsWith('"9"'))!;

  it("a track with no drumPads renders byte-identically to the pre-2026-09 shape (no pads/808 segment)", () => {
    const s = withDrumTrack([]);
    expect(trackLineOf(s)).toBe('  "9" "Drums" [drum] 0dB clips:[]');
  });

  it("one-shot pads render as `pitch:name`, sorted by pitch", () => {
    const s = withDrumTrack([
      { index: 1, pitch: 38, minNote: 38, maxNote: 38, name: "snare", file: "/a.wav", gainDb: 0, pan: 0, openEnded: true },
      { index: 0, pitch: 36, minNote: 36, maxNote: 36, name: "kick", file: "/b.wav", gainDb: 0, pan: 0, openEnded: true },
    ]);
    expect(trackLineOf(s)).toContain("pads:[36:kick 38:snare]");
  });

  it("a pad spanning the whole keyboard (minNote 0..maxNote 127 — melodic mode) renders as 808:root<pitch> instead of a pad entry", () => {
    const s = withDrumTrack([
      { index: 0, pitch: 60, minNote: 0, maxNote: 127, name: "808", file: "/808.wav", gainDb: 0, pan: 0, openEnded: true },
    ]);
    const line = trackLineOf(s);
    expect(line).toContain("808:root60");
    expect(line).not.toContain("pads:["); // the melodic pad is not a drum lane
  });

  it("one-shot pads AND the melodic 808 pad can coexist on the same track", () => {
    const s = withDrumTrack([
      { index: 0, pitch: 36, minNote: 36, maxNote: 36, name: "kick", file: "/kick.wav", gainDb: 0, pan: 0, openEnded: true },
      { index: 1, pitch: 62, minNote: 0, maxNote: 127, name: "808", file: "/808.wav", gainDb: 0, pan: 0, openEnded: true },
    ]);
    const line = trackLineOf(s);
    expect(line).toContain("pads:[36:kick]");
    expect(line).toContain("808:root62");
  });
});

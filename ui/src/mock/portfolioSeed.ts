// ?mockSeed=portfolio — the Song A showcase session for the dev/e2e mock.
//
// The owner's own song (the "greg" project, 145 BPM, 56 bars) as a real producer would have
// it in Mosh: the beat and three vocal stems cut into clips where the audio actually
// starts and stops (cuts come from scripts/portfolio/song_a_peaks.py's per-bar loudness
// map), a drum-grid track and an 808 line so every clip renderer is exercised, chains on
// the vocals, two return buses with sends, and sections over the ruler. Wave clips point at
// "/fixture/<stem>" so get_clip_peaks draws the stems' REAL envelopes (mock/fixturePeaks.ts).
//
// Dev/e2e only. The 3-track default seed stays the boot session for every other lane.
import type { Clip, MidiNote, Plugin, Send, Snapshot, Track } from "../types";
import { builtinPlugin } from "./builtins";
import { FIXTURE_PREFIX, fixtureStemDuration } from "./fixturePeaks";

export const PORTFOLIO_BPM = 145;
export const PORTFOLIO_BARS = 56;
/** Seconds per bar at 145 BPM, 4/4. */
export const PORTFOLIO_BAR_SEC = 240 / PORTFOLIO_BPM;

/** Start of a 1-based bar, in session seconds. */
export function barStartSec(bar: number): number {
  return (bar - 1) * PORTFOLIO_BAR_SEC;
}
/** The span of bars `from`..`to` (inclusive, 1-based), in session seconds. */
export function barSpan(from: number, to: number): { start: number; length: number } {
  return { start: barStartSec(from), length: (to - from + 1) * PORTFOLIO_BAR_SEC };
}

let seq = 0;
const id = (kind: string) => `pf-${kind}-${++seq}`;

function wave(name: string, stem: string, fromBar: number, toBar: number): Clip {
  const { start, length } = barSpan(fromBar, toBar);
  return {
    id: id("clip"), name, type: "wave", start, length,
    offset: start,                       // the stems are aligned at 0, so a clip's offset is its start
    sourceFile: `${FIXTURE_PREFIX}${stem}`, sourceLength: fixtureStemDuration(stem),
    hasRenderLayer: false, fadeInSec: 0, fadeOutSec: 0, fadeInType: 1, fadeOutType: 1,
    reversed: false, autoCrossfade: false,
  };
}

function midi(name: string, fromBar: number, toBar: number, notes: MidiNote[]): Clip {
  const { start, length } = barSpan(fromBar, toBar);
  return { id: id("clip"), name, type: "midi", start, length, offset: 0, hasRenderLayer: false, notes };
}

/** A 145-BPM trap kit: kick on 1 / the and-of-2 / the a-of-3, snare on 2 and 4, 8th hats
 *  with a 16th roll into every other bar. GM pitches 36/38/42 so the V3 drum lanes map them. */
export function drumPattern(bars: number): MidiNote[] {
  const notes: MidiNote[] = [];
  let i = 0;
  const hit = (pitch: number, start: number, length: number, velocity: number) => { notes.push({ i: i++, pitch, start, length, velocity }); };
  for (let bar = 0; bar < bars; bar++) {
    const b = bar * 4;
    const fill = bar % 4 === 3;
    hit(36, b, 0.25, 118);
    hit(36, b + 1.5, 0.25, 98);
    hit(36, b + (fill ? 2.5 : 2.75), 0.25, 106);
    if (fill) hit(36, b + 3.25, 0.25, 92);
    hit(38, b + 1, 0.25, 112);
    hit(38, b + 3, 0.25, 112);
    for (let h = 0; h < 7; h++) hit(42, b + h * 0.5, 0.2, h % 2 === 0 ? 76 : 62);
    if (bar % 2 === 1) for (let r = 0; r < 4; r++) hit(42, b + 3.5 + r * 0.25, 0.12, 58 + r * 8);   // 16th roll into the next bar
    else hit(42, b + 3.5, 0.2, 62);
  }
  return notes;
}

/** An A-minor 808 line: four-bar phrase, long roots with a slide note before the change.
 *  Pitches stay under the GM drum range so the lane draws note blocks, not a drum grid. */
export function bassLine(bars: number): MidiNote[] {
  const A1 = 33, G1 = 31, F1 = 29, E1 = 28, D1 = 26;
  const phrase: [number, number, number, number][] = [   // [pitch, startBeat, lengthBeats, velocity] per 4-bar phrase
    [A1, 0, 1.5, 116], [A1, 2.5, 0.5, 96], [G1, 3, 1, 104],
    [F1, 4, 2, 112], [E1, 6.5, 0.5, 92], [A1, 7, 1, 104],
    [A1, 8, 1.5, 116], [A1, 10.5, 0.5, 96], [G1, 11, 1, 104],
    [D1, 12, 1, 108], [E1, 13, 1, 104], [F1, 14, 1, 108], [G1, 15, 1, 112],
  ];
  const notes: MidiNote[] = [];
  let i = 0;
  for (let bar = 0; bar < bars; bar += 4) {
    for (const [pitch, start, length, velocity] of phrase) {
      if (bar + start / 4 >= bars) continue;
      notes.push({ i: i++, pitch, start: bar * 4 + start, length, velocity });
    }
  }
  return notes;
}

const send = (bus: number, db: number): Send => ({ bus, db, mute: false, pan: 0, preFader: false });
const chain = (...types: string[]): Plugin[] => types.map((t, index) => {
  const p = builtinPlugin(t, index);
  if (!p) throw new Error(`portfolio seed: unknown builtin ${t}`);
  return p;
});

const REVERB_BUS = 0;
const DELAY_BUS = 1;

export function portfolioTracks(): Track[] {
  seq = 0;
  const base = { volumeDb: 0, pan: 0, mute: false, solo: false };
  return [
    { id: "pf-beat", index: 0, name: "Beat", type: "audio", ...base, volumeDb: -2,
      clips: [wave("intro", "beat", 1, 3), wave("Gtr A", "beat", 4, 24), wave("break", "beat", 25, 27),
        wave("beat B", "beat", 28, 48), wave("break", "beat", 49, 51), wave("outro", "beat", 52, 56)],
      plugins: chain("4bandEq") },
    { id: "pf-drums", index: 1, name: "Drums", type: "drum", ...base, volumeDb: -4, isInstrument: true,
      clips: [midi("drums", 4, 24, drumPattern(21)), midi("drums", 28, 48, drumPattern(21))],
      plugins: chain("sampler", "softclip") },
    { id: "pf-808", index: 2, name: "808", type: "audio", ...base, volumeDb: -3, isInstrument: true,
      clips: [midi("808", 4, 24, bassLine(21)), midi("808", 28, 48, bassLine(21))],
      plugins: chain("4osc", "softclip") },
    { id: "pf-lead", index: 3, name: "Lead", type: "audio", ...base, volumeDb: -1.5,
      clips: [wave("verse 1", "lead", 4, 11), wave("hook", "lead", 12, 19), wave("verse 2", "lead", 20, 24),
        wave("verse 3", "lead", 27, 40), wave("hook 2", "lead", 41, 48), wave("outro", "lead", 49, 53)],
      plugins: chain("moshAutoTune", "compressor", "4bandEq"),
      sends: [send(REVERB_BUS, -12), send(DELAY_BUS, -18)] },
    { id: "pf-double", index: 4, name: "Double", type: "audio", ...base, volumeDb: -6, pan: -0.12,
      clips: [wave("dbl v1", "double", 5, 18), wave("dbl", "double", 25, 29), wave("dbl hook", "double", 41, 53)],
      plugins: chain("compressor", "4bandEq"),
      sends: [send(REVERB_BUS, -15), send(DELAY_BUS, -24)] },
    { id: "pf-bgv", index: 5, name: "Backgrounds", type: "audio", ...base, volumeDb: -9, pan: 0.18,
      clips: [wave("bgv", "background", 12, 16)],
      plugins: chain("compressor"),
      sends: [send(REVERB_BUS, -9)] },
    { id: "pf-ref", index: 6, name: "Ref", type: "audio", ...base, volumeDb: -12, mute: true,
      clips: [wave("greg rough", "rough", 1, PORTFOLIO_BARS)], plugins: [] },
    // Return tracks — the same shape create_bus builds; the arrangement filters them out of
    // the rows and the inspector's Sends section lists them by bus.
    { id: "pf-bus-reverb", index: 7, name: "Reverb", type: "audio", ...base, volumeDb: -6,
      clips: [], plugins: chain("reverb"), isReturn: true, returnBus: REVERB_BUS },
    { id: "pf-bus-delay", index: 8, name: "Delay", type: "audio", ...base, volumeDb: -8,
      clips: [], plugins: chain("delay"), isReturn: true, returnBus: DELAY_BUS },
  ];
}

const bar = (n: number) => (n - 1) * 4;   // 1-based bar → beat
export const PORTFOLIO_SECTIONS: Snapshot["sections"] = [
  { id: "pf-sec-intro", name: "Intro", startBeat: bar(1), endBeat: bar(4), color: "#9fe1cb" },
  { id: "pf-sec-v1", name: "Verse 1", startBeat: bar(4), endBeat: bar(12), color: "#b5d4f4" },
  { id: "pf-sec-hook", name: "Hook", startBeat: bar(12), endBeat: bar(20), color: "#f4c0d1" },
  { id: "pf-sec-v2", name: "Verse 2", startBeat: bar(20), endBeat: bar(28), color: "#b5d4f4" },
  { id: "pf-sec-v3", name: "Verse 3", startBeat: bar(28), endBeat: bar(41), color: "#b5d4f4" },
  { id: "pf-sec-hook2", name: "Hook 2", startBeat: bar(41), endBeat: bar(49), color: "#f4c0d1" },
  { id: "pf-sec-outro", name: "Outro", startBeat: bar(49), endBeat: bar(57), color: "#ffd166" },
];

/** The showcase session, built on top of the default seed's session scaffolding (click,
 *  record options, device fields) so the two never drift on anything the UI reads. */
export function portfolioSeed(base: Snapshot): Snapshot {
  const tracks = portfolioTracks();
  const returns = tracks.filter((t) => t.isReturn);
  return {
    ...base,
    session: {
      ...base.session,
      tempo: PORTFOLIO_BPM,
      tempoMap: [{ time: 0, bpm: PORTFOLIO_BPM, curve: 1 }],
      timeSigNumerator: 4, timeSigDenominator: 4,
      length: fixtureStemDuration("beat"),
      editFile: "/mock/greg.mosh",
      key: { tonic: "A", mode: "minor" },
      countInBars: 1,
    },
    tracks,
    buses: returns.map((t) => ({ bus: t.returnBus!, name: t.name, trackId: t.id })),
    sections: PORTFOLIO_SECTIONS,
    annotations: [],
    transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 },
    master: { volumeDb: 0, pan: 0, plugins: [] },
  };
}

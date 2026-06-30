// ── Genre beat specs for the structured beat-build loop ───────────────────────
// Each spec decomposes a genre into deterministic structure (tracks/instruments) plus
// the model-filled slots (note patterns). The `fallback` on each slot is the forced,
// non-silent floor — a plain but genre-correct pattern applied only when the model
// can't produce ≥minNotes valid notes. Fallbacks mirror the dev-mock's drumPattern/
// bassLine so the "no model" baseline is a recognisable beat, not noise.

import type { BeatSpec, BeatContext, Note, Slot } from "./beatBuilder";

const KICK = 36, SNARE = 38, CHAT = 42; // GM drum pads

const SEMITONE: Record<string, number> = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6,
  Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** MIDI for a tonic at an octave (C4 = 60). */
function tonicMidi(tonic: string, octave: number): number {
  return 12 * (octave + 1) + (SEMITONE[tonic] ?? 9);
}
function scaleOf(mode: string): number[] {
  return mode.toLowerCase().startsWith("maj") ? MAJOR : MINOR;
}
/** Pitch for a scale degree (degrees can exceed the octave; wraps with +12). */
function degreePitch(ctx: BeatContext, octave: number, degree: number): number {
  const sc = scaleOf(ctx.spec.key.mode);
  const oct = Math.floor(degree / sc.length);
  const idx = ((degree % sc.length) + sc.length) % sc.length;
  return tonicMidi(ctx.spec.key.tonic, octave) + 12 * oct + sc[idx];
}

// ── deterministic fallback pattern builders (per bar, summed across bars) ──────

function perBar(ctx: BeatContext, make: (barBeat: number, bar: number) => Note[]): Note[] {
  const out: Note[] = [];
  for (let bar = 0; bar < ctx.spec.bars; bar++) out.push(...make(bar * 4, bar));
  return out;
}

const kickFallback = (ctx: BeatContext): Note[] =>
  perBar(ctx, (b) => [0, 0.75, 2.5, 3].map((o) => ({ pitch: KICK, start: b + o, length: 0.25, velocity: 112 })));
const fourFloorKick = (ctx: BeatContext): Note[] =>
  perBar(ctx, (b) => [0, 1, 2, 3].map((o) => ({ pitch: KICK, start: b + o, length: 0.25, velocity: 110 })));
const snareFallback = (ctx: BeatContext): Note[] =>
  perBar(ctx, (b) => [1, 3].map((o) => ({ pitch: SNARE, start: b + o, length: 0.25, velocity: 104 })));
const hatsEighths = (ctx: BeatContext): Note[] =>
  perBar(ctx, (b) => Array.from({ length: 8 }, (_, h) => ({ pitch: CHAT, start: b + h * 0.5, length: 0.2, velocity: 72 })));
const hatsTrap = (ctx: BeatContext): Note[] =>
  perBar(ctx, (b) => {
    const ns: Note[] = Array.from({ length: 8 }, (_, h) => ({ pitch: CHAT, start: b + h * 0.5, length: 0.18, velocity: 70 }));
    // a 16th-note roll on beat 4 (the trap signature)
    for (const o of [3.25, 3.5, 3.75]) ns.push({ pitch: CHAT, start: b + o, length: 0.12, velocity: 60 });
    return ns;
  });
// root motion i–i–iv–v in the low octave, kick-aligned
const bassFallback = (octave: number) => (ctx: BeatContext): Note[] =>
  perBar(ctx, (b, bar) => {
    const deg = [0, 0, 3, 4][bar % 4];
    const p = degreePitch(ctx, octave, deg);
    return [
      { pitch: p, start: b, length: 1.5, velocity: 102 },
      { pitch: p, start: b + 2, length: 1, velocity: 90 },
    ];
  });
// a simple 4-note motif from the scale
const melodyFallback = (octave: number) => (ctx: BeatContext): Note[] =>
  perBar(ctx, (b, bar) => {
    const degs = bar % 2 === 0 ? [0, 2, 4, 2] : [4, 2, 0, -3];
    return degs.map((d, i) => ({ pitch: degreePitch(ctx, octave, d), start: b + i, length: 0.9, velocity: 88 }));
  });

// ── slot factories ─────────────────────────────────────────────────────────────

const drumSlot = (id: string, label: string, pitch: number, minNotes: number, hint: string, fallback: (c: BeatContext) => Note[]): Slot =>
  ({ id, label, role: "drum", fixedPitch: pitch, pitchRange: [pitch, pitch], minNotes, promptHint: hint, fallback });
const melodicSlot = (id: string, label: string, range: [number, number], minNotes: number, hint: string, fallback: (c: BeatContext) => Note[]): Slot =>
  ({ id, label, role: "melodic", pitchRange: range, minNotes, promptHint: hint, fallback });

// ── the genre presets ───────────────────────────────────────────────────────

export const BEAT_SPECS: BeatSpec[] = [
  {
    id: "dark_trap",
    genre: "dark trap",
    tempo: 140, tempoRange: [130, 160],
    key: { tonic: "F", mode: "minor" },
    bars: 2,
    tracks: [
      { name: "Drums", kind: "drum", gainDb: -3, slots: [
        drumSlot("kick", "kick pattern", KICK, 4, "Syncopated trap kick — a few hits per bar, leave space, land on the downbeat.", kickFallback),
        drumSlot("snare", "snare/clap backbeat", SNARE, 2, "Snare on the backbeat (beats 2 and 4 of each bar).", snareFallback),
        drumSlot("hats", "hi-hat pattern", CHAT, 8, "Busy trap hats — mostly 8ths with a 16th-note roll; vary velocity for groove.", hatsTrap),
      ] },
      { name: "808", kind: "audio", gainDb: -5, slots: [
        melodicSlot("bass", "808 bassline", [29, 48], 4, "Deep 808 sub line that follows the kick; mostly the root with occasional movement; stay low.", bassFallback(1)),
      ] },
      { name: "Lead", kind: "audio", gainDb: -9, slots: [
        melodicSlot("melody", "dark lead melody", [60, 84], 6, "A dark, sparse minor-key lead motif that repeats and develops.", melodyFallback(4)),
      ] },
    ],
  },
  {
    id: "lofi",
    genre: "lofi hip-hop",
    tempo: 82, tempoRange: [72, 92],
    key: { tonic: "C", mode: "major" },
    bars: 2,
    tracks: [
      { name: "Drums", kind: "drum", gainDb: -3, slots: [
        drumSlot("kick", "kick pattern", KICK, 3, "Laid-back boom-bap kick — beat 1 and a syncopated second hit per bar.", kickFallback),
        drumSlot("snare", "snare backbeat", SNARE, 2, "Snare on beats 2 and 4, slightly soft.", snareFallback),
        drumSlot("hats", "hi-hat pattern", CHAT, 6, "Relaxed 8th-note hats, gentle velocities.", hatsEighths),
      ] },
      { name: "Bass", kind: "audio", gainDb: -5, slots: [
        melodicSlot("bass", "warm bassline", [33, 50], 3, "Warm, simple upright-style bass that walks between chord roots.", bassFallback(2)),
      ] },
      { name: "Keys", kind: "audio", gainDb: -9, slots: [
        melodicSlot("melody", "jazzy keys melody", [60, 84], 5, "Soft jazzy chord-tone melody, a little syncopation, leave space.", melodyFallback(4)),
      ] },
    ],
  },
  {
    id: "boombap",
    genre: "90s boom-bap",
    tempo: 92, tempoRange: [86, 100],
    key: { tonic: "A", mode: "minor" },
    bars: 2,
    tracks: [
      { name: "Drums", kind: "drum", gainDb: -3, slots: [
        drumSlot("kick", "punchy kick", KICK, 3, "Classic boom-bap kick — punchy beat 1 plus a syncopated pickup.", fourFloorKick),
        drumSlot("snare", "hard snare backbeat", SNARE, 2, "Hard snare on 2 and 4.", snareFallback),
        drumSlot("hats", "hi-hat pattern", CHAT, 6, "Steady 8th-note hats with swing-feel velocity accents.", hatsEighths),
      ] },
      { name: "Bass", kind: "audio", gainDb: -5, slots: [
        melodicSlot("bass", "groovy bassline", [33, 50], 4, "A groovy bassline that locks with the kick and outlines a minor progression.", bassFallback(2)),
      ] },
      { name: "Sample", kind: "audio", gainDb: -9, slots: [
        melodicSlot("melody", "soulful chord melody", [60, 84], 5, "A soulful, slightly nostalgic minor melody motif.", melodyFallback(4)),
      ] },
    ],
  },
];

export const beatSpecById = (id: string): BeatSpec | undefined => BEAT_SPECS.find((s) => s.id === id);

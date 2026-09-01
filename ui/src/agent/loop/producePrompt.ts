// PRODUCE LANE (P1, flag `produceLane`, default OFF) — the full-production
// counterpart to the DOSAGE assistant lane. The genre rules are PROMPT-trap-v4
// from the AbletonMONSTER flywheel lab (the only prompt lineage that has ever
// produced owner-keeper beats: v3 = the 2026-03-19 breakthrough commits 94eeb18 +
// dfdc535; v4 = the 2026-09-01 correction r1 lessons — sustained stabs, clap-layer
// variation), translated into MoshOps idioms: add_drum_pattern lane-maps, batched
// add_note, list_presets/load_preset, generate_beat_recipe.
//
// Rule provenance is tracked in ~/AbletonMONSTER/PROMPT-trap-v4.md — change rules
// THERE first (with a correction meta.json behind the change), then mirror here.
// Do not invent rules in this file: taste rules come from correction rounds only.

import type { Snapshot } from "../../types";
import { buildLoopSystemPrompt } from "./loopPrompt";

// Deliberately EXPLICIT triggers — an ordinary "make me a beat" stays on the
// bounded assistant lane; produce mode is asked for by name (or by asking for a
// full/whole/complete beat or production pass).
const PRODUCE_ASK =
  /\bproduce\b|\bproduction pass\b|\bfull (?:beat|track|arrangement|production)\b|\bwhole beat\b|\bcomplete beat\b/i;

export function isProduceAsk(text: string): boolean {
  return PRODUCE_ASK.test(text);
}

export const PRODUCE_BUDGETS = {
  maxSteps: 24,
  maxPlannerCalls: 6,
  maxStepCalls: 24,
  softWallMs: 480_000,
} as const;

export const PRODUCE_RULES = [
  "PRODUCE MODE — this ask IS an invitation to a full production pass; the DOSAGE rule above is suspended for structure-building (still: never repeat an identical command, never duplicate a track/section one already covers).",
  "The bar: a beat the producer would keep — 8-12 tracks with notes, two contrasting sections, real sounds on every track. A 1-bar 3-lane sketch is a FAILURE in this mode.",
  "FOUNDATION FIRST: if generate_beat_recipe is available, call it ONCE early (pick mood/tempo/key from the ask) — it lays real curated sounds and grooves — then EXTEND and refine it track by track. Without it, compose from scratch per the rules below.",
  "SOUNDS BEFORE JUDGING: every melodic track gets a preset — list_presets once, then load_preset per instrument track. A default init patch is a placeholder, never a finished sound.",
  "STRUCTURE: set_tempo (jerk/trap default 140-150), set_key, then TWO contrasting sections (A and B) with different 808 patterns AND, when two bass sounds exist, different 808 sounds. Change the chord progression between sections.",
  "TRACK NAMES describe musical function ('Sustained Counter', 'Chord Stabs', 'Drone Pad') — never 'Track 3'.",
  "808/BASS RULES (critical): pitches MIDI 62-70 only (D3-Bb3 in note names) — never sub-bass octaves. Every note SUSTAINS to the next one: length = the gap, zero silence between notes. Rhythmic bounce: prefer off-beat starts; avoid landing every note on the backbeat. The 808 line IS the chord progression.",
  "DRUMS (critical — dense): use add_drum_pattern lane-maps, 16 steps/bar. Snare on step 1 (the '1') = jerk style. Kick 4-8/bar with off-beats, never just 1 and 3. Hats fill the bar (8-16/bar) with accent variation ('x' vs 'X'). Snare+clap layered; keep the LAYER clap quieter and VARY it (an extra softer hit every other bar) — never double every backbeat at equal level. Never leave a bar with <6 total hits.",
  "Worked 1-bar jerk shape (from the reference beat) — extend, don't copy verbatim:",
  '  add_drum_pattern lanes: "kick: X.x..x....x...x.; snare: X......xX..x....; clap: ....x.......x...; hat: X.x.x.x.X.x.xxx.; openhat: ..x.......x....."',
  "SYNTHS: at least lead + chords + one counter/stab role. Stab/counter parts SUSTAIN — hold notes an eighth to a dotted half, phrased as short single-note motifs with real breaks; NEVER chains of 1-step staccato chords. Chords are polyphonic (batched add_note with simultaneous starts). Use the FULL velocity range 40-127: ghosts 40-65, accents 115-127 — never everything at one velocity.",
  "808 batched add_note shape (A-section, D minor, MIDI 62-70, sustained):",
  '  {"clipId":"<id>","notes":[{"pitch":62,"start":0,"length":1.5,"velocity":95},{"pitch":62,"start":1.5,"length":1,"velocity":85},{"pitch":69,"start":2.5,"length":1.5,"velocity":88},{"pitch":70,"start":4.5,"length":2,"velocity":92}]}',
  "ANTI-PATTERNS: empty tracks; an 808 with 1-2 pitch values; everything velocity 100; a missing B section; melodies stuck in a 2-note range; drum bars under 6 hits; gaps of silence between 808 notes.",
  "Work section by section, verify each step's results, and stop with status 'done' only when the full A/B arrangement stands.",
].join("\n");

/** The produce-lane system prompt = the ordinary loop prompt + the genre rules.
 *  Reuses buildLoopSystemPrompt wholesale so catalog/knowledge/memory/session
 *  behavior stays identical — produce adds rules, it never forks the base. */
export function buildProduceSystemPrompt(snap: Snapshot | null, query?: string, memory?: string): string {
  return [buildLoopSystemPrompt(snap, query, memory), PRODUCE_RULES].join("\n");
}

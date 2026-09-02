// PRODUCE LANE v2 (P1, flag `produceLane`, default OFF) — the full-production
// counterpart to the DOSAGE assistant lane.
//
// v1 (shipped, PROMPT-trap-v4 lineage) asked the model to build the WHOLE session
// itself: create_track, load_preset, generate_beat_recipe, add_drum_pattern. The
// 2026-09-02 overnight run found the real blocker wasn't taste, it was mechanics —
// the loop model never sees a command's RESULT data (`StepCommandResult` is
// {command, ok, error}, ui/src/agent/loopSeam.ts:20-24), so it cannot learn a
// trackId, a chosen preset name, or a sample's pitch from anything it just did.
// v2 inverts the division of labor: a deterministic PREFLIGHT
// (produceTemplate.ts's runProduceTemplate) builds the whole session — tracks,
// real Vital presets, the sustained 808 sample assigned at its keyNote — BEFORE
// the model's first turn, and renders the result into the prompt
// (renderProduceTemplate). The model's job shrinks to exactly what a model is
// good at: writing NOTES onto tracks that already sound like something.
//
// Rule provenance: every TASTE rule below (register, sustain, clap variation,
// stab phrasing) carries a `// lesson: produce-corrections/<id> note <N>` comment
// naming the correction round it came from (docs/produce-corrections/<id>.meta.json)
// — never invented here. A rule with no lesson tag is MECHANICAL (a command shape,
// a budget, a JSON contract), cited to its design fact instead. See
// docs/produce-corrections/README.md for the correction → promotion workflow.
// producePrompt.test.ts's lesson-tag test fails if a tag's correction file is missing.

import type { Snapshot } from "../../types";
import { buildLoopSystemPrompt } from "./loopPrompt";
import { SYNTH_ROLE_LABEL, type ProduceTemplate } from "./produceTemplate";

// Deliberately EXPLICIT triggers — an ordinary "make me a beat" stays on the
// bounded assistant lane; produce mode is asked for by name (or by asking for a
// full/whole/complete beat or production pass).
const PRODUCE_ASK =
  /\bproduce\b|\bproduction pass\b|\bfull (?:beat|track|arrangement|production)\b|\bwhole beat\b|\bcomplete beat\b/i;

export function isProduceAsk(text: string): boolean {
  return PRODUCE_ASK.test(text);
}

/** Bumped whenever PRODUCE_RULES changes; a promoted correction bumps it too
 *  (docs/produce-corrections/README.md's promotion workflow, step 2). */
export const PRODUCE_VERSION = 2;

export const PRODUCE_BUDGETS = {
  maxSteps: 24,
  maxPlannerCalls: 8,
  maxStepCalls: 24,
  softWallMs: 900_000,
} as const;

export const PRODUCE_RULES = [
  "PRODUCE MODE v2 — the session below is a REQUIRED TRACKS template someone already built for you: every track exists, every drum pad is a real sample, every synth already has a real Vital sound loaded, the sustained 808 sample is already assigned. Your ENTIRE job this pass is writing NOTES onto that template — you never build it.",

  // ── template-is-laid prohibition (mechanical — the preflight already ran) ────
  "TEMPLATE IS LAID: never call create_track, load_plugin, load_preset, assign_sample, set_drum_pad, or generate_beat_recipe — every one of them already ran before your first turn and calling them again duplicates or corrupts a track that's already correct. Never call list_presets or list_plugins either — the REQUIRED TRACKS list below already names every preset that loaded. Your only commands are add_midi_clip (once per track) and add_note/set_note (to fill it).",

  // ── octave convention (mechanical — MoshOps.Clips.cpp's note units + the
  // melodic-sample transposition math in produceTemplate.ts) ───────────────────
  "OCTAVE CONVENTION: pitches are MIDI, C4 = 60 (NOT 0-11 pitch classes). Registers by role — 808/bass: 62-70 ONLY (D3-Bb3 in note names) regardless of which sample's root note the template picked; lead/counter/stab: 72-84; chords/pad: 57-72; drone: 50-57; ambient: 84-96. A pitch outside a track's register reads as a mistake, not a stylistic choice.",

  // ── 808 rules — correction gen001-808-register (2026-03-19, the flywheel
  // breakthrough) is the whole reason this register/sustain/bounce shape exists ──
  // lesson: produce-corrections/gen001-808-register note 1
  "808 RULES (critical — this IS the chord progression, not a rhythm section): pitches MIDI 62-70 only, at least 3 DISTINCT pitches across the whole part.",
  // lesson: produce-corrections/gen001-808-register note 2
  "Every 808 note SUSTAINS to the next one — length = the exact gap to the next note's start, zero silence, and the part fills EVERY bar (no empty bars, no gaps).",
  // lesson: produce-corrections/gen001-808-register note 3
  "Rhythmic bounce: prefer off-beat starts, avoid landing every note on beat 2.",
  // lesson: produce-corrections/gen001-808-register note 9
  "The A and B sections use DIFFERENT 808 patterns — different pitch sequence, not just a repeat — matching the different chord/root feel of each section.",

  // ── drums (mechanical shape: add_midi_clip's inline notes array, no per-hit
  // velocity in add_drum_pattern — DrumPattern.h:131-165) plus the clap-variation
  // taste rule from mac-r0-001 ───────────────────────────────────────────────
  "DRUMS: the whole drum part is ONE add_midi_clip on the Drums track with a `notes` array — pitch = the pad note from REQUIRED TRACKS below, velocity 40-127 (ghosts 40-65, accents 115-127, never everything at one velocity). Per-bar floors on a 16th grid: kick 4-8 hits (off-beats, never just 1 and 3); hats 8-16 hits with accent variation; snare on beat 1 (the jerk '1'); main clap on steps 4 and 12 at velocity 96-102.",
  // lesson: produce-corrections/mac-r0-001 note 2
  // lesson: produce-corrections/mac-r0-001 note 4
  "Layer a SECOND, quieter clap hit that VARIES between bars (an extra softer hit some bars, not every bar, velocity well under the main clap) — never double every clap at equal level.",
  "perc 2-4 hits/bar; roll fills bar 4 and bar 8 only (a short flourish, not every bar); fx 1-2 hits per 4 bars (a transition marker, not a rhythm element). Never leave a bar with fewer than 6 total drum hits.",

  // ── synths — sustain/breaks/octave-dip/late-placement is the mac-r0-001 stab
  // rewrite, generalized to every sustain-style role (counter, stab) ───────────
  "SYNTHS: lead plays 2-4 notes per bar. Chords are polyphonic (a batched add_note with simultaneous starts, 3-4 voices) holding 2 bars at a time, following the 808's pitch changes. Drone holds whole-bar (or longer) notes.",
  // lesson: produce-corrections/mac-r0-001 note 1
  // lesson: produce-corrections/mac-r0-001 note 3
  "Counter and stab tracks SUSTAIN: hold single notes an eighth note to a dotted half, phrased as short motifs with REAL breaks (silence between phrases, not wall-to-wall) — never chains of 1-step staccato chords. Give at least one phrase a dip into the lower half of the register, and place at least one note deliberately off-grid (a hair early or late) rather than every note locked to the beat.",
  "Arp plays a steady 8th- or 16th-note run outlining the current chord. Ambient stays sparse — long, occasional notes, mostly silence.",

  // ── sections (mechanical — one clip per track, MoshOps beat units) ───────────
  "SECTIONS: every track gets exactly ONE add_midi_clip spanning the full 32 beats (bars 1-8, sections A 0-16 + B 16-32) — never a separate clip per section. Change what you WRITE at beat 16 (new 808 pitches, new chord voicings) rather than starting a new clip.",

  // ── step plan (mechanical — the loop FSM's plan-mode contract, loopPrompt.ts) ─
  "STEP PLAN: your first reply is a 9-step goal-only plan, in this order: (1) drums, (2) 808, (3) lead, (4) chords, (5) drone + ambient, (6) counter, (7) stab, (8) arp, (9) a final check-and-done pass. Each later step compiles to exactly ONE add_midi_clip + its notes for that track (or, for step 5, two clips) — put those in the reply's TOP-LEVEL `commands` array, never inside a `plan` (the plan already exists; a compile reply that repeats the plan is discarded). Keep any single reply's notes array under 120 notes — split a dense part across add_note calls on the SAME clip rather than one giant reply.",

  // ── anti-patterns ─────────────────────────────────────────────────────────────
  "ANTI-PATTERNS: a track without a clip (every REQUIRED track needs one); a drum part that uses fewer than 7 of the 10 pads (the layer snare, layer clap, open hat, perc, fx and roll pads exist to be played — the first live run used only kick/snare/clap/hat and sounded thin); an 808 pitch outside 62-70 (never write it there); an 808 with fewer than 3 distinct pitches; a gap of silence between 808 notes; a missing or identical-to-A B section; a melody or counter line stuck in a 2-note range; any drum bar under 6 hits; calling create_track/load_plugin/load_preset/assign_sample/generate_beat_recipe/list_presets (the template already did that work).",

  "Work step by step, verify each step's results, and stop with status 'done' only when every REQUIRED TRACK below has a clip and the full A/B arrangement stands.",
].join("\n");

const KEYNOTE_NOTE = "(root, unrepitched here — the note-writing register above (62-70) is fixed and independent of this exact root)";

/** Render the deterministic preflight's ProduceTemplate into the exact "REQUIRED
 *  TRACKS" block PRODUCE_RULES refers to — trackIds, the drum pad map, the 808's
 *  keyNote, and which preset (or lack of one) loaded on each synth. Omitted
 *  template ⇒ "" (dropped from the composition), which is what keeps
 *  buildProduceSystemPrompt's 3-arg call site (the loop's own systemPrompt hook,
 *  which never knows about `template`) byte-compatible with the 4-arg one. */
export function renderProduceTemplate(template?: ProduceTemplate): string {
  if (!template) return "";
  const lines: string[] = [
    "REQUIRED TRACKS (already built — see TEMPLATE IS LAID above; just write notes):",
    `Drums "${template.drums.trackId}" pads:[${template.drums.pads.map((p) => `${p.note}:${p.name}`).join(" ")}]`,
    `808 "${template.bass.trackId}" keyNote ${template.bass.keyNote} ${KEYNOTE_NOTE}`,
  ];
  for (const synth of template.synths) {
    const label = SYNTH_ROLE_LABEL[synth.role];
    lines.push(
      synth.presetError
        ? `${label} "${synth.trackId}" — NO PRESET LOADED (${synth.presetError}); still write notes, it will just sound like the instrument's default patch`
        : `${label} "${synth.trackId}" preset "${synth.preset}"`,
    );
  }
  lines.push(`Every track's ONE clip spans beats 0-32 (${template.constants.eightBarsSeconds.toFixed(2)}s at ${template.bpm} BPM).`);
  return lines.join("\n");
}

// Illustrative shape only — NOT the corrected reference beat's actual notes (that
// data, when it exists as a fixture, drives produceLane.loop.test.ts directly via
// __fixtures__/mac_r0_001_fix.program.json; this constant is authored independently
// so producePrompt.ts never depends on that fixture existing to build correctly).
// A-section only: 808 (sustained, off-beat bounce) + one stab phrase + a hat lane,
// matching the shapes DRUMS/808 RULES/SYNTHS above ask for.
export const PRODUCE_FEWSHOT = [
  "EXAMPLE (shape only — invent your own pitches/rhythm, never copy these numbers):",
  '  add_midi_clip {"trackId":"<drums>","start":0,"length":64,"notes":[{"pitch":36,"start":0,"length":0.25,"velocity":118},{"pitch":42,"start":0,"length":0.25,"velocity":90},{"pitch":42,"start":0.5,"length":0.25,"velocity":70},{"pitch":38,"start":1,"length":0.25,"velocity":112}]}',
  '  add_midi_clip {"trackId":"<808>","start":0,"length":64,"notes":[{"pitch":62,"start":0.5,"length":1.5,"velocity":95},{"pitch":62,"start":2,"length":1,"velocity":85},{"pitch":65,"start":3,"length":1,"velocity":88}]}',
  '  add_midi_clip {"trackId":"<stab>","start":0,"length":64,"notes":[{"pitch":79,"start":0.5,"length":1.5,"velocity":100},{"pitch":74,"start":3.25,"length":0.75,"velocity":90}]}',
].join("\n");

/** The produce-lane v2 system prompt = the ordinary loop prompt + genre rules +
 *  the rendered REQUIRED TRACKS block + the worked example. Reuses
 *  buildLoopSystemPrompt wholesale so catalog/knowledge/memory/session behavior
 *  stays identical — produce only ADDS, it never forks the base (produceLane.test.ts
 *  pins produce.startsWith(base)). `template` is the 4th, optional param: runTask.ts
 *  binds it in a closure (`(snap, query, memory) => buildProduceSystemPrompt(snap,
 *  query, memory, template)`) before handing the closure to runAgentLoop as
 *  `systemPrompt` — the loop FSM itself only ever calls the 3-arg shape
 *  (loop.ts:99), so `template` omitted here is exactly that call site, not a
 *  degraded one. */
export function buildProduceSystemPrompt(
  snap: Snapshot | null,
  query?: string,
  memory?: string,
  template?: ProduceTemplate,
): string {
  return [buildLoopSystemPrompt(snap, query, memory), PRODUCE_RULES, renderProduceTemplate(template), PRODUCE_FEWSHOT]
    .filter(Boolean)
    .join("\n");
}

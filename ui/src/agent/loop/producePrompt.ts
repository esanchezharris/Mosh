// PRODUCE LANE v3 (P1, flag `produceLane`, default OFF) — the full-production
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
// v3 is the round-2 correction (docs/produce-corrections/produce-r1-2026-09-02
// .meta.json — the owner's first-ever ear verdict on the produce lane, all 7
// candidates rated "fail"): drops the concrete-note few-shot (it was being
// copied, note 4), adds an explicit chord/808 harmony rule (note 1), a real B-
// section contrast rule (note 3), and a described (not exampled) drum jerk-feel
// (note 6). produceCheck.ts is the machine-checkable half of the same round —
// it re-derives the same harmony/B/pad-coverage facts from the model's actual
// output so a repair step can be issued before the run is called done.
//
// Rule provenance: every TASTE rule below (register, sustain, clap variation,
// stab phrasing, harmony, B section, drum feel) carries a
// `// lesson: produce-corrections/<id> note <N>` comment naming the correction
// round it came from (docs/produce-corrections/<id>.meta.json) — never invented
// here. A rule with no lesson tag is MECHANICAL (a command shape, a budget, a
// JSON contract), cited to its design fact instead. See
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
export const PRODUCE_VERSION = 3;

export const PRODUCE_BUDGETS = {
  maxSteps: 24,
  maxPlannerCalls: 8,
  maxStepCalls: 24,
  softWallMs: 900_000,
} as const;

export const PRODUCE_RULES = [
  "PRODUCE MODE v3 — the session below is a REQUIRED TRACKS template someone already built for you: every track exists, every drum pad is a real sample, every synth already has a real Vital sound loaded, the sustained 808 sample is already assigned. Your ENTIRE job this pass is writing NOTES onto that template — you never build it.",

  // ── template-is-laid prohibition (mechanical — the preflight already ran) ────
  "TEMPLATE IS LAID: never call create_track, load_plugin, load_preset, assign_sample, set_drum_pad, or generate_beat_recipe — every one of them already ran before your first turn and calling them again duplicates or corrupts a track that's already correct. Never call list_presets or list_plugins either — the REQUIRED TRACKS list below already names every preset that loaded. Your only commands are add_midi_clip (once per track) and add_note/set_note (to fill it).",

  // ── octave convention (mechanical — MoshOps.Clips.cpp's note units + the
  // melodic-sample transposition math in produceTemplate.ts) ───────────────────
  "OCTAVE CONVENTION: pitches are MIDI, C4 = 60 (NOT 0-11 pitch classes). Registers by role — 808/bass: 62-70 ONLY (D3-Bb3 in note names) regardless of which sample's root note the template picked; lead/counter/stab: 72-84; chords/pad: 57-72; drone: 50-57; ambient: 84-96. A pitch outside a track's register reads as a mistake, not a stylistic choice.",

  // ── style — replaces the old concrete-note few-shot; the owner's round-1 ear
  // heard the labkit twins + the jerk hat/clap idiom AND a literal few-shot hat
  // overlap as "copied from our Ableton session" (note 4) ──────────────────────
  // lesson: produce-corrections/produce-r1-2026-09-02 note 4
  "STYLE (a feel to aim for, NOT an example to transcribe): the reference beat is dense on drums — a busy 16th-note jerk kit that touches most of the 10 pads every bar; a sustained 808 that never leaves a gap; chord/pad stabs that hold and RE-VOICE rather than arpeggiate; hats running steady 16ths with an accent cycle and the odd ghost drop; a layer clap that varies bar-to-bar instead of doubling identically. NEVER reproduce an example pattern — every part in this run is composed fresh, with its own pitches, rhythm, and phrasing; the description above is a target feel, not notes to copy.",

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
  // lesson: produce-corrections/produce-r1-2026-09-02 note 1
  "The 808 changes root at most TWICE per bar (not on every note) — a root that moves more often than that is what breaks the harmony rule below; chords must be able to keep up with it.",

  // ── harmony — the owner's round-1 note 1 ("timing / wrong notes") was
  // diagnosed as harmonic, not a units bug: the prompt had the 808 move every
  // 1-2 beats while chords held a fixed 8 beats, so chord/arp tones clashed
  // with the moving bass ────────────────────────────────────────────────────
  // lesson: produce-corrections/produce-r1-2026-09-02 note 1
  "HARMONY (critical — 'note 1' from the owner's round-1 verdict, 'timing / wrong notes'): chords_pad, arp, lead, counter and stab must stay consonant with whichever 808 pitch is SOUNDING at that instant. The 808's root sets the chord — build a diatonic triad (7th allowed) on that root using the tones of the template's key (read `key.tonic`/`key.mode` from REQUIRED TRACKS below; do not hard-code a key). Any other pitch class sounding at the same time as that 808 note is a harmonic clash.",
  // lesson: produce-corrections/produce-r1-2026-09-02 note 1
  "CHORD RE-VOICING: chords_pad re-voices every time the 808's root changes — a voicing holds exactly as long as that 808 root note does, never a fixed 8-beat block regardless of what the bass is doing underneath it.",
  // lesson: produce-corrections/produce-r1-2026-09-02 note 1
  "TIMING: no note anywhere is placed deliberately off-grid. The only allowed timing looseness is a late/swing feel on hats, at most 1/32 beat behind the grid.",

  // ── drums — the owner's round-1 notes 4 ("parts of the drums sound exactly
  // copied") and 6 ("808/low end weak or wrong", "drums groove/feel") together;
  // this describes the jerk-core shape instead of exampling it, and folds in
  // the mechanical shape (add_drum_pattern has no per-hit velocity, DrumPattern.h
  // :131-165) plus the mac-r0-001 clap-variation taste rule ───────────────────
  // lesson: produce-corrections/produce-r1-2026-09-02 note 6
  "DRUMS FEEL (this IS the jerk groove — 'note 6', weak 808/low end + drums groove/feel from round 1): kick sits on the '1', the 'a' of 2, and the '&' of 3 as the jerk core, plus 2-4 EXTRA off-beat kicks per bar (never just those three, never a static pattern repeated bar after bar); snare on beat 1 only; main clap on steps 4 and 12 (beats 2 and 4) at velocity 96-102; hats run steady 16ths with a 2-step (strong-weak) accent cycle plus 1-2 ghost-velocity drops per bar; open hat lands on the '&' of 4; perc answers the kick call-and-response style — perc hits land in the kick's gaps, not stacked on top of it.",
  "DRUMS SHAPE: the whole drum part is ONE add_midi_clip on the Drums track with a `notes` array — pitch = the pad note from REQUIRED TRACKS below, velocity 40-127 (ghosts 40-65, accents 115-127, never everything at one velocity). Keep at least 7 of the 10 pads in use and cover every beat from 0 to 32 — the jerk core above is a floor, not a ceiling.",
  // lesson: produce-corrections/mac-r0-001 note 2
  // lesson: produce-corrections/mac-r0-001 note 4
  "Layer a SECOND, quieter clap hit that VARIES between bars (an extra softer hit some bars, not every bar, velocity well under the main clap) — never double every clap at equal level.",
  "roll fills bar 4 and bar 8 only (a short flourish, not every bar); fx 1-2 hits per 4 bars (a transition marker, not a rhythm element). Never leave a bar with fewer than 6 total drum hits.",

  // ── synths — sustain/breaks/octave-dip is the mac-r0-001 stab rewrite,
  // generalized to every sustain-style role (counter, stab); chord holds now
  // point at CHORD RE-VOICING above instead of a fixed bar count ─────────────
  "SYNTHS: lead plays 2-4 notes per bar. Chords are polyphonic (a batched add_note with simultaneous starts, 3-4 voices) — see CHORD RE-VOICING above for how long a voicing holds. Drone holds whole-bar (or longer) notes.",
  // lesson: produce-corrections/mac-r0-001 note 1
  // lesson: produce-corrections/mac-r0-001 note 3
  "Counter and stab tracks SUSTAIN: hold single notes an eighth note to a dotted half, phrased as short motifs with REAL breaks (silence between phrases, not wall-to-wall) — never chains of 1-step staccato chords. Give at least one phrase a dip into the lower half of the register.",
  "Arp plays a steady 8th- or 16th-note run outlining the current chord (re-voice with it, per CHORD RE-VOICING above). Ambient stays sparse — long, occasional notes, mostly silence.",

  // ── sections / B — the owner's round-1 note 3 ("things fall apart towards
  // the end — this is a known failure mode"); the flywheel record names it too
  // (PROMPT-trap-v4 anti-pattern "Missing B section") ─────────────────────────
  "SECTIONS: every track gets exactly ONE add_midi_clip spanning the full 32 beats (bars 1-8, sections A 0-16 + B 16-32) — never a separate clip per section.",
  // lesson: produce-corrections/produce-r1-2026-09-02 note 3
  "B SECTION (critical — 'note 3' from round 1, 'things fall apart towards the end'): B is NOT a new song — it keeps the drum groove and the hook. At beat 16, change the 808 pitches, the chord voicings, and exactly ONE texture (either drop the arp or add the counter, not both). Bars 7-8 (beats 24-32) carry a roll/fx transition on the drum track. Every track's last 4 bars (beats 16-32) must be AT LEAST AS DENSE (note count) as its first 4 bars (beats 0-16) — a part that thins out or stops before beat 28 is the exact failure the owner heard.",

  // ── step plan (mechanical — the loop FSM's plan-mode contract, loopPrompt.ts) ─
  "STEP PLAN: your first reply is a 9-step goal-only plan, in this order: (1) drums, (2) 808, (3) lead, (4) chords, (5) drone + ambient, (6) counter, (7) stab, (8) arp, (9) a final check-and-done pass. Each later step compiles to exactly ONE add_midi_clip + its notes for that track (or, for step 5, two clips) — put those in the reply's TOP-LEVEL `commands` array, never inside a `plan` (the plan already exists; a compile reply that repeats the plan is discarded). The drum clip may carry up to 200 notes and MUST cover every bar from beat 0 to beat 32 — you cannot add to a clip later (you never learn its id), so a drum part that stops early leaves the B section silent (the first Opus run wrote bars 1-4 only). Every other track: keep the notes array under 120.",

  // ── anti-patterns ─────────────────────────────────────────────────────────────
  "ANTI-PATTERNS: a track without a clip (every REQUIRED track needs one); a drum clip whose last hit lands before beat 28 (bars 5-8 must be as full as bars 1-4); a drum part that uses fewer than 7 of the 10 pads (the layer snare, layer clap, open hat, perc, fx and roll pads exist to be played — the first live run used only kick/snare/clap/hat and sounded thin); an 808 pitch outside 62-70 (never write it there); an 808 with fewer than 3 distinct pitches; a gap of silence between 808 notes; a chords_pad/arp/lead/counter/stab note that clashes with the 808 root sounding underneath it (see HARMONY above); a missing, identical-to-A, or thinner-than-A B section; a melody or counter line stuck in a 2-note range; any drum bar under 6 hits; calling create_track/load_plugin/load_preset/assign_sample/generate_beat_recipe/list_presets (the template already did that work).",

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
    `Key ${template.key.tonic} ${template.key.mode} — HARMONY above builds every chord/arp/lead/counter/stab tone from THIS key, not a hard-coded one.`,
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

/** The produce-lane v3 system prompt = the ordinary loop prompt + genre rules +
 *  the rendered REQUIRED TRACKS block. v3 dropped the v1/v2 concrete-note
 *  few-shot (docs/produce-corrections/produce-r1-2026-09-02.meta.json note 4 —
 *  the owner heard it as copying); STYLE inside PRODUCE_RULES carries the same
 *  intent as a description instead. Reuses buildLoopSystemPrompt wholesale so
 *  catalog/knowledge/memory/session behavior stays identical — produce only ADDS,
 *  it never forks the base (produceLane.test.ts pins produce.startsWith(base)).
 *  `template` is the 4th, optional param: runTask.ts binds it in a closure
 *  (`(snap, query, memory) => buildProduceSystemPrompt(snap, query, memory,
 *  template)`) before handing the closure to runAgentLoop as `systemPrompt` — the
 *  loop FSM itself only ever calls the 3-arg shape (loop.ts:99), so `template`
 *  omitted here is exactly that call site, not a degraded one. */
export function buildProduceSystemPrompt(
  snap: Snapshot | null,
  query?: string,
  memory?: string,
  template?: ProduceTemplate,
): string {
  return [buildLoopSystemPrompt(snap, query, memory), PRODUCE_RULES, renderProduceTemplate(template)]
    .filter(Boolean)
    .join("\n");
}

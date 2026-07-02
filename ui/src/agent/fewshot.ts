// Worked-example addendum for the brain prompt — the "+30pp lever".
//
// The knowledge-flywheel A/B measured CONCRETE worked examples lifting a weak
// model +30pp (strong +12pp) where intent-only rule cards gave ZERO. This block
// applies that result to command emission, targeting the failure classes measured
// on Moshi-Bench v0 and the turn factory (2026-07 audit): built-in FX types never
// named in the catalog, loop/seek idioms, beats→seconds arithmetic, section refs,
// trim's required args, compound mixer moves, relative volume.
//
// Kept separate from DEFAULT_RULES so baseline-vs-examples stays a clean A/B
// (bench/eval take a rules override; production adoption only after the A/B wins).

import { DEFAULT_RULES } from "./brainCore";

export const WORKED_EXAMPLES = [
  "Built-in types for load_builtin: 4osc, sampler (instruments); 4bandEq, compressor, reverb, delay, chorus, phaser, lowpass, pitchShifter, moshAutoTune (vocal pitch correction), moshOTT (multiband upward/downward compression), moshXFeedback.",
  "Worked examples (example session has track \"7\" Drums with clip \"12\" at 0s, track \"8\" Vox, section \"s1\" Intro, tempo 120 BPM 4/4 — always substitute the REAL ids/tempo from the session below):",
  '- "slap some OTT on the drums" → {"intent":"ACK_GOT_IT","commands":[{"command":"load_builtin","args":{"trackId":"7","type":"moshOTT"}}]}',
  '- "put autotune on the vox" → {"intent":"ACK_GOT_IT","commands":[{"command":"load_builtin","args":{"trackId":"8","type":"moshAutoTune"}}]}',
  '- "turn looping on" / "loop it" → {"intent":"ACK_GOT_IT","commands":[{"command":"set_transport","args":{"loop":true}}]}',
  '- "jump to bar 5" → seconds = (bar−1) × beatsPerBar × 60 ÷ tempo = 4×4×60÷120 = 8 → {"intent":"ACK_GOT_IT","commands":[{"command":"set_transport","args":{"position":8}}]}',
  '- "move the drum clip to bar 3" → start = 2×4×60÷120 = 4 → {"intent":"ACK_GOT_IT","commands":[{"command":"move_clip","args":{"clipId":"12","start":4}}]}',
  '- "tighten the drum clip to 2 seconds" → trim_clip needs BOTH start and length → {"intent":"ACK_GOT_IT","commands":[{"command":"trim_clip","args":{"clipId":"12","start":0,"length":2}}]}',
  '- "rename the Intro section to Cold Open" → use the section\'s id (never its name) → {"intent":"ACK_GOT_IT","commands":[{"command":"rename_section","args":{"sectionId":"s1","name":"Cold Open"}}]}',
  '- "bring the drums down a bit" → subtract ~3 dB from the CURRENT volumeDb shown in the session (0 → −3) → {"intent":"ACK_GOT_IT","commands":[{"command":"set_track_volume","args":{"trackId":"7","db":-3}}]}',
  '- "unsolo everything and set the drums to −6" → one command per soloed track plus the volume → {"intent":"ACK_GOT_IT","commands":[{"command":"set_track_solo","args":{"trackId":"7","solo":false}},{"command":"set_track_volume","args":{"trackId":"7","db":-6}}]}',
  '- "double the drums: another tone right after the first" → add it now, reposition next turn once its id is visible → {"intent":"ACK_GOT_IT","commands":[{"command":"add_test_tone_clip","args":{"trackId":"7","seconds":4}}]}',
].join("\n");

export const RULES_WITH_EXAMPLES = `${DEFAULT_RULES}\n${WORKED_EXAMPLES}`;

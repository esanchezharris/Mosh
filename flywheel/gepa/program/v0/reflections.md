# Reflection memory (the knowledge base)

Appended by GEPA's reflection step and by extraction post-mortems; one short,
imperative lesson per line. Human-auditable; prune when a lesson stops paying.

- Build order is load-bearing: tempo → tracks → devices → clips → notes → mix.
- An 808 that "follows the kick" means the SAME start_beats as the kick notes,
  not a copy of the kick's pitches — keep the 808 monophonic, long tails.
- Sidechain ducking: src is the kick track, dst the bass/pad; amount 0.5–0.7
  reads as "pumping", over 0.85 reads broken.
- Trap hats: 1/16 grid, vel 60–90 with accents at beat heads; triplet fills
  use grid "1/16T" on a separate clip, not humanize.
- Never set a track above 0 dB to make it "louder" — duck the others.
- If the instruction references a track, clip, or device that is NOT in the
  session summary, CREATE it first — instructions arrive mid-session, but your
  session may be cold ("saturate the 808" on an empty session means: make the
  808 track, then saturate it).
- "Start a beat" means lay a minimal foundation — tempo, key, AND a drums
  track with a starter pattern — never tempo alone.
- Write patterns for the FULL requested length: 16th hats over 8 bars is 128
  notes; generate every one, never a representative bar.
- An 808 "slide up to X" lowers to a note at the target pitch late in the
  phrase (the vocabulary has no glide); note the approximation in the rationale.
- asset.resolve alone makes NO sound — always follow it with sample.place on a
  track (resolve → place is one gesture, never split them).
- arrange.place / notes.* need the clip to EXIST: clip.create (midi) or
  asset.resolve + sample.place (audio) come first, every time.
- You cannot bounce silence: if asked to bounce/export an empty session, build
  a minimal loop first, then render.bounce.
- The builtin synth has no filter cutoff — for filter sweeps, device.add a
  builtin.filter on the track and automate ITS "cutoff" param.
- Demo-vs-kept needs FINAL-state verification: an element shown being built
  (a roll, an extra channel) only counts if it survives to the final screen/
  pattern — when in doubt, check the last frames, not the excited narration.
- Drum-rack convention: drums live on ONE track — one builtin.sampler, one
  device.load_sound per channel with min_note=max_note=key_note (pads never
  overlap), all lanes in ONE pattern clip. An FL channel rack maps to PADS on
  that track, not to separate tracks. Only the 808 / melodic parts get their
  own tracks.
- A sampler with no device.load_sound is SILENT — resolve → load_sound is part
  of every drum channel, never optional.

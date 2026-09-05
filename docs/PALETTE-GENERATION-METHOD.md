# Palette generation method — how to consistently hand a NEW user good samples

Derived 2026-09-01 from two owner-ear curation rounds over 333 SA3-generated
one-shot candidates (144 round-1 big-SA3, 25 LoRA/colour, 72 small-sfx, 28
first-hit rescues, 39 tightened keepers, plus recalibration). Every rule below
is measured against the owner's keep decisions, per the quality-loop contract:
the ear is the teacher, and these are its promoted lessons. Artifacts:
`~/Library/Mosh/palette-v2/` (117 curated samples + provenance.json +
engineered-v1 feature index) and `~/Library/Mosh/palette-v2-candidates/`
(full corpus, keep lists, glitch scan, rescue report).

## The pipeline (repeatable, per user or per genre)

1. **Prompt matrix**: per lane (kick/snare/clap/hat/openhat/perc/808/fx),
   4-6 one-shot-phrased prompts ("single hit, dry, no music" wording) ×
   several seeds. Seed diversity earns its cost — keepers spread across all
   four seeds tried.
2. **Model routing** (measured, the single biggest quality lever):
   - **Big SA3 (MLX) for everything tonal or sustained.** Keep rates: 808
     **16/16 (100%)**, closed hat **16/16 (100%)**, kick 79%, fx 56%,
     snare 54%, perc 45%, clap 44%, openhat 42%.
   - **small-sfx ONLY for fx / kick / perc** (50% / 33% / 40% keep). It is
     **banned for clap, snare, hat, openhat, 808: 0/42 kept** — its failures
     are not taste misses but hard glitches (see QC gate).
3. **Auto-QC gate before any human hears anything** — PER-LANE, learned the
   hard way: `clip_pct > 5%` of samples at |x|>0.985 rejects in EVERY lane
   (glitched renders: 25% avg, worst claps ~50%; owner keeps: 0.4%). The
   spectral-flatness bound (> 0.05) applies ONLY to tonal lanes (kick, 808,
   melodic — owner keeps measure ≤0.004 there). Noise-based lanes must NOT be
   flatness-gated: the owner's KEPT openhats have median flatness 0.098 (max
   0.185), hats to 0.428, snares to 0.461 — a lane-blind flatness gate's first
   live run rejected 16/20 legitimate openhats before this correction, and
   flatness cannot separate glitch from good there (kept and glitched ranges
   overlap). Clip% is the universal discriminator; flatness is tonal-only.
4. **First-hit trim, gap-validated** (the recalibrated cutter): librosa
   spectral-flux onsets; a candidate second onset is a REAL second hit only if
   the RMS envelope dips below **-30 dB rel peak** between onsets. Measured:
   a wobbling 808 sustain or ringing kick tail bottoms at -8..-25 dB (never
   cut), a genuine hit gap reads -45..-101 dB (cut 5 ms before the next hit).
   Cut end otherwise = decay to -50 dB (80 ms hold) with a per-lane cap
   (808 4.0 s, fx 2.5 s, openhat 2.0 s, snare/clap 1.4 s, kick/perc 1.2 s,
   hat 1.0 s). Trim from the RAW full-length render, never re-trim a trim.
   First calibration cut 808 tails off; the owner caught it — the -30 dB gap
   rule is his ear promoted to code.
5. **Multi-hit rescue channel**: rejected renders with 2+ validated hits get
   re-offered as first-hit cuts (3/28 became keepers, incl. a clap the owner
   explicitly wanted back). **Never re-tighten an approved keeper**: 0/39
   "tighter" variants of already-kept samples were wanted — once the ear
   approves a cut, it is final.
6. **Taste injection (per-user palettes)**: the user's LoRA rack + semantic
   colours pass straight through generation (`params.loras=[{name,value}]`,
   `params.colors=[{name,value}]`, triggers auto-injected). Measured: 8/25
   (32%) kept across ken-sa3 / mic-sa3 / bro-sa3-v2 at 70 and colours at 60,
   including combined lora+colour takes — comparable to the untargeted big-SA3
   rate on those lanes, i.e. taste injection costs little hit-rate and buys
   personal character. This is the "user injects their own taste into the
   agent's autonomous generation" story, already viable on the service seam.
7. **Human curation rounds with a keep list** (the audition page pattern:
   step/keep keyboard flow, keep list pasted back). Two rounds sufficed for
   v2. Curation stats feed back into THIS document — the method is itself
   inside the quality loop.
8. **Ship**: curated keepers land as `<lane>/<file>.wav` + `provenance.json`
   (prompt/seed/model/lora/colour/round per sample) + the engineered-v1
   feature index (`manifest.json` + `vectors.npy`) consumable by
   `generate_beat_recipe --paletteManifest`.

## Known repo landmine hit while building this

`service/coverage.py` shadows the PyPI `coverage` package whenever `service/`
is on `sys.path`, which breaks `numba` (and thus librosa.feature) with
`module 'coverage' has no attribute 'types'`. Work around by importing service
modules via `importlib.util.spec_from_file_location` (registering in
`sys.modules` before exec), or rename the module.

## Round-3 validation (openhat top-up, 2026-09-01)

The method's first fully-automated run: 20 openhat candidates (big SA3, fresh
seeds, QC gate, gap-validated trim). Owner kept 10/20 (50% — above the lane's
round-1 rate of 42%), and **9 of the 10 keeps were renders the original
lane-blind flatness gate had rejected** — the per-lane QC correction paid for
itself in one round. Lane now holds 15 keepers; palette-v2 total 127.

## Open items

- Licensing review of SA3 output terms before any palette ships to strangers.
- Wire the QC gate + model routing into an agent-callable `generate_kit`
  flow (produce-lane P2) so a new user's first kit runs this method
  autonomously, with their LoRAs/colours as the taste dials.

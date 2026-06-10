# Rung 1 — trap-03: BWB "How to Make Trap Beats • Rhythm" (18 min)

**Outcome: silver (gold-candidate), NOW AUDIBLE** — L1 ✓ · L2 = 1.0
(corrector-verified claims) · judge = 4.0 · bounce peak **−2.5 dBFS** (the
silence guard watches this now) · awaiting Emilio's ears:
**listen to `bounce-corrected.wav` against https://www.youtube.com/watch?v=Tnb9dxHFIkg** —
a thumbs-up flips the store row to gold and seeds the L3 calibration.

## What the tutorial builds (verified vs the screen, not just speech)

A 2-bar pattern at **160 BPM** (tempo display, zoom-verified; the spoken
"140" was the intro example) on a 4-channel rack: hats on straight 16ths
with accents + wrench-tool micro-delay, clap on the 3-and-7 count (steps
9/25 of 32 = beats 2/6 — the halftime placement), one sparse kick, and an
808 laying the dotted-eighth "common hip-hop bounce". Plus a 32nd hat roll
in two tones. Corrected program: 5 steps / 19 ops / 53 notes.

## Autonomous attempts (the system improving between them)

| iteration | result | what broke |
|---|---|---|
| 1 | rejected (L1 ✗, judge 1.0) | exemplar-id leakage → dangling clip refs; ops forced onto talk-only steps; 0 keyframes (scene-only detection on a static screen); "bounce" taken literally as render |
| 2 (after 6 system fixes) | L1 ✓ but 8 ops, false gold (L2 0.958 / judge 2.5) | over-applied "talk only" → missed the 808 + rolls; 46 duplicate vision claims saturated L2; gold rule ignored the judge |
| corrected (this) | **L2 1.0 / judge 4.5 / silver-capped** | — |

Attempt-vs-corrected delta-composite: **0.42** (the autonomous run captured
~the skeleton, missed ~half the build). Readiness gate needs ≥0.8 autonomous.

## Corrections distilled (each landed somewhere durable)

1. **claims/perception**: 46 agreeing vision claims misread 160→140 (small
   digits + the spoken-140 prior). → digit-certainty rule in the vision
   prompt; corrector-verified-claims override in rescore; *confident-and-
   numerous ≠ correct*.
2. **inference**: "I added another 808" inside an explanation IS a build
   step. → extraction prompt rule + the verified bounce-808 exemplar.
3. **inference**: mirror the visible channel structure (one track per rack
   channel). → extraction prompt rule.
4. **vocabulary (gap ledger / IR v0.2)**: FL wrench-tool micro-delay has no
   op — approximated with seeded humanize. Candidate: `notes.nudge
   {clip_id, selector, offset_beats}`.
5. **policy**: gold now requires L2 ≥ 0.8 **and** judge ≥ 4; (kind,value)
   claims dedupe; judge receives the COMPLETE program digest (its
   "truncated 808" complaint was literally my 6000-char cut) and the step
   narrations as the spec.

## Next-iteration system upgrade (queued, not yet built)

Per-step inference is still transcript-only — feeding each step's keyframes
into `infer_step` (multimodal) is the single highest-leverage change this
rung exposed; it would have caught 160 BPM and the 4-channel rack without a
corrector.


## Round 2 — "lol it's silent" → IR v0.2 + real drums

Emilio's listen test failed at hello: structurally-perfect MIDI through
EMPTY samplers renders silence. That friction promoted the one budgeted IR
revision (§14.5): **v0.2 adds `device.load_sound`** (asset→sampler binding —
the gap the §3.5 worked example always implied). Plus: the resolver now
scores the full crate path (pack folders carry genre semantics), a CLAP
text→audio rank tool (`flywheel/verify/resolve_rank.py`), and a 16/24-bit
silence guard in rescore (the first meter only read 16-bit — meters must
never be vaguer than the failure they guard).

Sounds resolved from the Splice crate (CLAP-assisted, corrector-picked):
- 808 → ZONE 6 Atlanta Trap `OS_ATL_808_pure_C` (key C1)
- kick → Komorebi `KMRBI_RHS6_kick_punch` (D1)
- clap → Southside King of Trap `SOUTHSIDE_clap_high` (E1)
- hat → qwaston `MO_QW_hat_closed_ferraille` (F#1; rolls repitch to G#1)

Lesson recorded: CLAP text→one-shot ranking is noisy on transients (a
water-drop perc outranked every clap) — tiebreak, not oracle.

**Listen:** loop `bounce-corrected.wav` (one 2-bar cycle at 160) against the
video's pattern sections (~10:00 for the bounce, ~15:30 for the rolls).


## Round 3 — "use mosh, that's the whole point" → Stage 14 hardening

Emilio reviewed IN THE APP and four product truths failed at once. Each was
root-caused with new instrumentation, not guessed at:

1. **Silence**: the Mac's default output was **BlackHole 2ch** (a virtual
   loopback sink — no speakers) and Mosh inherited it invisibly. Found by the
   new engine-output level tap: the graph measured −12 dBFS while the speakers
   got nothing. Fixes: never default to a pure virtual sink; the output device
   is now visible + switchable in the topbar (machine-local, never synced);
   master + per-track meters ship in the 30 Hz feed. Two more latent bugs fell
   out of the same gate: the deferred MIDI-device scan could KILL the first
   play after launch (now settled at startup), and a meter-client UAF on edit
   reload (guard-malloc-proven, fixed via refcounted plugin handles).
2. **Grid**: the ruler ticked in SECONDS and snap was a hardcoded 0.25s — at
   160 BPM nothing could align. Now: bars.beats ruler with zoom-aware
   beat/16th ticks, tempo-true lane gridlines, musical snap (default 1/16).
3. **Invisible MIDI**: clips now carry their notes in the snapshot and render
   them as velocity-shaded note blocks.
4. **Drum rack**: 4 separate sampler tracks → ONE native rack (one sampler,
   key-ranged pads: hat F#1 · clap E1 · kick D1) + the 808 on its own track,
   exactly as Emilio specified — with an FL-style **step sequencer** in the
   app (click cycles hit → accent → off; every click is a recorded command).
   `corrected-steps.json` restructured to the rack convention (19 ops + a
   measured −6 dB headroom step: the old sum overshot full scale by ~3.5 dB).

Re-scored after restructure: **L1 ✓ · L2 = 1.0 · judge 5.0 · silver
(gold-candidate) · bounce −2.5 dBFS**. Program re-taught: rack-convention
lesson + audible-chain rule in reflections, drum-rack recipe in the
cheatsheet, the drums exemplar now models the full resolve→load_sound chain.

**Review**: `python3 -m flywheel.replicate.ladder open trap-03` → press play
(grid at 160, notes visible, rack steps clickable, meters moving) — or loop
`~/Desktop/mosh-listen/trap-03.wav`.

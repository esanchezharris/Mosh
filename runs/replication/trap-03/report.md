# Rung 1 — trap-03: BWB "How to Make Trap Beats • Rhythm" (18 min)

**Outcome: silver (gold-candidate)** — L1 ✓ · L2 = 1.0 (corrector-verified
claims) · judge = 4.5 · awaiting Emilio's ears:
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

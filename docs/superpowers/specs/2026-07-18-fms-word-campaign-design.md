# FMS Word Campaign — registered program definition (2026-07-18)

*Registered BEFORE round 0. Predictions and gates here are commitments; they may be
amended only by editing this file BEFORE the affected round, never after a readout.*

## Why this exists

After 11 bench rounds the owner called it: "we've done a circle... I failed to start
with a plan session." The circling had a specific cause — no agreed finish line, an
axis that drifted round-to-round, and metric families (envelope/lineup) that won on
paper and lost blind four times. A structured goal-clarification session (three
question rounds) produced the locked program below.

## The locked program (owner decisions, verbatim intent)

| Decision | Owner's pick |
|---|---|
| Finish line | **Guide-vocal grade**: he recognizes his melody + rhythm AND every word is intelligible; timbre/polish may be rough. Rejected: "no fixed bar", take-replacement. |
| Axis | **Words first.** Everything else is a guard or parked. |
| Vehicle | **Full songs** — the entire paired spans (47.4 / 53.4 / 55.0 s), not the 8–10 s windows. |
| Ear cadence | **Milestone-only.** Instruments run the loop; he listens when the gate flips or the stop rule fires. |
| Melody source | **Oracle first** (finished-take melody). Mumble-derived melody is the NEXT campaign, after words pass. |
| Word gate | **Take-calibrated ASR** (definition below). |
| Naturalness | **Fully parked.** Synthetic-but-intelligible passes the milestone. |
| Pitch/key | **Parked.** Key-snap knob stays off; gets its own round later. |
| Syllable enforcement | **Adapt the SCORE, never the lyric** — words verbatim; fix melody-slot geometry so every commanded syllable is singable. |
| Stop rule | Gate green on all 3 songs OR 2 consecutive rounds with no word-hit improvement OR 10 rounds — whichever first → milestone page + honest report. |

## The evidence that authorizes an ASR gate

House rule has been "ASR ranks, never declares." The gate is justified anyway because
it is *take-calibrated* and was validated against the owner's ear before adoption:

Whisper-small on the piñata microscope crops (round r11 page, `ear-consonants`):

| Clip | The piñata word transcribes as |
|---|---|
| Owner's take | "pin yet" (conf .78/.90) — two clear syllables |
| r9b render | "pie" (.08) — one garbage syllable |
| r11a render (floor fix) | "da" (.17) — one garbage syllable |
| r11b PINEAPPLE render | "car" (.76) — one syllable, confidently wrong |

- Pineapple garbling **kills the rare-phone theory** (pre-registered decision tree:
  both garble ⇒ duration/melisma mechanics, not the word).
- Full-song stage9orsum: whisper reads ~every take word correctly, and the render's
  only failures are exactly the two spots the owner's ear had flagged
  ("piñata"→"daa", "lit I rarely sleep"→"literally asleep"). The instrument agrees
  with the ear — the property every envelope-family metric lacked.
- The owner's milestone listen remains the only PASS; the gate only runs the loop.

## Gate definition (take-calibrated ASR word gate)

1. Transcribe the TAKE (whisper `small`, word timestamps + confidence). Align its
   words to the known lyric (normalize: casefold, punctuation strip,
   `phonology.fold_diacritics`; match: exact or Levenshtein ≤ 1). The lyric words the
   take yields = the **demand set** (with take timestamps). Computed once per song —
   the take never changes under the oracle frame.
2. Transcribe the RENDER. Each demanded word must appear, fuzzy-matched the same way,
   within ±1.5 s of the take word's position (no crediting a word sung elsewhere).
3. Per song: `{demanded, hit, missed:[{word,t,renderHeard}], hitRate}`.
   **GATE = missed == [] on all three songs.**

Ruler validation (registered): on round 0 the gate MUST flag piñata-class words where
the owner already heard garbling. Zero findings = broken ruler; fix before any lever.

## Guards (so the gate can't be gamed)

Guide grade needs melody + rhythm too. A kept round must hold, vs the round-0
full-song baseline: within-1st-semitone fraction and rhythm median regress by no more
than 10% (relative), and `noteFloorLeaks == 0` on every score. A lever that buys
words by flattening melody or smearing rhythm is a reverted lever.

## Lever menu (registered order; one lever per round)

*Amended 2026-07-18, BEFORE round 1 (permitted: edits precede the affected round).
Reading the emit path (`score.py::_slot_phonemes`) showed the originally registered
"sliver-fold by merging" would drop the word into the n_slots < n_syllables branch —
surplus syllables flattened onto one note, the exact B2.1 cram class removed for
garbling. The lever is redefined to keep the 1:1 geometry and fix the DURATIONS.*

- **L1 — stress-weighted within-word re-deal** (subsumes the r12 sliver-fold): when a
  word's F0-cut segments are 1:1 with its syllables AND any segment is sub-floor
  (< 0.12 s — the piñata 40 ms sliver), re-deal the word's span across its segments
  by syllable-stress weights (primary 1.5, secondary 1.25, unstressed 1.0), soft
  floor per segment, order preserved, span exact; segment pitches re-measured from
  the take F0 over the new spans. Off by default (payload knob `stressRedeal`), pure,
  RED-first golden on the piñata-shaped fixture.
- **L2 — whole-word note consolidation** (registered 2026-07-19 from round-1 evidence,
  BEFORE round 2): round 1 falsified duration geometry as sufficient — piñata with
  perfect 1:1 stress-dealt notes (0.214/0.255/0.214, N present, stressed longest)
  STILL collapses to one heard syllable, and register is ruled out (failing and
  passing notes share the same B2–C3 range). The remaining structural difference:
  every garbled multi-syllable word is a multi-NOTE melisma split, while SoulX's own
  shipped scores ride whole words on ONE note ("beautiful" = 8 phonemes/note).
  L2 raises `melismaStepSt` 1.5→4.0 so only large genuine steps split a word —
  piñata-class words become one whole-word note (the in-distribution convention),
  trading commanded melisma pitch detail for articulation. Guard risk acknowledged:
  within-1st may drop as internal word pitch flattens; the 10% band adjudicates.
  Round-1 side-finding recorded: score-change re-rolls make borderline words flicker
  (busy/getting flipped on LookinBack) — total-defect comparisons carry seed-lottery
  noise; targeted-defect movement is reported alongside the registered total rule.
- **L3 — singability audit** (diagnostic, not a mutation; always-on file beside the
  score): per-word flags — syllable/segment counts, min segment duration, the
  stressed syllable's segment duration, re-deal fired — for round diagnosis.
- **L4 — sustain chains for long notes** (registered 2026-07-19 from round-2 evidence,
  BEFORE round 3): round 2 KEPT (defects 10→8, piñata articulates as one whole-word
  note, guards improved). Every surviving multi-syllable garble is a LONG-note word
  where the take melismas — helena 1.37+0.91 s, bonham 1.34 s, lacoste 1.76 s with
  the K-AO1-S-T cluster crammed into 0.15 s (the syllable cap on `word_segments`
  forbids the held-vowel continuation notes SoulX's own scores use). L4 = the
  existing `sustainChainS` knob at 0.60 s (voiced-gate 0.90 unchanged): long notes
  split into same-pitch chains, `_slot_phonemes` then gives consonant clusters their
  own note and holds the vowel on the tail — the in-distribution held-word shape.
  (History note: r8's lineup bundle containing a chain lever lost BY EAR on envelope
  grounds; this use is word-gate-adjudicated with guards, and the milestone ear
  still rules.) Kept levers accumulate: round 3 = L2 + L4, baseline = wc-r2.
- Further levers may be added by amendment BEFORE the round that uses them.

## Predictions (falsifiable, registered)

- **P1**: Round-0 word-gate FAILS on all 3 songs; misses localize to
  segmentation-sliver / dense-phrase words, including piñata on stage9orsum.
- **P2**: L1 (stress re-deal) clears the piñata-class misses without breaking the
  guards. (If L1 clears piñata but new misses appear elsewhere, that is P2-partial:
  the lever is right, coverage continues via the loop.)
- **P3**: The full-span renders surface at least one failure class the 8–10 s windows
  never showed (long rests / section boundaries) — this is why round 0 precedes any
  lever.

## Amendment — the "full song" span (2026-07-18, before round 0 completed)

Building the full-span path surfaced a data constraint: verified TRUE lyrics exist
only for the first ~13–15 s of each song (28/34/25 words); the installed word
timelines end there, while ASR words cover the whole 47–55 s takes. Singing
ASR-guessed words would break the bench's known-words foundation (ASR ranks, never
declares — and the gate would turn circular). So **`--full-span` = the full VERIFIED
span** (≈2× the old windows: 15.6 / 15.3 / 13.3 s), auto-extending to the whole take
the moment the owner supplies full lyrics and the alignment is re-run. P3 stands
partially confirmed before any render: the first full-span attempt (span = take
length) mismatched score vs reference and was killed pre-scoring.
**Owner ask (non-blocking):** paste the full lyrics for the three songs to unlock
true full-take rounds.

## Protocol details

- Seeds pinned: SOULX_SEED=4242, SOULX_CFG=5.0, SOULX_NSTEPS=32; any score delta
  re-rolls the whole song (documented seeded-render property) — accepted; the gate is
  word-presence, not sample identity.
- Chunked rendering ≤12 s at phrase boundaries; chain-sum assert; renders are
  self-placed on the span clock ⇒ plain-sum assembly (the double-offset gotcha).
- Milestone page is LABELED (absolute judgment): per song mumble / finished take /
  best render + the honest missed-words readout. Clips provenance-verified
  sample-exact before serving. No blind machinery needed (nothing to de-bias when the
  question is "is this a usable guide vocal?").
- Artifacts stay under `~/mosh-fms-ksb` (never git); nothing touches `--selftest`;
  no GPU rental; NSF stays off.

## Administrative record

- The r11 `ear-consonants` blind A/B (round-3 vs r11a, catch=stage9orsum) is
  **UNCLAIMED/VOID** — the owner pivoted to re-planning before giving picks; catch
  integrity for that round is unknown and no conclusion is drawn from it.
- Campaigns queued AFTER this one (in order, each its own registered spec):
  mumble-derived melody; key-snap/pitch round (keys on file: LookinBack B major 123,
  stage9orsum C# major 145, stage10 A major 140); naturalness (SoulX character /
  tail decay / NSF — license-gated).

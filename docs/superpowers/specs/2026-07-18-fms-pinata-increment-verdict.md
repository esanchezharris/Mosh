# FMS — the piñata increment: deleted consonants, syllable budgets, key snap (2026-07-18)

## The ear verdict that opened this round

Blind ear-lineup round, **catch validated** (the owner heard the byte-identical pair as
identical): **round-3 beat the round-8 "lineup-fix" bundle on both real songs.** Fourth
time an envelope-family metric win lost by ear. Round-3 authoring is re-adopted as the
baseline; the trim/extend/bridge + sustain-chain knobs stay in code, OFF
(`bench_lyrics.py --policy r3|lineup` regenerates either word set; the r3 regeneration was
verified field-exact against the round-3 payloads before any render).

The owner's diagnosis: piñata's quiet last syllable "doesn't get picked up and the whole
thing gets squashed into this nonsense word; the words around those points warp." Plus two
proposals: autotune input/output, and use the known keys/BPMs (LookinBack B major 123,
stage9orsum C# major 145, stage10 A major 140).

## Three causes found (each verified live)

1. **THE SMOKING GUN — `service/soulx/score.py::_clean` DELETED accented letters** before
   phoneme lookup: "piñata" → "piata" → g2p `P IY0 AA1 T AH0`. The N was gone from the
   sung phonemes; "pee-ah-tah" IS the nonsense word. (The syllable COUNT was right — g2p
   on the raw word gave 3, so the word had 3 segments; the sounds themselves were wrong.)
   Fixed with `phonology.fold_diacritics` (NFD, strip combining marks) in `_clean`,
   `heuristic_syllables`, `_heuristic_rhyme`. RED-proven; ASCII byte-identical; the score
   now carries `en_N-AA1` at the "ña" and renders `en_P-IH0-N-AA1-T-AH0` under the venv.
2. **Latent fallback bug** (defense-in-depth): the venv-less heuristic counted piñata as 2
   syllables via the same strip. Same fix.
3. **Systemic — low-confidence aligner boundaries trusted verbatim in dense phrases**:
   piñata(conf .77) → my(.49, 80 ms) → whole(.26) → life(.28), "the"(.005). No gap after
   piñata to claim; the class is 5/28 (LookinBack), 10/25 (stage10), **14/34 (stage9orsum
   — the owner ranked the songs by this number without seeing it)**. First lever:
   `enforce_word_budgets` (opt-in `sylBudgetS`): word minimum = nsyl × floor, quietly-sung
   tails reclaimed from the FOLLOWING gap, same-phrase only (a breath is never claimed).
   At 0.22 it fires small (4 words, 50–90 ms) — piñata itself has no following gap.

## Rounds (seeded 4242 / cfg 5.0 / 32 steps; means across the 3 songs)

| round | change | missing | spurious | within-1st (take) | rhythm ms | drop |
|---|---|---|---|---|---|---|
| 3 (baseline) | — | 27.7% | 17.2% | 0.744 | 65.8 | 0.234 |
| 9a | + consonant fix | 27.8% | 17.8% | 0.744 | 65.8 | 0.263 |
| 9b | + `sylBudgetS 0.22` | **26.4%** | **16.0%** | **0.803** | **53.2** | 0.254 |
| 10 | + key snap | 23.7% | 16.8% | 0.763 | 65.4 | 0.264 |

- **r9a integrity proof:** LookinBack and stage10 renders BYTE-IDENTICAL to round-3 (only
  piñata's phonemes changed, only stage9orsum re-rolled) — the rebase + seeded chain is
  airtight.
- **r9b is the nomination**: every mean at or better than round-3 except drop (0.254 vs
  0.234, still well under the takes' own 0.37 ruler level). stage10's re-roll under the
  budget-touched score is dramatically better (within-1st 0.700→0.857, rhythm 73→28 ms —
  score+seed combination luck, honestly attributed as such, but it IS what ships).
- **r10 (key snap): the registered caveat played out** — OBEDIENCE improved (LookinBack
  within-1st-of-COMMANDED 0.727→0.857; on-scale commands are easier to hit) while
  take-relative pitch dropped (0.803→0.763) and rhythm regressed (53→65 ms); piñata fell
  into the drop list on stage9orsum's re-roll. Guard rules: **not nominated this round**;
  the knob stays (`--key-snap` + `<song>.meta.json`), its ear adjudication deferred.
- **BPM (diagnostics only, as planned):** rhythm medians in 16ths = 0.42 / 0.68 / 0.71
  (16th = 103–122 ms at these tempi) — the residual is around half a 16th, not clustered
  on beat fractions; no beats-based lever justified yet.

## Served ear gate

`~/mosh-fms-ksb/bench/ear-pinata/` on :8199 (cache-tag pinata9): round-3 vs **r9b**,
per-song take-vs-render waveform panels embedded, **catch = LookinBack** — improved over
the plan's stage10 choice because r9b's LookinBack is byte-identical to round-3 anyway
(no diacritics, no budget claims), so the designated catch costs zero information and both
changed songs stay live. All five served clips provenance-verified sample-exact against
their round sources before serving. Key outside the serve root.

What the ear decides: does piñata sing its N (stage9orsum), and does stage10's much
tighter roll sound as good as it measures?

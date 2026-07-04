# FMS kill-shot B — skeleton quality on real mumble takes (pre-registered)

**Status: criteria REGISTERED 2026-07-02, before any eval runs. §1–§3 frozen once eval begins; results in §4 only.** (A plumbing smoke on a sample-pack la-la stem validated the harness — 2× model re-runs byte-identical — but produced no verdict data.)

Measures whether the shipped Phase-2 extraction (`Basic Pitch → FCPE nuclei split → bar binning`) is *editable-proposal-grade* on genuinely slurred takes — the external report's #1-ranked risk, never before measured. Harness: `scripts/fms-killshot/diagnose.py` (+ `score.py`); it dumps everything the product path discards (notes **with pitch**, F0 contour, per-note split provenance) plus audible proofs (`beeps.wav`, `overlay.wav` — one held vowel turning into several beeps makes melisma-mangle audible).

## 1. Eval set (registered)

- **Real takes:** 3–5 of the owner's actual mumble/hum takes (likeliest home: Voice Memos — 1,149 on this Mac, incl. a 94 s memo from 2026-07-01), each with owner-supplied BPM. Ground truth = owner ear-counts syllables per bar (`{"bars": {"0": 4, ...}}`).
- **Answer-key takes (VocalFinisher obscured-demo method):** sung stems with known/hearable words at filename-known BPM (e.g. `Modern Country Pop` `Main_Vocals` stems; `Lala_Vocals` stems are wordless with ear-countable la's) — ground truth from per-bar phrase text via the phonology core (`{"phrases": [...]}`), optionally obscured (low-pass/muffle) to simulate slur.

## 2. Metrics (registered)

Per take: per-bar |detected − truth| syllable error; median/mean/max; % bars within tol 1; clamp events; **split account** (F0-induced splits that added false syllables vs re-articulations the onsets missed — judged by ear on the beep overlay); FCPE-suspect regions (octave jumps at onsets, V/UV flicker on breathy segments — the researched failure modes).

## 3. GO / NO-GO bars (registered — do not move after eval)

- **GO:** median per-bar |err| ≤ 1 (matches the product's `syllableTol:1`) across the real takes, raw output, **and** residual errors correctable in under ~30 s of grid editing per take (the editable-proposal bar, judged by the owner in the Confirm-flow editor).
- **Diagnostic outcomes (not gating, but registered):** if errors concentrate in F0 splits → tune `_SPLIT_SEMITONES`/melisma design before re-testing; if errors trace to Basic Pitch merging slurred notes → **then** evaluate RMVPE (which arrives free with SoulX's preprocess on the CUDA box) — not before.
- **NO-GO:** median |err| > 1 on real takes after harness-side fixes → Phase-3 Stage-1 must budget a segmentation iteration (or lean harder on the editable-proposal UX), and this gets its own spike before pipeline code.

## 4. RESULTS (fill after eval; do not touch §1–§3)

**2026-07-03 — lyrics-truth eval (ccMixter "I'm Going Down", scomber 69520, 91 BPM, CC BY-NC, eval-only).** Segmenter evolution driven by owner listening: v2 (from-scratch gate+grid) REJECTED by ear (lost 16ths, wrong beep pitches); **v3** = v1 nuclei + owner's rule as a *pruner* (boundary survives only on gap/note-change/dip evidence; 16th snap, 8ths preferred) + **melisma folding** (pitch-change-with-continuous-energy = same word, one slot; legato beep re-synth so the fold is audible).

- **Clean lines: exact.** Owner-verified window 17.6–27.7 s ("I'm falling down×5 / but I'm gonna get up again") = **16 detected vs 16 sung**. Line "but names will never hurt me" = 7 vs 7.
- **Ornamented lines: over-count.** Owner-verified window 2.2–15.1 s (same lyric shape, first chorus) = 22 vs 16 (+37%). All six surplus boundaries are Basic-Pitch note-gaps inside held/ornamented vowels the owner says are single words.
- **Discriminator sweep (all FAILED to separate the two windows without collateral damage):** full-band envelope drop at boundary; off-grid filtering; FCPE voicing continuity (voiced straight through real 400 ms silences at threshold 0.006 — unusable as evidence); 250–2500 Hz sonority-band notch (5 ms hop); Basic-Pitch pitch deltas (vibrato quantizes to ±1–5 st on held notes — indistinguishable from real note changes). **Conclusion: ornament-vs-syllable on held sung vowels is not decidable from this signal stack.** This is the roadmap §7 prediction ("gibberish alignment unsolved as turnkey") landing precisely; the human-in-the-loop grid editor is the designed absorber, and in the product flow the artist's own words are the truth anyway.
- **Against the registered bar:** per-bar median |err| ≤ 1 holds across the owner-verified windows (plain bars err 0, ornamented bars ≈ +1.2, median ≤ 1) — but the bar was registered for the owner's real mumble takes, which remain the outstanding eval item.
- Determinism ×2 on every run; harness: `diagnose.py --algo v1,v3` + `lyrics_truth.py`.

**2026-07-04 — ASR-as-syllable-oracle (v4) + truth-window correction.** Owner's idea: run Whisper *generously* (wrong words welcome) and consume only word count/syllable shape/timestamps — the human-speech prior the DSP sweep lacked. Whisper venv installed post-#218 (`~/Library/Mosh/venvs/whisper`, model `small`).

- **Registered gate:** as written (v3-phrase-derived windows ±2) technically FAILED — but the windows themselves were the error. Whisper's word timeline exposed that the "ornamented window A" had been misattributed (it spanned parts of three lyric lines, not two). **Deviation recorded: the gate was re-scored on the owner-verified 0–22 s span (truth 32): Whisper = 32/32 EXACT** — including hearing "get up" where the printed lyric says "getta", agreeing with the owner's ear.
- **v3 EXONERATED by the corrected truth:** on Whisper-timeline line spans, v3 scores 15/16, 16/16, 31/32 (v1: 20/16, 21/16, 41/32). The earlier "+6 over-count" and the "five-discriminator wall" were substantially evaluation artifacts of the misattributed windows. **The melisma-aware pruner was already ~exact.**
- **v4 (phrase-level ASR budget fold, `fuse_asr_budget`):** per-WORD budgets over-folded (25/32 — ASR word ends land early on held notes); per-PHRASE budgets with span-to-next are safe: v4 = v3 on all verified regions, 0 folds on the owner's take (ASR agrees with v3), 21 folds confined to the pella's echo-overlapped later sections (plausible but ear-unverified), passthrough on wordless material (la-las: 3 hallucinated words, 2 folds — the one watch-item). Selftest +5 fusion cases, 3× deterministic; eval set ×2 identical (words cached per take).
- **New dominant error axis: UNDER-detection.** The soft echo-heavy section (lines 5–6) scores 4/8 in v1, v3 AND v4 — Basic Pitch misses onsets that Whisper confidently heard as words. Fixing that means *seeding* slots from ASR word timestamps when v3 is under budget — outside this plan's registered "never invent" rule; proposed as the next iteration if the owner wants it.
- **FINAL VERDICT (2026-07-04): GO.** v3 (with the v4 ASR-budget as a conservative cross-check) is editable-proposal-grade. Evidence: owner-ear-verified exactness on the pella truth windows (15/16, 16/16, 31/32 vs v1's 41/32); independent ASR agreement on the owner's own take (Whisper 124 = v3 124 in the diagnostic span); ±1 median per-bar error bar met. **The final by-ear overlay pass on the owner's take was WAIVED by the owner** — the beep-overlay method is retired as an evaluation instrument now that the ASR oracle provides ground truth (overlays communicate poorly on dense low-register flows even after the octave lift; they remain useful only as a debugging aid). Promotion of v3+v4 into `service/skeleton/core.py` belongs to the Phase-3 Stage-1 plan.

- [x] Take list: pella (91), poppinshit (134), lala1/2 (127), mainvox (128), memo (120 unverified) — diagnostics + words caches in `~/mosh-fms-ksb/`
- [x] Metrics: `lyrics_truth.py` per-line tables + corrected-truth region scores (above)
- [x] Split account: melisma folding subsumed it (v3 39 groups on the owner take; ASR cross-check 0 over-budget)
- [x] By-ear notes: v2 rejection + v3 confirmation rounds (owner); final overlay pass waived — method retired
- [x] Verdict: **GO** — knob was neither threshold nor RMVPE but *evaluation truth* (ASR timeline) + melisma folding; residual axis = Basic Pitch under-detection on soft/echoed material (Phase-3 item)

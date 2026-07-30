# FMS lyrics bench — checkpoint & handoff, 2026-07-30

*Written for an agent taking this over cold, and for an auditor who should assume
the previous agent was wrong somewhere. Every headline number below names the
command that reproduces it. The [PROGRAM.md](PROGRAM.md) ledger is the
append-only history; this file is the state of play.*

Branch `claude/fms-lyric-pilot-harness-e1820f`. Data root
`~/Library/Mosh/lyrics-bench` (never in git — third-party lyric text).

---

## 1. What this program is trying to do

Finish-my-song, lyrics first. A masked-word benchmark over known-good rap
lyrics: hide a word, ask an arm to fill it, score against what the artist
actually wrote. `exact` is the cheap diagnostic; **the owner's keep-rate (would
you keep this bar?) is the metric that decides**, because the two have now been
measured moving in opposite directions twice.

---

## 2. Where it stands (v3 + junk gate, itemsSha `9501ed7a`, frozen 150 dev rhyme items)

**Data quality has been eliminated as the explanation for the ceiling.** Three
independent cleanups moved the champion by a total of one item:

| slice | control `exact` | oracle `rhyme_perfect` |
|---|---|---|
| v2 (pre-cleanup) | .413 | .300 |
| v3, ad-lib wall (`b90febf9`) | .413 | .313 |
| v3 + junk gate (`9501ed7a`) | **.420** | .320 |

The ad-lib wall removed 8 genuinely unanswerable items from the frozen 150 and
the junk gate quarantined 192 songs (99 `???`, 93 non-English) — both real
defects, neither of which moved the score. Anyone arriving with "the data must
be dirty" should read this row first: it was, twice, and it was not the
bottleneck.

| arm | exact | topk | rhyme_perfect | note |
|---|---|---|---|---|
| oracle (the artist's own word) | 1.000 | 1.000 | **.320** | the ceiling |
| **prompt-device-fp v2** | **.460** | .467 | .483 | best exact, NOT significant (p=.281) |
| prompt-rhyme-menu-fp | .420 | .527 | .490 | the long-standing champion / control |
| rhyme-floor-fp | .107 | .227 | .940 | the floor |

Reproduce any row:

```bash
python3 service/lyrics/bench/bench_cli.py run --arm <name> --slice dev --granularity rhyme --limit 150
```

**The single most load-bearing number in the program:** the oracle's
`rhyme_perfect` is **~.31** (.300 / .313 / .320 across three
independent item sets — the most stable number in the program). The artist's own end words are formally-perfect
rhymes under a third of the time, so any bar that demands high `rhyme_perfect`
is demanding the model out-rhyme the humans it imitates. This killed the draft
registration bar (`exact ≥ .45 AND rhyme_perfect ≥ .60` — the second clause is
above the ground truth and cannot be satisfied while matching it).

---

## 3. What is CLOSED, with the evidence (do not redo these)

| lane | verdict | evidence |
|---|---|---|
| Pointwise reranking (M6) | dead | local logprob .300, zero-shot bge .213, fine-tuned bge .267 — all below generation order |
| 2-way selector (logprob picks between two arms) | dead | 21/39 = .538, binomial p=.75 vs chance, IDENTICAL to the constant policy "always trust arm A" |
| Frequency reranking of the arm's own top-5 | dead | .300 vs .433 as-generated — actively harmful |
| Pool depth | already optimal | interior maximum at 200 on four axes (exact/topk/recall@40/calibration); 100→.420, 400→.427, 1000→.413 |
| More training data (FIM-LoRA) | no gain | 3× data (54k triples), overfit ceiling lifted (monotone to step 2900) yet exact unmoved: .413 vs .433, p=.51 |
| CUDA↔MLX bridge fidelity | validated for sweeps | n=600 twin: 94.2% item agreement, McNemar p=.175. NOT certified at the written ±.02 (would need ~6,300 items); equivalence holds at ±.035 |

**Three independent negatives say the same thing: nothing orders the candidate
words better than the writer does.** That is why the shipped answer is a
palette, not a ranker.

---

## 4. What SHIPPED into the product

* **The rhyme palette** (`ui/src/v2/inspector/LyricPanel.tsx`, commit `62977842`).
  Per-line ◇ button → the 40 freq-ranked rhymes for that bar's anchor, each a
  button that places the end word. Fetch is **on click only** (`get_rhymes`
  blocks the UI thread by design). 40 is a measured interior maximum
  (24→.387, 40→.413, 100→.320, 200→.267).
  Why it is the right surface: **a 40-word palette contains the word the
  original artist used 80% of the time**, against .433 for autofilling the top
  pick — and no scorer can order those 40, so the human closes the gap.
* **The rhyme palette in the generator prompt**, default ON since 2026-07-28
  (`MOSH_RHYME_PALETTE=0` opts out). Product A/B: exact .053→.087, rhyme_perfect
  .642→.887 — both up.

---

## 5. What is OPEN

1. **DEVICE-1 (`prompt-device-fp` v2)** — the model names the bar's move
   (pun/slang/flex/image/punchline/reference) before filling. Best exact on the
   board (.460) but **p = .281**, and the blind sitting is a wash (control mean
   .851 vs device .745; keep 29.8% vs 31.9%; ordinal 17–20, p = .74).
   Real signature: **better at rank 1, worse at rank 5** — committing to a move
   makes it decisive. Verdict: small effect at best; not shipped, not dead.
2. **Data curation: DONE and closed as a lever.** The junk-text gate
   quarantined 192 songs (99 `???`, 93 non-English) of 26,097; the board moved
   +.007. Combined with the ad-lib wall's 0.000, data quality is measured, real,
   fixed — and not the reason the ceiling sits near .42.
3. **Era restriction** — owner asked whether to cut pre-2020. **Measured: no.**
   The corpus is already 2015+ (no 2000s material; the Nas songs are his 2022–23
   work). Era does not predict score: control .423 on 2015–19 vs .403 on 2020+;
   the device arm is *better* on the older half. Both non-significant. Cutting
   would halve the corpus to fix nothing measurable. If it happens it should be
   a product decision, not a benchmark fix.

---

## 6. How to AUDIT this work (start here if you are checking me)

The previous agent got several things wrong and caught them only by testing its
own claims. Assume more remain. The highest-yield checks, in order:

1. **`grep SABOTAGE` across `service/` and `ui/`.** Must be zero. Every guard
   here claims a RED-proof; residue means one was left in.
2. **Re-run every `*_test.py` under `service/lyrics/bench/`** with system
   python3 (no MLX, no API key). All must pass hermetically.
3. **Check that guards can actually fail.** Two vacuous guards shipped during
   this work and were caught only by sabotage:
   * the first ad-lib fixture used ad-lib endings that rhymed with nothing, so
     both walls were redundant and both sabotages passed green;
   * a whole test block sat *after* the suite's `sys.exit()` and never executed
     while the file reported "all green".
   When you RED-prove, **verify the sabotage actually reached the file** — a
   grep that filters output can hide an `AssertionError` from the patch script.
4. **Check the format witness on any sweep.** A DEVICE-1 result
   (exact .327, "significant regression", p=.035) was **entirely an artifact of
   the arm's own prompt** producing whole-clause fills on 17% of items. It was
   caught by the owner reading one rendered bar, not by any metric. Every arm
   comparison should report the multi-word-fill rate beside its score.
5. **Check cache re-keying before believing a null sweep.** A pool-depth sweep
   returned byte-identical results because the knob never reached the runner's
   cache key — "no effect" was really "did not run". The witness is a mechanism
   value (`poolSize`, a sha, a wall-clock that stops being instant), and the
   proof is `MOSH_INFILL_CACHE_ONLY=1`: default must replay, swept value must
   raise `CacheMiss`.
6. **Distrust any keep-rate comparison whose arms were judged in different
   sittings.** Sitting 1 accepted 57%, sitting 2 accepted 42% — a 15-point
   session drift that fully accounted for a p=.007 "significant" taste
   difference. The blind, interleaved, same-moment design
   (`calibrate make --from-run-results ... --arm-frac 1.0`) is the fix and is
   already built.
7. **Recompute significance on anything called a champion.** `exact` differences
   of ~.02 on n=150 are not significant (McNemar p≈.75). The board's spread is
   mostly noise; the only large, unambiguous effect measured all program is
   trained-adapter vs no-adapter (p<.0001).

---

## 7. Traps that cost real time here

* **`acceptFit` cannot rank arms.** It auto-scores an exact match 1, so a
  thinly-labelled arm's denominator is mostly its own hits and its keep-rate is
  forced toward 1.0. It once ordered the arms almost perfectly by *coverage*.
  Use **keep-rate GIVEN A MISS** (exact removed from the numerator) instead.
* **The owner's accept labels cover the arms they were collected on.** An arm
  that picks different words is mostly *unjudged*, not *wrong*.
* **A pre-registration can launder a defect.** DEVICE-1 pre-registered that
  `exact` might fall; when it fell because of a bug, the pre-registration made
  it look like the expected finding.
* **mlx_lm's `CompletionsDataset` re-templates.** It wraps an already-templated
  prompt in a second chat turn. A CUDA trainer that concatenates raw trains a
  different task — this cost one full training run (.173 exact, below base).
* **Ad-libs are a separate vocal layer.** Parenthesised text is doubles/echoes/
  breath, not written to the rhyme scheme. v2 had 8 unanswerable items in the
  frozen 150 because of it (`mask.is_adlib_token` now refuses them).
* Money: every Vast run must tear itself down. `vastai destroy` **prompts**
  without `--yes` and reads EOF as "Aborted" while exiting 0 — a box billed
  behind a swallowed prompt. `service/lyrics/bench/vast_fim_lane.sh` has four
  independent guards; total spend across 8 runs was ~$3.63.

---

## 8. Reproducing the environment

```bash
# hermetic unit + guard suites (system python3, no MLX, no API key)
for t in service/lyrics/bench/*_test.py; do python3 "$t" || echo "FAILED $t"; done

# the board
python3 service/lyrics/bench/bench_cli.py run --arm prompt-rhyme-menu-fp --slice dev --granularity rhyme --limit 150

# an owner sitting (blind arm-vs-arm, the only instrument that settles taste)
python3 service/lyrics/bench/bench_cli.py calibrate make --from-run-results <runA>,<runB> \
  --n 50 --arm-frac 1.0 --anchor-frac 0 --blind-frac 0
python3 service/lyrics/bench/bench_cli.py calibrate serve --port 8781
```

Local weights: `~/Library/Mosh/venvs/sft/bin/python` (mlx_lm 0.31.3).
Adapters + training data: `~/Library/Mosh/lyrics-bench/fim/`.

---

## 9. If you continue, the honest read on what is worth doing

The machine side is converged: ranking, selection, pool depth and data scale are
all closed negatives, and the two prompt-side champions sit within noise of each
other at ~.41–.46 against a human ceiling the norming sitting bracketed at
roughly .52–.77. The measured headroom that is *not* closed is the human loop —
palette recall .800, oracle-of-2 .540 — which is why the shipped artifact is a
surface rather than a model.

The next honest experiments, in order of evidence behind them:

1. **Score the existing arms on keep-rate-given-a-miss with a blind,
   interleaved sitting** (never sequential — see trap 6). The one axis nothing
   has been optimised against.
2. **DEVICE-1 at larger n**, or dropped. It needs ~150 blind pairs to resolve an
   effect this size, and 47 could not.
3. Not diffusion. The structural problem (commit to an end word, fill backwards)
   is already solved by constrained decoding — `rhyme_fit` is 1.0 by
   construction. The failures are semantic, and diffusion does not fix meaning.

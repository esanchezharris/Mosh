# Finish My Song — everything we've tried, and where we're stuck

*A self-contained briefing for research. Written 2026-07-26. No repo access needed to read it.*

**Contains no song lyrics.** Every corpus example has been replaced by a description. That is a
standing rule of this project, not a redaction for this document.

---

## 0. What we're actually building

**Mosh** is a native DAW (C++/JUCE + Tracktion engine, WebView UI, Python service tier for
generative work). It runs on macOS/Apple Silicon as the canonical target, with a Windows/CUDA port.

**Finish My Song (FMS)** is one feature inside it, and the thesis is an *integration* claim:

> A producer hums or mumbles a wordless take over a beat. The system extracts the rhythmic
> skeleton of that performance, writes lyrics that scan to it, and re-sings them in the producer's
> own voice.

The prior-art read at the time (2026-06) was that **no one ships the end-to-end chain** — every
sub-capability exists in isolation. The moat was supposed to be the integration plus a
"constraint-first" framing: **the take is a specification, not a prompt.**

The arc was deliberately sequenced so each phase ships value alone:

| Phase | What | Status today |
|---|---|---|
| 1 — Text lyric engine | Type partial lyrics with gaps → engine fills to the cadence | **Shipped**, quality unproven |
| 2 — Mumble → skeleton | Hum the flow → extract syllable grid → feed Phase 1 | **Shipped** as an editable proposal |
| 3 — Own-voice render | Re-sing the finished lyric in the artist's cloned voice | **Built, then refuted at the quality bar** |

The load-bearing design decision: every phase produces or consumes the same `LineSpec`
(syllable targets, stress contour, rhyme groups, per-line constraints). Phase 2 is a front-end that
emits it; Phase 3 is a back-end that renders it. The engine in the middle never changes.

**The owner is a working rap producer.** His taste anchors are Ken Carson, Young Thug, Playboi
Carti, Future, and Drake. Everything below is measured against *his* ear, not a general audience.

---

## 1. Constraints

**Fixed:**
- **Personal research posture.** The lyric corpus is scraped and used privately. It is never
  redistributed and never ships in the product. Do not spend an answer on licensing workarounds.
- **Nothing is shipped that the owner's ear has rejected.** Instrument wins do not override it.
  This has bitten five times (§5).

**Open to challenge — treat as negotiable, not settled:**
- Hardware: Mac M-series (MLX) is canonical; a Windows/CUDA box exists; rented GPU is acceptable
  for training, not for every render.
- Deployment shape: currently everything generative runs as a job behind a Python service adapter,
  never on the audio thread.
- The architecture itself, including whether the three-phase decomposition is right.

---

## 2. Track A — the text lyric engine (shipped, quality unproven)

Built as a ladder, each rung landing independently:

- **L0 — phonology core.** Phoneme-based rhyme grading over the rime (perfect / slant / none),
  syllable counting, stress contour, ranked rhyme search. CMUdict + a g2p fallback + a
  vowel-group heuristic for out-of-vocabulary slang. Rhyme is graded on *phonemes, never
  spelling* — so a pair like *love/move* correctly grades slant rather than perfect.
- **L1 — flow analysis.** Per-line syllable count, stress contour, rhyme grade vs the group anchor,
  multisyllabic rhyme depth. Surfaced as a visual flow meter in the UI.
- **L2 — generation loop.** `propose → validate (phonology) → re-prompt with the specific failure
  → rank → top-N`. The *validator*, not the model, is what guarantees the line fits the grid.
  Shipped fake-first (a deterministic template filler that hits syllable targets exactly) so the
  loop, UI, and pass-rate metric could be proven with no model at all.
- **L3 — real LLM behind the same seam.** Provider chain (DeepSeek → OpenAI → xAI). The fake
  remains the deterministic test backend.
- **§7 — style RAG.** Retrieve the artist's *own* accepted lines as exemplars, inject "write in
  this voice, do not copy," with a near-verbatim guard that drops parrots and re-prompts.
- **Bar-IQ — vocabulary layer.** A tagged word bank (word, phonemes, register, rhyme family) so
  slang and coined words get *real* phonemes and can be graded as real rhymes rather than falling
  back to spelling. Reference artists are taste inputs (which register to support), never a stored
  lyric corpus.

**This all works mechanically. Nobody ever measured whether the lyrics were good.** That gap is
what Track C exists to close.

---

## 3. Track B — own-voice vocal synthesis (built, then REFUTED)

This is the longest and most expensive track, and its failure is the most informative thing in
this document.

### 3.1 Model selection

**SoulX-Singer** was chosen as the render anchor: Apache-2.0 weights *and* code, score-conditioned
zero-shot singing synthesis, ~12 GB VRAM, 24 kHz mono. Rejected alternatives and why:

- **Vevo2 / Vevo1.5** — best research quality, but CC-BY-NC-ND weights: non-commercial *and*
  no-derivatives. Unusable in a product.
- **Seed-VC** — GPL-3.0 copyleft.
- **YingMusic-Singer-Plus** — initially believed MIT; on verification the weights are CC-BY-4.0
  *except the VAE under a Stability community licence*. **Lesson: verify the weights licence, not
  the code licence.** Repos routinely ship MIT code with encumbered weights.
- **RVC** — MIT throughout; kept as the timbre-conversion fallback.
- **ACE-Step 1.5** — MIT, runs under MLX on Mac; kept as an instant generic-voice mock.

### 3.2 Kill-shot A — does it sound like him? **GO**

Pre-registered criteria, then 6 renders on a rented RTX 4090 (~$1.40, pod destroyed after pull).
Blind rating by the owner with the real a cappella hidden in the set as an anchor.

- **English intelligibility: 6/6** (bar was ≥3/6). One render had the lyric quoted back verbatim.
- **Own voice: PASS** — "sounds exactly like me," and **a 10-second reference performed as well as
  a 30-second one.**
- The real anchor was correctly identified as real; no render was mistaken for real.

**Zero-shot own-voice cloning from ~10s of audio is a solved problem for our purposes.**

### 3.3 Kill-shot B — can we read the skeleton off a mumble? **GO, with a hard limit**

- On clean sung lines, syllable detection is **exact** (16 detected vs 16 sung).
- On ornamented/held vowels it **over-counts** — pitch-tracking note-gaps inside a single held
  vowel read as extra syllables.
- Five separate discriminators were tried to separate "ornament" from "new syllable" (energy drop,
  off-grid filtering, voicing continuity, sonority-band notch, pitch deltas). **All failed.**
  Vibrato on a held note quantizes to the same pitch deltas as a real note change.
- **Conclusion: ornament-vs-syllable on a held sung vowel is not decidable from this signal stack.**
  The designed absorber is a human-in-the-loop grid editor — the skeleton ships as an *editable
  proposal*, never as ground truth.
- Then the owner proposed the fix that worked: **run ASR generously and consume only word counts
  and timestamps, never the words themselves.** Wrong words are fine; the human-speech prior is
  what the DSP stack lacked. Scored **32/32 exact** on a verified span.

### 3.4 FMS-Bench — anchoring the "doesn't sound human" problem

The sing pipeline was **unanchored**: the only signal was the owner saying better/worse, with no
reference. The reframe: take vocals with *known* words, synthesize a mumble from a fraction of
them, run the full pipeline, and score the output **against the real human vocal**. Two axes kept
deliberately apart: **correctness** (distance to reference) and **naturalness**.

Findings that changed what we did:

1. **The word-alignment ruler saturates near 0.36 on real human singing, not 1.0.** A fully
   intelligible human vocal scores ~0.31–0.41 against its own ground-truth words, because it is
   acoustic alignment confidence, not similarity. Every word-recovery number has to be read
   against ≈0.36. **Scoring *above* the human is a red flag**, not a win — forced alignment rewards
   canonical articulation, and a synthesizer that sings exactly the phonemes it was given will beat
   a human who slurs.
2. **Pitch is already solved by the input.** Mumble and finished take differ by 0.0–0.1 semitones
   median F0. The draft already carries the melody in the right register.
3. **Our mumble synthesizer was ~6× too aggressive.** Real mumbles retain 0.157 mean word
   recovery; ours produced 0.041 — destroying words a real mumble keeps. It had been tuned to
   *maximize an ASR confidence drop*, a proxy chosen because no real mumble existed to check
   against. That is not the same goal as "resembles a real mumble."
4. **The pipeline solved the words and broke the performance.** Word recovery 0.146 → 0.490 (past
   the human's own 0.313), while performance similarity (energy-envelope correlation to the
   reference) went 0.400 → **0.266** — *further from the finished take than the raw mumble.*
   Doing nothing beat the pipeline on that axis. Two human takes of the same song correlate
   ≈0.40–0.44, which became the target band: a correct system lands there, no further (closer
   implies copying).

### 3.5 Eleven increments of repair, then the refutation

Work included: per-note dynamics transfer (reached 0.414, inside the human band); discovering our
score format was **out-of-distribution** for the SoulX weights (we authored one syllable per note;
SoulX's own scores ride whole *words* on one note); an unseeded RNG making every prior comparison
partly noise (fixed with a seed — **every unseeded round-to-round comparison in that lane's history
was partly noise**); a bug where accented characters were stripped before phoneme lookup, deleting
a consonant from a nonsense word the owner cared about; a word-span bug silently dropping ~20 of
154 words; and a full lyric-correction tool so whole songs could be evaluated instead of 15-second
spans.

Final measured state: **89.0% ASR word recovery**, best-ever pitch and rhythm guards, zero
structural defects.

**Owner verdict on the full songs: "these sound kinda the same — ok not very good." GUIDE-GRADE NO.**

The interpretation, recorded so it is not re-litigated: **the binding constraint was never word
placement — it is the synthesizer's articulation and naturalness character**, the exact axis the
campaign had deliberately parked. Words-first is *exhausted*, so this is a clean refutation rather
than an unfinished run. The queued follow-ups (mumble-melody estimation, key snapping) are both
*placement* refinements and would inherit the same ceiling.

**Track B is paused.** Honest options: attack naturalness directly (a neural vocoder re-synthesis
at the take's F0 — blocked on a licence-clean self-trained checkpoint), swap the render engine
(no licence-clear Mac-native alternative found; a native DiffSinger port is the only
uninvestigated lane), or re-scope what "guide vocal" has to mean.

---

## 4. Track C — lyrics quality (current, and now plateaued)

### 4.1 The pivot

With the vocal track refuted, the owner re-pointed the quality push at **lyrics first**, with a
specific method: *collect verifiable known-good lyrics, mask out words, and measure whether the
system guesses the right fill.* (He called it "JEPA-style"; it is technically masked-LM / cloze
infill — JEPA proper predicts in embedding space.) The appeal is that it is **verifiable** and
matches the product moment exactly: the user types part of a bar, the system fills the blank.

### 4.2 The benchmark

- **Corpus:** ~20k rap/English songs from a public Genius dump, plus ~4.5k songs scraped for
  2022–2026 material (the dump ends in 2022 and the owner's taste is current-slang-dependent).
  Zero register filtering — profanity and slang are first-class targets, not noise.
- **Four masking granularities:** a single content word; the **line-end rhyme word**; a 2–4 token
  span; a whole line. Every mask is seeded and deterministic; the policy version is part of every
  item ID so old runs can never silently mix with new items.
- **Splits:** song- and near-duplicate-cluster-disjoint (covers and remixes quarantined), salted
  hashing, with a taste-curated "golden" set that appears in no other split.
- **Metrics:** exact match, top-5, syllable fit, rhyme fit (graded on phonemes, honestly *null*
  when either side has no pronunciation rather than guessed from spelling), perfect-rhyme rate,
  multisyllabic rhyme depth.
- **Determinism:** every model response is cached by prompt hash, so a run replays bit-for-bit.

### 4.3 The first big finding: **line-level cannot be measured**

At whole-line granularity, `exact` is **not even defined** — there is no single correct bar. And
the shipped product loop scores **100.0** on the composite deterministic metric, because it always
hits the syllable target and always rhymes. **The instrument is pegged**, which means the human is
the entire measuring apparatus. Three separate owner sittings were spent this way before the owner
said, correctly, *"I feel like I'm really shooting in the dark."*

At the **rhyme word**, by contrast, the same metrics have wide range and cost nothing to compute.
That is where the program moved.

### 4.4 The second big finding: **a third of the benchmark wasn't testing rhyme**

Found by reading actual model output, not by any test. Rhyme "partners" included single letters
and filler words; pairs were being formed between words that don't meaningfully rhyme.

**32.2% of rhyme items had a function word or sub-3-character token at one end.** The most-tested
"rhyme words" were *me, yeah, you, it, up*. A third of the benchmark was asking "can you guess the
word 'me'."

Worse, **these items invert the ranking**: an arm that *obeys* a nonsense rhyme constraint scores
worse than one that ignores it. Fixed at the policy level; 59,333 → 43,006 dev rhyme items, junk
**32.2% → 0.00%**. All prior arm numbers were voided and re-measured.

### 4.5 Results on the clean benchmark

Dev slice, rhyme-word granularity. `exact` = matched the artist's actual word.

| arm | n | exact | top-5 | perfect rhyme | rhyme depth |
|---|---|---|---|---|---|
| `oracle` (the truth — ceiling probe) | — | 100% | 100% | — | — |
| `rhyme-floor` — pure phonology, **zero API** | 400 | 10.7% | 21.7% | **93.0%** | **1.14** |
| `llm-constrained` — LLM + constraints in prompt | 150 | **37.3%** | 48.0% | 35.7% | 0.84 |
| `prompt-rhyme-menu` — LLM handed the rhyme list | 150 | 32.0% | 40.7% | 52.7% | 0.95 |
| `fusion-rerank` — phonology proposes, LLM ranks on meaning | 150 | **37.3%** | 49.3% | 35.8% | 0.81 |

**A dictionary out-rhymes a language model.** Free phonology lands a perfect rhyme 93% of the time;
the LLM manages 36–53%. The LLM's edge is *semantic* — it knows what the line is about, so it finds
the artist's actual word 3–3.5× more often.

### 4.6 The owner's ear settled the objective

A 14-pair blind sitting. Every pair contained the artist's **real word** as one option against
phonology's **technically perfect rhyme** — the rater did not know which was which.

| option | "works" | "would keep" |
|---|---|---|
| the artist's real word | **86%** (CI 60–96) | **86%** |
| a perfect rhyme that isn't that word | **29%** (CI 12–55) | 14% |

**+57 points**, 12 of 14 pairwise, zero ties. **Semantics beat formal rhyme quality, decisively.**
So `exact` is validated as the optimization target; rhyme-perfection and depth are diagnostics, not
objectives. (Caveats: n=14, rater self-consistency 0.67 on repeats, no tracks played.)

### 4.7 The fusion attempt, and the plateau

Before building, we measured the ceiling: the artist's word is in the LLM's own top-5 **48.0%** of
the time and in the phonology menu **40.0%**, but in **either 64.7%** — the two sources miss
*different* words. That was +27 points on offer, and it justified building a fusion arm: phonology
proposes a wide pool, the LLM ranks it **on meaning** (rhyme is already guaranteed).

**It scored 37.3% — identical to the plain LLM.** And the null is fully explained:

| | pool v1 | pool v2 |
|---|---|---|
| artist's word present in pool | 56.0% | **63.3%** |
| reranker put it first | 64.3% | **58.9%** |

Widening the pool gained +7.3 points of coverage; reranker precision fell −5.4 points. They cancel:
**63.3% × 58.9% = 37.3%**, the observed number to the decimal.

**Reranker precision degrades as fast as pool coverage improves.** More options means a better
chance the right word is present and a worse chance of choosing it. The model also tried to answer
with a word that was never on offer on **32%** of items — it is straining against the format.

Two consecutive arms have now failed the pre-registered bar. **Prompt-side is declared plateaued.**
The best prompt-side arm sits at **37.3%** against a union-of-sources ceiling of **64.7%** and an
oracle of 100%.

---

## 5. Methodological failures — read this before trusting any number above

This program's recurring failure mode is **verification that cannot fail**. Listed because it
calibrates how much to trust each result, and because the pattern is likely to recur.

1. **Five separate instrument-vs-ear divergences.** Four envelope-family metrics and one ASR gate
   each showed improvement while the owner's ear got worse or flat. In one case the *known-bad*
   implementation scored best on the metric. Every automated metric in this project is now assumed
   guilty until an ear gate says otherwise.
2. **A judge panel that was theatre.** Three "independent" prompt lenses on one model agreed
   91–98% of the time. Replaced with five genuinely different models, which then disagreed by
   **27 points** on identical items (63% vs 36%). *Which model you ask is as large an effect as
   which arm you test* — so any "the LLM panel says X" claim is meaningless without calibration.
3. **Vacuous tests, repeatedly.** A guard that hides a song's identity passed a sabotage that
   deleted the hiding logic, because the test fixture had no identity to leak. A "perfect rhymes
   rank first" check passed because every frequent word in the fixture happened to be a perfect
   rhyme. Each needed a fixture that could actually exhibit the failure.
4. **A cache-replayed "fix."** An arm was fixed, re-run, and returned byte-identical results, which
   was honestly reported as "no effect." The cache key included the arm version, which had not been
   bumped — the old results replayed. The real effect was large (perfect-rhyme 15.5% → 94.5%).
5. **A flattering baseline.** The original floor answered with a frequent word that usually did not
   rhyme at all, scoring 0.0 and making every LLM arm look better than it was.
6. **An unseeded RNG** in the vocal render meant every round-to-round comparison in that lane's
   history was partly noise.
7. **Sittings that couldn't produce signal.** One drew all 64 pairs from a single song. Another
   produced 94% one-sided labels, which mathematically cannot elect anything. A third asked the
   owner to judge flow on songs so obscure he couldn't play them.

**Every one of these was caught by a human reading real output, never by a test.**

---

## 6. Where we are stuck

- **Vocal synthesis:** refuted at guide-grade. Word placement is solved; articulation/naturalness
  is not, and that's the binding constraint.
- **Lyrics:** prompt-side plateaued at 37.3% exact-match on rhyme-word infill, against a 64.7%
  two-source ceiling. The owner's ear has validated exact-match as the right target. The
  pre-registered condition for justifying a fine-tuning run has been met — but we have not yet
  done a literature review, and we may be about to spend real effort on the wrong thing.
- **Never measured:** whether any of this makes *better songs*. Every metric so far is a proxy.

## 7. What we're asking for

1. **A recommended next approach.** Given the plateau, what should actually happen — fine-tuning
   (and on what recipe: full FT, LoRA, DPO on the owner's accept/reject signal), a different model
   class, retrieval, constrained decoding, or something not considered. Concrete enough to build.
2. **State of the art and prior work.** We have built in a vacuum. Who has solved constrained lyric
   generation? What do rap-specific systems do? What does the literature say about rhyme-constrained
   decoding, style/voice transfer in text, and fine-tuning small models for stylistic register?
   Is there a reason to believe 64.7% is or isn't the real ceiling?
3. **A critique of the methodology.** Is masked-word infill against a held-out corpus even measuring
   "good lyrics"? Reproducing the artist's exact word is *not* the same as writing a good bar — the
   owner's sitting says the two correlate for him, on 14 pairs. Is that enough? What would a better
   benchmark look like? Is the whole cloze framing a dead end that happens to be easy to measure?
4. **Cheaper paths we skipped.** Constrained decoding / logit biasing against the phonology
   constraint at the token level; a local model where we control the decoder; better retrieval;
   n-best with a trained ranker. We may have jumped from prompting straight to "train a model"
   while skipping the middle.

**Bias toward telling us the framing is wrong, if it is.** The most valuable finding in this whole
document is a refutation, and the second-most valuable is a benchmark defect that inverted a
ranking. We would rather hear "you are measuring the wrong thing" now than after a training run.

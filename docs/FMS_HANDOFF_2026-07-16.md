# Finish-My-Song — Full Handoff for Reassessment (2026-07-16)

**What this is:** a self-contained brief for a fresh reviewer with no access to this repo.
It documents everything we have tried on the "Finish My Song" feature, every owner ear-verdict,
every dead end and why it died, and the exact mechanics of the two components the owner now
suspects. **The ask: diagnose why the finished renders still do not sound natural/human, and
propose a new approach — or at least a decisive diagnosis path.**

The owner's latest verdict, verbatim: *"the vocal does not sound natural/human … I think the
issue is the lyrics we're choosing and the timing we're assigning. The words is unnatural
possibly, I'm not super sure."*

---

## 1. The product goal

A producer records a **mumble take** — a melody sung with gibberish, partial words, la-las —
over a beat. The tool must:
1. **Assert real lyrics where there's mumble** (coherent bars that fit the take's flow), and
2. **Perform those lyrics** — return the take sung in the producer's **own voice**, sounding
   like a human performance of the words.

Owner's success criteria (stated explicitly): *"feels like mine" = my voice + coherent words +
my rhythm/timing.* Exact vowel/mouth sounds do NOT matter (measured + confirmed). Product
thesis: *"it doesn't matter if it's good if the user doesn't feel like it was their idea
brought to life."*

Current status: **voice identity is solved, word coherence is solved, beat-grid timing is
solved — and the result still reads as synthetic.** That gap is the assignment.

---

## 2. The current pipeline (six stages, all local on an M1 Max)

1. **Grid** — an energy-envelope syllable detector reads the mumble: hysteresis gate attacks +
   relative energy dips = syllable nuclei (slots); F0 (FCPE) re-derives melisma segments inside
   each slot; sub-100ms nuclei fold into neighbors (measured floor — see §4). Each slot carries
   `start/end/velocity/segments[{start,end,pitch}]`. Phrases split at ≥0.35s rests.
2. **Lyrics** — an LLM (Grok / grok-4.3) writes one line per phrase under hard constraints:
   EXACT syllable count (tolerance 0), breath boundaries (a word must END at any ≥70ms
   intra-phrase gap), rhyme scheme (phoneme-based, slant default), kept high-confidence mumble
   words locked in place. Soft ranking: stress-contour match (weight 0.75 of ~5 total),
   multisyllabic-rhyme bonus, filler penalty. Off-count lines are NEVER shipped — a
   deterministic count-exact filler line substitutes (marked `fallback`).
3. **Score author** — words map onto slots (policies in §6); each syllable's sung duration =
   its slot's measured duration, verbatim; per-segment pitch = median F0 of that segment,
   snapped to the song key (nearest, ties up), long holds capped at 1.5 beats. Output = the
   SoulX target score: phonemes (ARPAbet), MIDI note per segment, durations, note types
   (onset/continuation/rest). **No dynamics channel exists in the format.**
4. **Render** — SoulX-Singer (Apache-2.0 zero-shot SVS), score-conditioned, 30s enrollment
   reference of the owner's voice. Runs locally via an MLX-converted checkpoint through the
   official PyTorch bridge on MPS (~44s per 12.5s chunk). Scores are chunked ≤12s at
   continuation-safe boundaries; renders arrive self-placed on the take clock; plain-sum
   assembly.
5. **Timing snap** — phrase-level alignment (±250ms clamp) then per-word-event snap via
   envelope cross-correlation (±120ms clamp, 10ms crossfades) against the take. Currently
   achieves ~9ms median word alignment.
6. **Perform/re-vocode (NSF)** — PC-NSF-HiFiGAN vocoder resynthesizes the render from its mel +
   an explicit F0: `revoice` (render's own F0 — natural dynamics), `tune` (semitone-snapped),
   and `perform` (**the take's own measured F0 drives the pitch** — the owner's actual sung
   contour, within ~1Hz per phrase, verified). Weights CC BY-NC-SA → owner-local only.

Latest test vehicle: the "Used2" song's back half — a 56.5s mumble take with a KNOWN beat
(D major, 138bpm), rendered end-to-end through all six stages, served over the beat.
**Beat alignment confirmed on-grid by ear. Naturalness still fails.**

---

## 3. What is PROVEN and should not be re-litigated

- **Voice identity (SoulX zero-shot): GO** — formal kill-shot, blind ratings on 6/6 renders:
  *"sounds exactly like me"* from a **10-second** reference; sustained notes held. (Verdict doc
  2026-07-02-fms-killshot-a, results 2026-07-04.)
- **Grid extraction quality: GO** — against a 147-mark hand-annotated ground truth (the owner
  marked every syllable onset of the Used2 take in a purpose-built waveform annotator), the
  current detector scores F1@120ms 0.72, 11/17 phrases within ±1 syllable. An elaborate
  Basic-Pitch pruning ladder was measured WORSE than the simple energy detector and removed.
  Residual known gap: ornament-vs-syllable on held vowels is not decidable from DSP evidence
  (a 5-way discriminator sweep all failed); the human grid-confirm step is the designed absorber.
- **Word coherence** — early rounds produced word salad and all-filler bars; root causes found
  and fixed (see §5). Current draws are coherent, on-theme, count-exact.
- **Timing snap** — word events land at ~9ms median from the take's own events.
- **Fully local** — the whole loop runs on the Mac in ~10 minutes for a full take, $0.

---

## 4. Measured fixes that did NOT close the naturalness gap (chronological)

Each row: the owner's ear complaint → what we found/measured → the fix → the next verdict.

| Round | Complaint (owner) | Root cause found | Fix | Outcome |
|---|---|---|---|---|
| Sound-match era | "no correlation between mouth sounds" then "word salad" | We forced per-syllable vowel echo of the mumble (hard gate + top rank weight) — only filler could satisfy it | REMOVED sound-matching entirely; flow (count/stress/breath/rhyme) stays hard, words free to be coherent | Coherent words. Naturalness still off |
| Filler era | "oh oh oh yeah… can't be every word in the bar" | Our own fallback emitted whole-bar interjection filler on off-count lines | Filler cap ≤1/bar, filler-fraction penalty, rap-craft prompt, routed to Grok | Bars read like bars. Naturalness still off |
| Dynamics era | "very clearly artificially matched — I can hear the volume automation rather than the words ending naturally" | We gain-matched the take's envelope onto the render frame-by-frame (painted dynamics) | REMOVED envelope transfer; added NSF re-vocode (natural vocoder dynamics) | **"sounds much better, finally does not read as automated"** — the one certified naturalness win |
| Melody era | "high notes a whole step down" | Key-snap tiebreaker floored every off-key note downward | Nearest-with-ties-up snap; key certified D major by ear | Melody right. Naturalness still off |
| Squeeze era | "squeezing a bunch of words where a few should go" | The grid emitted 40–110ms nuclei; every slot gets a word; the author crams a syllable no singer can articulate | 100ms density floor (swept against the 147-mark truth: beats raw on every metric; 120ms ate real 16ths) | Zero unsingable slots. Naturalness still off |
| Perform era (latest) | "the vocal does not sound natural/human" | Stage 6 (NSF) wasn't running locally; and the score author flattens the take's F0 micro-contour to step-notes | Ran NSF revoice + tune; built NSF `perform` (render resynthesized at the take's own F0 — verified tracks the owner's contour within ~1Hz where the raw render deviated >1 semitone) | **Owner: still unnatural. New hypothesis: the LYRICS chosen and the TIMING assigned** |

**The key elimination:** the `perform` arm restores the owner's exact pitch contour and NSF
supplies natural vocoder dynamics — and it STILL reads synthetic. Pitch and loudness dynamics
are therefore largely exonerated. What remains is what the owner points at: **word choice and
word-timing structure.**

---

## 5. Dead ends — do not re-propose without new evidence

| Approach | Why it died |
|---|---|
| SoulX `--control melody` (condition on the real F0 contour instead of notes) | Garbles word intelligibility (upstream issue #33; local A/B artifacts confirm). Score mode kept |
| Envelope transfer (paint the take's loudness onto the render) | "I can hear the volume automation"; even a softened release-limited version "still reads automated" |
| Mouth/sound-matching (words must echo the mumble's vowels) | Forced sound-salad; owner: sounds don't matter, flow does |
| ACE-Step cover mode at word-preserving strengths | Provably just echoes the input back (0.78 waveform corr to the raw take) — an "echo trap," not a re-sing |
| ACE-Step as the word lane generally | Fills the singer's rests with generated band sounds; retired to sound-design duties |
| SoulX SVC (voice conversion) | Broken output in the kill-shot (2× length + clipping); also can't change WORDS by construction |
| Per-word ASR timing budgets | Whisper word-end timestamps land early on held notes → over-folds; per-phrase budgets only |
| Renting GPUs for renders | Obsolete — fully local now (MLX SoulX + NSF on the M1 Max) |

---

## 6. The two suspects, precisely (how lyrics are chosen; how timing is assigned)

### 6a. Lyric choice mechanics
- One line per detected phrase. Hard gates: syllable count EXACT (tol 0), every kept mumble
  word present in order, end-word rhyme (slant ok), **breath rule** (a word must end exactly at
  any ≥70ms intra-phrase gap), no dangling function-word endings.
- Soft ranking (after hard gates): stress-contour match to the take's velocity-derived
  X/x pattern (max +0.75), multisyllabic-rhyme depth (+0.5/extra syllable), filler penalty
  (−2.5 × excess interjection fraction). Craft rules in the prompt (punchline placement,
  concrete imagery, story across the couplet).
- If no candidate is count-exact after retries → a deterministic filler line ships (flagged).
- **What nothing evaluates: SINGABILITY.** No term asks whether the words are comfortable to
  SING at the assigned durations — open vowels on long holds, consonant-cluster density at
  speed, natural stress-to-length relationships (stressed syllables want to be LONGER; our
  slot durations are fixed by the mumble, independent of which word lands there).
- Observable symptom: count-exact pressure at tol 0 produces compressed "headline-ese"
  (real examples the owner approved but later suspected: "Fights we won feel like fake wins",
  "Heart raced fast till strangers", "back when laughs rang now they just ring hollow") —
  monosyllable-dense, article-dropped grammar that no one would SAY, let alone sing.

### 6b. Timing assignment mechanics
- Every syllable's sung duration = its slot's measured duration, verbatim and immutable.
  Slots come from energy nuclei of a MUMBLE — i.e., the articulation rhythm of vowel-blob
  gibberish, not of the actual words later asserted onto them.
- Word→slot policies: words==slots → 1:1; multi-syllable words consume that many slots
  (continuation glides, no re-attack); surplus words share the LAST slot evenly (each gets
  span/n — can be very fast); leftover slots hold the last word's vowel (sustain).
- The model then renders those exact durations; the post-snap can move a word at most ±120ms;
  NSF changes pitch/timbre character but not timing.
- **What nothing models: phrasing.** Humans do not give every syllable the duration of the
  nearest energy bump — they stretch stressed syllables, clip function words, connect words
  (coarticulation), breathe with intent, and push/pull against the grid. Our renders are a
  sequence of correctly-timed islands.

### 6c. An honest structural hypothesis for the reviewer to weigh
The grid is treated as a **specification** (the project's core thesis: "the take is a spec,
not a prompt"). That thesis is measurably right for BEAT-grid timing and phrase boundaries —
but the current implementation applies it at the **per-syllable** level: every detected energy
nucleus becomes a mandatory syllable slot with a mandatory duration. A mumble's syllable
rhythm is the rhythm of *mumbling*, and forcing real words (with their own consonant onsets,
stress-length physics, and grammar) into that exact micro-timing may be the unnaturalness —
even when every individual number is "correct." The owner's instinct ("the lyrics we're
choosing and the timing we're assigning") is pointing at exactly this joint.

---

## 7. Diagnosis experiments we'd suggest (cheap, decisive, in rough order)

1. **Isolate the words:** the owner (or anyone) SINGS a Grok-written line naturally over the
   beat. If a human performance of the same words sounds fine → words are not the core issue;
   if it's awkward in the mouth → singability/grammar of the lyric generation is implicated.
2. **Isolate the timing:** hand-write ONE phrase of natural lyrics, author it twice — (a) on
   the mumble-derived slot durations, (b) with hand-assigned natural durations (stressed long,
   function words short, same phrase span) — render both locally (minutes, $0). If (b) sounds
   human, the per-syllable duration transfer is the smoking gun.
3. **Loosen the unit:** author phrase-level scores where only the phrase START/END and the
   melody contour are constrained, letting SoulX place syllables freely inside the phrase
   (its native strength), then phrase-snap only. Compare against the current slot-exact render.
4. **Singability-aware writing:** add hard/soft terms for vowel-on-hold, consonant-cluster
   rate vs local tempo, stress-length agreement — regenerate the same take.
5. **Human reference A/B:** the existing page format (mumble / render / beat mixes) is set up
   for exactly these comparisons; all render infrastructure is local and fast.

---

## 8. Assets available (all local, all working today)

- **SoulX-Singer MLX** at `~/AI/soulx-mac` (bf16, MPS bridge, ~44s per 12.5s chunk), owner's
  enrolled 30s reference + preprocess metadata (no cloud preprocess needed).
- **PC-NSF-HiFiGAN** vocoder (`service/nsf/`): revoice / tune / **perform** (external-F0)
  modes, golden-tested. Weights CC BY-NC-SA → owner-local only; shipping requires self-training
  the MIT SingingVocoders trainer.
- **147-mark ground-truth grid** of the Used2 take + a browser waveform annotator (click-to-mark
  syllable onsets, word-strike, persistence) — the calibration oracle for any new detector.
- **Lyric engine** (`service/lyrics/`): phoneme-based phonology core (CMUdict+g2p), constraint
  validation, Grok/OpenAI backends, style-RAG on the owner's own accepted lines.
- **Measurement toolkit**: envelope correlation, per-word event lags, per-syllable duration
  audits, chunked render + assembly + snap, beat-bed page generation, DAW-kit export.
- **The audit gate**: lyrics are shown per-phrase (with the mumble clip + per-slot ms) for
  owner read/veto BEFORE any render.
- Known beat context for the test song: HUMAN1 instrumental, D major, 138bpm, back half
  enters at 55.06s, song = the 55.7s beat loop played twice.

## 9. Constraints

- macOS / Apple Silicon local-first; the owner's voice never leaves his machine.
- Licenses: SoulX Apache-2.0 (shippable); NSF weights CC BY-NC-SA (owner-only until
  self-trained); various rejected models for NC/ND weights — always verify WEIGHTS license.
- Disk is tight (~12GB free); no large new model downloads without cleanup.
- Grok (xAI) is the lyric backend (hip-hop register; GPT self-censors), OpenAI fallback.

---

*Prepared 2026-07-16 from the full project history (working notes, kill-shot verdicts,
round-by-round ear verdicts, and code-level extraction of the lyric/timing mechanics).*

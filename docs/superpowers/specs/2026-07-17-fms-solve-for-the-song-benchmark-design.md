# FMS-Bench — a ground-truth benchmark for the sing pipeline ("solve for the song")

**Status:** design approved (2026-07-17). Staged build; increment 1 first.
**Branch:** `claude/fms-solve-for-the-song-bench` (off the mechanism-verify tip).
**Supersedes/relates:** [2026-07-16-fms-mechanism-verify-design.md](2026-07-16-fms-mechanism-verify-design.md)
+ verdict — this is the next, larger effort those rounds pointed at.

## Problem

The FMS sing pipeline ("mumble → finished vocal in your voice") has been stuck on one
complaint across every ear round: the output "doesn't sound human." It is hard to fix
because the whole loop is **unanchored** — the owner listens, says better/worse, and there
is no reference to optimize toward. Worse:

- mechanism-verify **V3** caught a scalar (`env_corr`) moving *opposite* the ear (per-word
  snap raised the number while ranking worst by ear);
- **V2** showed that even feeding *oracle* (real-human) durations still read "synthetic."

So we tune against proxies with no ground truth, and a "better number" can mean a worse
sound. Every round is slow (owner-gated) and unfalsifiable at scale.

## The reframe (owner's idea)

Use PUBLIC singing vocals where the true words + timing are **known**; synthetically
**mumble** a controllable fraction of the words; run the pipeline on that mumble; and score
the generated vocal against the *original human vocal*. This gives us, for the first time:

1. a **real target** (an actual human finished vocal) to compare against;
2. a **difficulty dial** — the mumble ratio ρ — so we can say *where* the pipeline breaks;
3. a **fast automated loop** that ranks a change before the owner ever listens;
4. at the top tier, **supervised training data**.

## Goals / non-goals

**Goals**
- A trusted, deterministic benchmark that scores a generated vocal on two axes and produces
  a mumble-ratio curve.
- Reuse the existing measurement lab; add only the genuinely new pieces.
- License discipline strict enough that a *shippable* trained model is possible later.

**Non-goals (now)**
- Training a model (north star, but its own later spec — the benchmark de-risks it).
- Timing-perturbation curriculum (axis 2 — deferred; axis 1 is phonetic-only).
- Touching `--selftest` / the native gate (this is service-py + lab + flag-gated venvs).

## Decisions (locked via Q&A, 2026-07-17)

| # | Decision | Why |
|---|----------|-----|
| 1 | **Two metrics, tracked apart** — correctness (distance-to-reference) + naturalness (learned "sounds human") | Distance-to-reference supervises words+timing well but naturalness badly (two takes both human yet far apart); naturalness is the actual complaint, so a correctness win must not hide a naturalness loss |
| 2 | **North star = benchmark → train a shippable model** | Benchmark is the prerequisite and de-risks GPU spend; training is a later, separate spec |
| 3 | **Paired data = hybrid** — synthetic public for scale + real self-recorded pairs as trust anchor | Only a real-pair anchor catches synthetic-vs-real distribution shift before it wrecks a trained model |
| 4 | **Naturalness corpus = unpaired real vocals** | Never touches a mumble → zero synthesis risk on that half |
| 5 | **Benchmark shape = faithful audio-in (staged)** — degrade the WAVEFORM, run the FULL pipeline | The pipeline sees a real partial-mumble waveform, exactly like production; phonetic-only first, timing perturbation later |

## Key finding — the net-new surface is small

The correctness metrics already exist. `scripts/fms-killshot/overlap.py` is effectively a
vocal-comparison library, and it compares two vocals *today* (render vs take) — the
benchmark just re-points it at render vs **ground-truth vocal**:

| Instrument | File | Measures |
|---|---|---|
| `onset_agreement` | overlap.py | timing accuracy (P/R/F1, median ms) |
| `f0_compare` | overlap.py | pitch/register error (median semitones, octave-error rate) |
| `score_conformance` | overlap.py | sang-the-right-notes-at-the-right-times |
| `word_match` | overlap.py | lexical accuracy (sequence ratio, bag coverage) |
| `silence_energy` | overlap.py | invented vs dropped energy |
| `vowel_onset_report` | vowel_landmark.py | vowel-onset delta, dur ratio, squeeze frac |

Naturalness: `service/sa3/qa.py` already runs Audiobox `pq` (permissive), and **SingMOS-Pro**
(CC-BY, singing-specific) is the singing-tuned upgrade. So genuinely new = the **mumble
synthesizer**, the **data layer**, and the **scoreboard**.

## Licensing (load-bearing — a shippable trained model is the north star)

**Datasets** (isolated vocals + aligned lyrics). Research-only sets are fine for the internal
**benchmark**; only permissive sets can feed a **shippable** trained model.

| Commercial-training OK (permissive) | License |
|---|---|
| **GTSinger** (~100+ hrs, 13+ langs, phoneme scores) | "free-to-use" — verify terms before marking `train_ok` |
| **VocalSet** (~10 hrs, EN) | CC BY 4.0 |
| **PJS** (JA) | CC BY-SA 4.0 |
| **JVS-MuSiC** (JA) | CC (permissive) |

| Internal-eval / research-only (NOT for a shipped model) |
|---|
| NUS-48E, NHSS, M4Singer, OpenSinger, CSD, DAMP/DSing, Opencpop, PopCS, Kiritan, Ofuton, MTG-Jamendo, Isophonics |

**Naturalness metrics** (learned "sounds human"):

| Metric | Singing-specific? | License | Ship? |
|---|---|---|---|
| **SingMOS-Pro** | yes | CC-BY 4.0 | ✓ |
| **Audiobox Aesthetics** (`pq`, already in repo) | works on singing | CC-BY 4.0 + MIT | ✓ |
| UTMOS v2 | speech-tuned | MIT | ✓ |
| NISQA | speech | code MIT, **weights NC** | ✗ (weights) |

## Design

Name: **FMS-Bench** ("solve-for-the-song"). Harness code in the repo; datasets + generated
artifacts OUTSIDE git (size + license — the `~/mosh-fms-ksb` discipline).

### A. Data layer (license-tiered, fail-closed)
Registry JSON (in git) per dataset: local path (outside git), license, `train_ok: bool`. A
per-dataset normalizer → `{clean_vocal.wav (isolated mono), words:[{word,start,end}],
phonemes?, singer_id, language, license_tier}`. Start with ONE eval dataset (NUS-48E:
English, phoneme-aligned) to prove the harness; add a train-OK dataset later.

### B. Mumble synthesizer (the one net-new DSP component)
- **Word selection** (pure, golden-tested, seed-deterministic): mumble a fraction ρ of
  words, biased toward function/unstressed words first (real mumbles keep the stressed
  content — reuses the confidence intuition in `service/lyrics/mumble.py`).
- **Phonetic degradation** (axis 1): obscure consonant/phonetic identity on selected spans
  while **preserving F0 + energy envelope** (rhythm/melody the singer intends). Real-mumble
  principle: *stressed vowels + rhythm survive; consonants + weak syllables blur.* DSP:
  scipy `butter` band-limit + spectral-envelope flattening / formant-smear (new code — no
  audio-obscuration exists; `fake_adapter`'s one-pole LP + tanh are the only primitives).
- **Timing perturbation** (axis 2, deferred).
- **Self-consistency check (the realism proxy):** run Whisper on the synthesized mumble and
  confirm degraded words drop below the `conf 0.6` gate while kept words stay above — the
  synthesizer produces mumbles the *pipeline* reads as mumbles at the target ρ. Backed by a
  `waveform_compare` panel (F0/energy survived, phonetics blurred).

### C. Benchmark runner
Per item × ρ: `mumbled_input.wav` → full production sing path (skeleton grid → lyrics →
SoulX → phrase-snap → NSF) → `generated_vocal.wav`. **Two lyric modes** (decomposes the word
axis — at high ρ the pipeline *invents* lyrics that can't match ground truth):
- **oracle-lyrics** — feed the true words: isolates timing + sing + naturalness.
- **free-lyrics** — production; word-correctness scored only where words were detectable.
Score `generated` vs `clean` with the correctness bundle + naturalness (`pq` + SingMOS-Pro
on `generated` alone). Emit per-item stats JSON + a `waveform_compare.render_panel` panel
with the **clean vocal as the reference lane**.

### D. Scoreboard / curriculum
Aggregate across items × ρ → metric-vs-mumble-ratio curves. HTML page (reuse
`preview_server.py` + the `b1-listen` pattern): curves + per-item panels + audio players
(clean / mumbled-input / generated).

### E. Real-pairs trust anchor (hybrid's other half)
A small owner-recorded set of real (mumble→finished) pairs scored by the SAME metrics.
Meta-check: **does the metric ordering on synthetic pairs agree with the owner's ear on the
real pairs?** Catches the V3 failure mode for the *whole* benchmark, not one scalar.

### F. Metric-validity gate (registered prediction, before trusting the ruler)
Register predictions, then require the bundle to (a) rank a known-good render above a
known-bad one, (b) agree with the owner ear on the real pairs, (c) be deterministic ×N. Only
a benchmark that passes earns the right to gate pipeline changes.

### G. Training lane (DEFERRED — its own spec)
Once trusted: train/fine-tune on **train-OK tier only** (license fail-closed), benchmark as
eval.

## Reuse map
- Correctness: `scripts/fms-killshot/overlap.py`, `vowel_landmark.py`,
  `service/soulx/perform.py` (`energy_envelope`, `env_corr`).
- Naturalness: `service/sa3/qa.py` (`pq`/Audiobox) + new SingMOS-Pro wrapper (own venv).
- Detection: `service/whisper/whisper_cli.py`, `service/lyrics/mumble.py` (`conf_threshold`).
- Grid: `service/skeleton/core.py`. Render: `service/adapters/soulx_adapter.py` +
  `service/soulx/score.py`.
- Visual: `service/viz/waveform_compare.py` (`render_panel`). Probes:
  `scripts/fms-killshot/fcpe_probe.py`, `align_probe.py`. Serving: `preview_server.py`.

Local env (2026-07-17): correctness venvs live here (skeleton=FCPE+MMS_FA, whisper=ASR,
nsf=pyin, teardown=numpy/scipy/PIL); **no** `judges`/pq venv, **no** `singmos` venv yet →
naturalness degrades gracefully until those are set up (real→fake posture).

## Staging (measure-first, YAGNI)
1. **Metric spine + real-pairs anchor** — one `score_vocal(reference, generated, score?) →
   stats` wiring the existing instruments + `pq` + SingMOS-Pro (graceful-degrade). Validate
   on real self-recorded pairs + a known-good/known-bad sanity pair. **Registered
   metric-validity gate.** Prove the ruler before scaling data.
2. **Mumble synthesizer + one dataset** — synthesizer (phonetic-only), normalize NUS-48E,
   verify the Whisper-confidence-drop property, run faithful audio-in on a small slice,
   scoreboard + panels.
3. **Curriculum + scale** — mumble-ratio sweep, add a train-OK dataset, curves; timing
   perturbation (axis 2).
4. **Training lane** — deferred, separate spec, train-OK tier only.

## Constraints / discipline
- Datasets + generated artifacts **never in git** — under `~/mosh-fms-ksb/` (or
  `~/Library/Mosh`); only harness code + registry + goldens in git.
- License tier enforced **fail-closed** for training.
- New venv for SingMOS-Pro at `~/Library/Mosh/venvs/singmos` (outside iCloud).
- Nothing touches `--selftest` / native gate; existing suites green ×3.
- Pure cores golden-tested ×3-deterministic; registered predictions before the validity
  verdict.

## Open questions (resolve during implementation)
- Exact phonetic-degradation DSP that fools ASR while preserving F0/energy — tune against
  the Whisper-confidence-drop property + `waveform_compare` panels.
- SingMOS-Pro packaging (weights size, arm64-mac wheel) — a setup script + graceful skip.
- Whether `pq`/Audiobox is worth standing up locally now or deferred to the owner's box.
- Owner dependency: the real self-recorded pairs (E) require the owner to record; increment
  1 builds everything else and stubs/synthesizes the sanity pair until then.

## Verification
- **Metric spine:** aggregation golden ×3-det; metric-validity gate (good > bad, agrees with
  owner ear on real pairs, deterministic ×N).
- **Mumble synth:** word-selection golden ×3-det; Whisper-confidence-drop holds;
  `waveform_compare` panel shows F0/energy preserved, phonetics blurred.
- **Benchmark run:** end-to-end on a small NUS-48E slice; scoreboard served; oracle vs free
  lyric modes reported apart.
- **Whole:** soulx/lyrics/skeleton/viz suites green ×3; `--selftest` unaffected.

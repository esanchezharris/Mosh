# FMS-Bench increment 2 — mumble synthesizer verdict (2026-07-17)

Increment 2 of the [FMS-Bench design](2026-07-17-fms-solve-for-the-song-benchmark-design.md):
the one genuinely net-new component — a synthesizer that turns a CLEAR vocal into a realistic
**mumble** (ASR can't read the words; pitch + rhythm survive). Built + validated against a
real substrate; the dataset half (2b) is download-gated (see end).

## Substrate + ruler
- Substrate: `AB-matrix/2-mainvox-clear-TAKE.wav` (a clear 33.8 s sung take) → Whisper `small`
  baseline: **54 words, median confidence 0.94** (a clean reference to degrade).
- Ruler: `scripts/fms-killshot/mumble_probe.py` — a good mumble = ASR confidence DROPS on the
  degraded words while **F0 (pitch)** and the **energy envelope (rhythm)** are preserved on
  those spans. Sanity: an 800 Hz lowpass gives conf_drop 0.46, energy 0.94, F0 Δ 0.1 st.

## Design panel (4 methods, measured, then adversarially verified)
A parallel workflow had four agents each implement + measure a distinct degradation method
through the shared ruler:

| method | conf_drop (orig spans) | degraded_conf | energy | F0 Δst | voiced_kept |
|---|---|---|---|---|---|
| **formant_shift** (cepstral flatten + phase-rand) | **0.735** | 0.234 | 0.972 | 0.2 | 0.993 |
| lpc_whiten (LPC residual whitening) | 0.722 | 0.246 | 0.989 | 0.1 | 0.957 |
| chan_vocode (few-band vocoder) | 0.622 | 0.346 | 0.986 | 0.1 | 0.919 |
| env_smear (temporal envelope smear) | 0.603 | 0.365 | 0.983 | 0.1 | 0.960 |

**Adversarial verify caught overfit.** Re-run on a FRESH 12-word set, `formant_shift`'s
F0/energy reproduced (E 0.978, F0 Δ 0.2) but its ASR drop fell 0.735 → **0.565** and residual
intelligibility nearly doubled. So the headline number was optimistic. A fair **head-to-head**
of the top two on the *same* fresh spans settled it:

| method (fresh spans) | conf_drop ↑ | degraded_conf ↓ | energy | voiced_kept ↑ |
|---|---|---|---|---|
| **formant_shift** | **0.565** | **0.414** | 0.978 | **0.954** |
| lpc_whiten | 0.447 | 0.533 | 0.989 | 0.825 |

`formant_shift` wins the primary axis (words more unintelligible) *and* keeps pitch trackable
on more frames (0.95 vs 0.83). Chosen.

## The mechanism (measured, not guessed)
Cepstral flattening ALONE barely dented ASR (drop 0.185) — Whisper reads words from
**phase-carried** consonant/formant transitions. The lever is **full excitation-phase
randomization**: scrambling phase annihilates that structure (ASR dies) while **pyin/YIN F0 is
autocorrelation-based = power-spectrum-only = phase-blind**, so pitch survives via the kept
harmonic comb in the magnitude. lp_hz has a plateau at 1650–1850 Hz (chose 1750; lower
*reverses* the gain as Whisper latches onto the low buzz). Q_HIGH=40 flattens the formant
envelope while leaving the pitch comb (q≈240) untouched.

## Integration (`bench_mumble.py`)
- Pure stdlib **word selection** (`select_mumble_words`): mumble a fraction ρ, function/short/
  unstressed words FIRST (a real mumble keeps content words clearer); seeded-deterministic;
  golden ×3.
- The winning **`degrade()`** DSP (lazy numpy/scipy/librosa), applied only inside selected
  spans (raised-cosine crossfade, bit-clean outside).
- Smoke (ρ=0.4 on the 54-word take): mumbled words → **0.53 (below the 0.6 pipeline confidence
  gate)**, kept words 0.73 (above) — i.e. the synthetic mumble reads as a mumble to the
  pipeline; F0 median Δ 0.2 st, energy 0.99; audio **seed-deterministic**. (Low-ρ selects
  function words, which start at lower confidence, so the *drop* is smaller than for the
  high-confidence content words in the head-to-head — honest, expected.)

## Visual confirmation
`mumble_panel.png` / `_zoom.png` (clean vs mumbled, waveform + log-mel; `~/mosh-fms-ksb/bench/
substrate/`): waveforms near-identical (rhythm/energy preserved), the low harmonic comb
preserved in both mels. The magnitude spectrogram looks *similar* precisely because it can't
show phase — and phase is where the degradation lives. Magnitude (pitch+rhythm) intact, phase
(intelligibility) destroyed: the mechanism, made visible.

## What's done vs gated
- **Done (2a):** the mumble synthesizer + its realism ruler, validated on a real clear vocal.
- **Gated (2b):** the dataset normalizer (NUS-48E → common item shape) + the faithful audio-in
  benchmark run needs the dataset downloaded (research-only license → internal eval only).
  Owner call: OK the NUS-48E download, or point at an existing aligned-vocal corpus.
- **Owner-gated (spec §E):** the real (mumble→finished) pairs + naturalness-on-real-vocals.

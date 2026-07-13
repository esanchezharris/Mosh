# PC-NSF-HiFiGAN resynthesis spike — design + integration brief (2026-07-12)

## Why

The Used2 vocal pipeline generates a sung take from a score (SoulX), which carries **no
dynamics channel** — so the model invents its own volume/attack/decay and we paint the
take's envelope back on afterward (`service/soulx/perform.py::transfer_envelope`). The owner
hears that as "volume automation rather than the words ending naturally." A **release-fade
bridge** softened it (this round), but the honest fix for *native* dynamics + artifact-free
pitch is a **resynthesis** approach: reconstruct the vocal from a mel-spectrogram + an
explicit F0 contour, so pitch and (via the mel) delivery come from real audio, not gain
automation.

The owner flagged the [@KRTK_12 "HachiTune 2" demo](https://x.com/KRTK_12/status/2075578616667320512),
which uses **PC-NSF-HiFiGAN** (Pitch-Controllable Neural Source-Filter HiFi-GAN). Owner
decision: **bridge now + spike this in parallel**. This doc is the spike's research
deliverable; the prototype build is gated on the owner's reaction to the bridge + the
pitch-fixed pod render.

## What PC-NSF-HiFiGAN is (confirmed legit)

A neural vocoder that resynthesizes a waveform from `(mel-spectrogram, F0)`. The "PC" =
pitch-controllable: feed a **different** F0 than the mel's original and it re-sings at the
new pitch with formant preservation (WORLD-style), no autotune smear, up to **±12 semitones**
before quality degrades. It's the standard vocoder in the DiffSinger / so-vits-svc / UTAU
ecosystems. Exact-our-use-case precedent: **[hifisampler](https://github.com/openhachimi/hifisampler)**
(mel from a real recording + a supplied pitch curve → resynth at new pitch/timing).

## Integration contract (exact numbers — the "garbage audio" risk lives here)

- **Checkpoint:** OpenVPI `pc-nsf-hifigan-44.1k-hop512-128bin-2025.02`
  ([release](https://github.com/openvpi/vocoders/releases/tag/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02),
  ~52 MB `.pth` + sibling `config.json`; a `.oudep`/`.zip` asset also carries an ONNX build).
- **Mel config (must match the checkpoint EXACTLY):** `sample_rate=44100`, `n_fft=2048`,
  `win_length=2048`, `hop_length=512`, `n_mels=128`, `fmin=40`, `fmax=16000`, Hann window,
  reflect-pad `(win-hop)//2`, dynamic-range compression `log(clamp(x, 1e-5))` (**natural log**;
  hifisampler stores log10 then the wrapper re-multiplies by `ln(10)` — pick one base and be
  consistent). Frame rate = 44100/512 ≈ **86.13 fps** (F0 must be frame-aligned to the mel).
- **Inference:** `generator(mel[1,128,T], f0[1,T]) -> wav[44100 Hz mono]`. No pip package —
  port ~150 lines: mel extractor from DiffSinger `modules/nsf_hifigan/nvSTFT.py` or
  hifisampler `util/wav2mel.py`; generator loader from DiffSinger `modules/nsf_hifigan/models.py`.
- **Deps (vocoder-only):** `torch, numpy, librosa` (+ `onnxruntime` for the CoreML path).
  NOT DiffSinger's full stack (no parselmouth/pyworld/lightning).
- **Hardware:** model is small + fast. Proven Apple-Silicon path = **ONNX Runtime + CoreML**
  (what HachiTune ships); raw `torch.device("mps")` is unproven. Rented CUDA pod = plain torch.

## Licence gate (load-bearing)

- **Code** (DiffSinger Apache-2.0, SingingVocoders MIT): ship-able.
- **Official weights: CC BY-NC-SA 4.0 — NON-commercial, share-alike, attribution.** This
  blocks bundling them in Mosh (a commercial product). Treat exactly like the SA3 / ACE-Step
  precedent: **spike/owner-only lane, never shipped**, unless (a) a checkpoint is self-trained
  from the MIT `SingingVocoders` trainer on rights-cleared data, or (b) explicit permission.
  (A HF mirror tags it `apache-2.0` — that is almost certainly a mislabel; do not rely on it.)

## Prototype architecture (when green-lit)

Carve-out `service/nsf/` mirroring `service/transform/` + `service/skeleton/`:
- `setup-nsf.sh` → isolated venv at `~/Library/Mosh/venvs/nsf` + `.nsf.env` (torch, numpy,
  librosa; or onnxruntime for CoreML). Owner-gated; weights dropped at `~/AI/pc-nsf-hifigan/`.
- `nsf_cli.py` — ported `wav2mel` (exact config above) + generator loader + a `resynth(wav,
  f0)` call. Stdlib-`wave` I/O (avoid torchaudio/ffmpeg, the transform-lane lesson).
- **Round-trip golden** (the mel-config fidelity guard, mirrors FCPE/Basic-Pitch goldens):
  extract a known wav's mel + its OWN measured F0 → resynth → assert the output ≈ the input
  (spectral distance under a floor). A log-base or n_fft mismatch fails this loudly instead of
  shipping garbage.
- **Spike harness** (`scripts/fms-killshot/`, nothing under `~/mosh-fms-ksb` in git): take the
  SoulX T1/T2 render → extract mel → drive with the **take's key-corrected F0 contour**
  (measured melody, Part-1 snap) → resynth. A/B: soft-lock render vs NSF-resynth render.
- Optionally probe whether the mel should come from the **take** (dynamics native) vs the
  **render** (words native) — the core words-vs-performance tension. Likely: render's mel
  (SoulX's correct words) + take's F0 (correct pitch), accepting SoulX's delivery, and drop
  the envelope transfer entirely if the resynth's dynamics already read natural.

## Verification / gate

Legitimacy: **confirmed** (this doc). Prototype: round-trip golden green → one owner A/B
(soft-lock vs NSF-resynth) → verdict. Ship decision blocked on the licence until a self-trained
checkpoint exists. Sources: openvpi/vocoders, openvpi/DiffSinger, openvpi/SingingVocoders,
openhachimi/hifisampler, KCKT0112/HachiTune.

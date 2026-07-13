#!/usr/bin/env python3
"""PC-NSF-HiFiGAN resynthesis CLI (spike lane).

Resynthesize a wav from its mel at an explicit F0 — the vocoder's headline: hand it a
DIFFERENT (corrected) pitch contour and it re-sings at the new pitch, formant-preserving,
no autotune smear. Two modes prove the technique on a real render:
  revoice : resynth at the render's OWN measured F0 (a clean re-vocode baseline)
  tune    : resynth at that F0 snapped to the nearest semitone (dead-in-tune, no artifacts)

F0 comes from the input itself (librosa.pyin) so it is perfectly frame-aligned to the mel —
zero pitch-misalignment risk. Weights are CC BY-NC-SA (spike/owner-only, never shipped).

Run under the nsf venv:
  ~/Library/Mosh/venvs/nsf/bin/python3 service/nsf/nsf_cli.py <in.wav> <out.wav> [revoice|tune]
"""
from __future__ import annotations

import math
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import librosa  # noqa: E402
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

import nsf_vocoder as nsf  # noqa: E402


def model_path():
    env = os.environ.get("NSF_MODEL")
    if env:
        return pathlib.Path(env)
    return (pathlib.Path.home() / "AI/pc-nsf-hifigan"
            / "pc_nsf_hifigan_44.1k_hop512_128bin_2025.02" / "model.ckpt")


def measure_f0(y, sr, hop, fmin=65.0, fmax=1000.0):
    """Per-frame F0 (Hz), hop-aligned to the mel; unvoiced -> 0."""
    f0, voiced, _ = librosa.pyin(y, sr=sr, fmin=fmin, fmax=fmax,
                                 frame_length=2048, hop_length=hop, center=False)
    f0 = np.nan_to_num(f0, nan=0.0)
    f0[~voiced] = 0.0
    return f0.astype(np.float32)


def snap_semitone(f0):
    """Snap each voiced F0 to the nearest equal-tempered semitone (dead-in-tune)."""
    out = f0.copy()
    v = f0 > 0
    midi = np.round(69.0 + 12.0 * np.log2(f0[v] / 440.0))
    out[v] = 440.0 * (2.0 ** ((midi - 69.0) / 12.0))
    return out.astype(np.float32)


def resynth(in_wav, out_wav, mode="revoice"):
    gen, h = nsf.load_model(model_path())
    sr, hop = h.sampling_rate, h.hop_size
    y, in_sr = sf.read(str(in_wav), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if in_sr != sr:
        y = librosa.resample(y, orig_sr=in_sr, target_sr=sr).astype(np.float32)
    peak = float(np.max(np.abs(y))) or 1.0
    y = y / peak * 0.9
    stft = nsf.STFT(sr=sr, n_mels=h.num_mels, n_fft=h.n_fft, win_size=h.win_size,
                    hop_length=hop, fmin=h.fmin, fmax=h.fmax)
    yt = torch.from_numpy(y).float().unsqueeze(0)
    mel = stft.get_mel(yt)                                  # [1, 128, T]
    f0 = measure_f0(y, sr, hop)
    # align f0 length to the mel's frame count
    T = mel.shape[-1]
    if len(f0) < T:
        f0 = np.pad(f0, (0, T - len(f0)))
    f0 = f0[:T]
    if mode == "tune":
        f0 = snap_semitone(f0)
    with torch.no_grad():
        wav = gen(mel, torch.from_numpy(f0).float().unsqueeze(0)).squeeze().cpu().numpy()
    p = float(np.max(np.abs(wav))) or 1.0
    if p > 0.99:
        wav = wav * 0.99 / p
    sf.write(str(out_wav), wav.astype(np.float32), sr)
    voiced_pct = 100.0 * float(np.mean(f0 > 0))
    print(f"{mode}: {in_wav.name if hasattr(in_wav,'name') else in_wav} -> {out_wav} "
          f"({len(wav)/sr:.1f}s @ {sr}, {voiced_pct:.0f}% voiced, peak {p:.2f})", flush=True)
    return out_wav


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: nsf_cli.py <in.wav> <out.wav> [revoice|tune]")
    resynth(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]),
            sys.argv[3] if len(sys.argv) > 3 else "revoice")

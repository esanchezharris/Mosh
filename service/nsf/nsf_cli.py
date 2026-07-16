#!/usr/bin/env python3
"""PC-NSF-HiFiGAN resynthesis CLI (spike lane).

Resynthesize a wav from its mel at an explicit F0 — the vocoder's headline: hand it a
DIFFERENT (corrected) pitch contour and it re-sings at the new pitch, formant-preserving,
no autotune smear. Modes:
  revoice : resynth at the render's OWN measured F0 (a clean re-vocode baseline)
  tune    : resynth at that F0 snapped to the nearest semitone (dead-in-tune, no artifacts)
  perform : resynth at the TAKE's measured F0 — the owner's actual sung performance drives
            the pitch (the render must already be timing-snapped to the take); where the
            take is silent the render's own F0 is the fallback, so no voiced frame goes
            unpitched mid-word. 3-frame median at source handoffs kills switch clicks.

F0 comes from audio via librosa.pyin on the mel's own hop grid — zero misalignment risk.
Weights are CC BY-NC-SA (spike/owner-only, never shipped).

Run under the nsf venv:
  ~/Library/Mosh/venvs/nsf/bin/python3 service/nsf/nsf_cli.py <in.wav> <out.wav> [revoice|tune]
  ~/Library/Mosh/venvs/nsf/bin/python3 service/nsf/nsf_cli.py <in.wav> <out.wav> perform <take.wav>
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


def combine_take_f0(render_f0, take_f0):
    """Take-voiced frames win; take-silent frames keep the render's own F0. A 3-frame
    voiced-median around each source handoff smooths the switch (no pitch clicks)."""
    n = len(render_f0)
    take = np.zeros(n, dtype=np.float32)
    take[: min(n, len(take_f0))] = take_f0[:n]
    out = render_f0.copy()
    use = take > 0
    out[use] = take[use]
    for s in np.flatnonzero(np.diff(use.astype(np.int8)) != 0):
        lo, hi = max(0, s - 1), min(n, s + 2)
        seg = out[lo:hi]
        voiced = seg[seg > 0]
        if len(voiced):
            seg[seg > 0] = np.median(voiced)
            out[lo:hi] = seg
    return out.astype(np.float32)


def _load_mono(path, sr):
    y, in_sr = sf.read(str(path), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if in_sr != sr:
        y = librosa.resample(y, orig_sr=in_sr, target_sr=sr).astype(np.float32)
    return y


def resynth(in_wav, out_wav, mode="revoice", f0_wav=None):
    if mode == "perform" and f0_wav is None:
        raise ValueError("perform mode needs the take wav (f0_wav) — its F0 drives the pitch")
    gen, h = nsf.load_model(model_path())
    sr, hop = h.sampling_rate, h.hop_size
    y = _load_mono(in_wav, sr)
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
    elif mode == "perform":
        take_f0 = measure_f0(_load_mono(f0_wav, sr), sr, hop)
        f0 = combine_take_f0(f0, take_f0)
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
        raise SystemExit("usage: nsf_cli.py <in.wav> <out.wav> [revoice|tune|perform <take.wav>]")
    resynth(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]),
            sys.argv[3] if len(sys.argv) > 3 else "revoice",
            f0_wav=pathlib.Path(sys.argv[4]) if len(sys.argv) > 4 else None)

#!/usr/bin/env python3
"""Take-vs-render waveform + spectrogram comparison panels — the "true-to-the-mumble"
visual instrument.

Stacks, on a shared time axis: the mumble TAKE waveform, the RENDER waveform, and both
as log-mel spectrograms, with vowel-onset + phrase-boundary markers read from the SoulX
score (the take is the spec — you see whether the render's energy and pitch land where the
mumble's do). A human-read visual is a harder-to-game instrument than a scalar: it shows
alignment (envelope tracking), click-type artifacts (waveform spikes), AND sustained
spectral artifacts (broadband spectrogram streaks) that an envelope alone would miss.

Pure numpy for peaks / mel / stats (golden-tested); PIL for the panel (no matplotlib —
headless-hostile on Mac). Markers come from soulx.score (service-internal; no scripts/
import). Runs under a venv with numpy + scipy + Pillow (+ soundfile/librosa for I/O):
  ~/Library/Mosh/venvs/teardown/bin/python  (dev) or the dedicated service/viz venv.
"""
from __future__ import annotations

import math
import os
import sys
from typing import Dict, List, Optional, Tuple

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))            # service/  -> soulx.score

# ── mel config (mirror service/nsf/nsf_vocoder.py::STFT — what the vocoder itself sees) ─
SR = 44100
N_FFT = 2048
HOP = 512
N_MELS = 128
FMIN = 40.0
FMAX = 16000.0

# ── pure numeric core (golden-tested) ──────────────────────────────────────────────────


def peak_buckets(y: np.ndarray, width: int) -> Tuple[np.ndarray, np.ndarray]:
    """min/max per time bucket — the canvas-waveform bucketing (mirrors get_clip_peaks).
    Returns (mins, maxs), each length `width`. Empty/short signals pad with zeros."""
    width = max(1, int(width))
    if y.size == 0:
        return np.zeros(width), np.zeros(width)
    idx = np.linspace(0, y.size, width + 1).astype(int)
    mins = np.zeros(width, dtype=np.float64)
    maxs = np.zeros(width, dtype=np.float64)
    for i in range(width):
        a, b = idx[i], max(idx[i] + 1, idx[i + 1])
        seg = y[a:min(b, y.size)]
        if seg.size:
            mins[i] = float(seg.min())
            maxs[i] = float(seg.max())
    return mins, maxs


def _mel_filterbank(sr: int, n_fft: int, n_mels: int, fmin: float, fmax: float) -> np.ndarray:
    """Slaney-style mel filterbank [n_mels, n_fft//2+1], pure numpy (no librosa needed at
    panel time; matches librosa.filters.mel norm='slaney' closely enough for a diagnostic)."""
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    n_bins = n_fft // 2 + 1
    fft_freqs = np.linspace(0, sr / 2.0, n_bins)
    mel_pts = np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2)
    hz_pts = mel_to_hz(mel_pts)
    fb = np.zeros((n_mels, n_bins), dtype=np.float64)
    for m in range(1, n_mels + 1):
        lo, ctr, hi = hz_pts[m - 1], hz_pts[m], hz_pts[m + 1]
        left = (fft_freqs - lo) / max(ctr - lo, 1e-9)
        right = (hi - fft_freqs) / max(hi - ctr, 1e-9)
        fb[m - 1] = np.clip(np.minimum(left, right), 0.0, None)
        norm = hz_pts[m + 1] - hz_pts[m - 1]
        if norm > 0:
            fb[m - 1] *= 2.0 / norm
    return fb


def mel_db(y: np.ndarray, sr: int = SR, n_fft: int = N_FFT, hop: int = HOP,
           n_mels: int = N_MELS, fmin: float = FMIN, fmax: float = FMAX) -> np.ndarray:
    """log-mel magnitude spectrogram [n_mels, T], pure numpy STFT. Deterministic."""
    if y.size < n_fft:
        y = np.pad(y, (0, n_fft - y.size))
    window = np.hanning(n_fft).astype(np.float64)
    n_frames = 1 + (y.size - n_fft) // hop
    frames = np.stack([y[i * hop:i * hop + n_fft] * window for i in range(max(1, n_frames))])
    spec = np.abs(np.fft.rfft(frames, n=n_fft, axis=1)).T          # [n_bins, T]
    fb = _mel_filterbank(sr, n_fft, n_mels, fmin, fmax)
    mel = fb @ spec                                                # [n_mels, T]
    return np.log(np.clip(mel, 1e-5, None))


def rms_envelope(y: np.ndarray, sr: int, hop_ms: float = 10.0) -> np.ndarray:
    """Per-hop RMS energy contour."""
    hop = max(1, int(sr * hop_ms / 1000.0))
    n = max(1, y.size // hop)
    return np.array([math.sqrt(float(np.mean(y[i * hop:(i + 1) * hop] ** 2)) + 1e-12)
                     for i in range(n)])


def env_corr(a: np.ndarray, b: np.ndarray, sr: int, hop_ms: float = 10.0) -> float:
    """Pearson correlation of the two RMS envelopes (take vs render alignment scalar)."""
    ea, eb = rms_envelope(a, sr, hop_ms), rms_envelope(b, sr, hop_ms)
    n = min(len(ea), len(eb))
    if n < 2:
        return 0.0
    ea, eb = ea[:n] - ea[:n].mean(), eb[:n] - eb[:n].mean()
    da, db = math.sqrt(float(ea @ ea)), math.sqrt(float(eb @ eb))
    return float(ea @ eb / (da * db)) if da and db else 0.0


def click_spikes(y: np.ndarray, sr: int, thresh: float = 0.6,
                 dedup_s: float = 0.05) -> List[float]:
    """Timestamps (s) of sample-to-sample discontinuities above `thresh` — the click/squeak
    signature (a phase-reset transient or a burst of high-frequency oscillation). Bursts of
    adjacent outliers collapse to one timestamp per `dedup_s` window so a sustained squeak
    reads as one mark, not hundreds. Deterministic; a diagnostic annotation."""
    if y.size < 2:
        return []
    d = np.abs(np.diff(y))
    hits = np.flatnonzero(d > thresh)
    out: List[float] = []
    last = -1e9
    for i in hits:
        t = i / sr
        if t - last >= dedup_s:
            out.append(round(t, 3))
            last = t
    return out


# ── I/O + panel rendering (needs soundfile/librosa + PIL) ───────────────────────────────


def load_mono(path: str, sr: int = SR) -> np.ndarray:
    import soundfile as sf
    y, in_sr = sf.read(path, dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    if in_sr != sr:
        import librosa
        y = librosa.resample(y, orig_sr=in_sr, target_sr=sr)
    return y.astype(np.float64)


def _mel_rgb(mel: np.ndarray, out_w: int, out_h: int) -> np.ndarray:
    """log-mel [n_mels,T] -> an (out_h,out_w,3) magma-ish uint8 image (low freq at bottom)."""
    lo, hi = float(np.percentile(mel, 2)), float(np.percentile(mel, 99))
    norm = np.clip((mel - lo) / max(hi - lo, 1e-9), 0.0, 1.0)
    # resample time to out_w, mel bins to out_h (nearest)
    ti = np.clip((np.arange(out_w) * norm.shape[1] / out_w).astype(int), 0, norm.shape[1] - 1)
    fi = np.clip((np.arange(out_h) * norm.shape[0] / out_h).astype(int), 0, norm.shape[0] - 1)
    img = norm[np.ix_(fi, ti)][::-1]                    # flip so high freq on top
    # magma-ish ramp: black -> purple -> orange -> white
    stops = np.array([[0, 0, 4], [60, 15, 110], [180, 55, 100], [250, 160, 60], [255, 255, 220]])
    xs = np.linspace(0, 1, len(stops))
    rgb = np.stack([np.interp(img.ravel(), xs, stops[:, c]) for c in range(3)], axis=1)
    return rgb.reshape(out_h, out_w, 3).astype(np.uint8)


def render_panel(take_path: str, render_path: str, score_clip: Optional[dict],
                 out_png: str, label: str = "", width: int = 1500,
                 extra_stats: Optional[dict] = None,
                 t0: float = 0.0, t1: Optional[float] = None) -> Dict:
    """Stacked take/render waveform + mel panel with score markers -> PNG. Returns stats.
    [t0, t1] crops a time window (seconds) so a short squeak is visible; markers/time-axis
    stay on the absolute section clock."""
    from PIL import Image, ImageDraw

    take = load_mono(take_path)
    rend = load_mono(render_path)
    n = max(len(take), len(rend))
    take = np.pad(take, (0, n - len(take)))
    rend = np.pad(rend, (0, n - len(rend)))
    # click detection on the FULL render (before cropping) so counts are complete
    full_clicks = click_spikes(rend, SR)
    a0 = max(0, int(t0 * SR))
    a1 = min(n, int(t1 * SR)) if t1 is not None else n
    win0, win1 = a0 / SR, a1 / SR
    take, rend = take[a0:a1], rend[a0:a1]
    dur_s = (a1 - a0) / SR

    stats = {"label": label, "dur_s": round(dur_s, 2), "window": [round(win0, 2), round(win1, 2)],
             "env_corr": round(env_corr(take, rend, SR), 3),
             "render_click_spikes": full_clicks,
             "clicks_in_window": [t for t in full_clicks if win0 <= t <= win1]}
    if extra_stats:
        stats.update(extra_stats)

    plot_w = width - 20
    wav_h, mel_h, gap, top = 90, 120, 8, 34
    lanes = [("take waveform", "wav", take, (90, 200, 255)),
             ("render waveform", "wav", rend, (255, 170, 90)),
             ("take mel", "mel", take, None),
             ("render mel", "mel", rend, None)]
    height = top + len(lanes) * (max(wav_h, mel_h) if False else 0)
    lane_hs = [wav_h if k == "wav" else mel_h for _t, k, _y, _c in lanes]
    height = top + sum(lane_hs) + gap * len(lanes) + 24
    img = Image.new("RGB", (width, height), (16, 18, 24))
    dr = ImageDraw.Draw(img)
    dr.text((10, 9), f"{label}   env_corr={stats['env_corr']}   "
                     f"{'clicks:' + str(len(stats['render_click_spikes'])) if stats['render_click_spikes'] else 'no clicks'}",
            fill=(232, 235, 243))

    # markers from the score (vowel-ish onsets = word events; phrase boundaries)
    onsets: List[float] = []
    phrases: List[float] = []
    if score_clip:
        try:
            from soulx.score import word_event_spans, phrase_windows
            onsets = [a for a, _b in word_event_spans(score_clip)]
            phrases = [w[0] for w in phrase_windows(score_clip)]
        except Exception:  # noqa: BLE001 — markers are decoration, never block the panel
            pass

    def x_of(t: float) -> int:
        """absolute time (s) -> x, mapped through the [win0, win1] crop."""
        frac = (t - win0) / max(win1 - win0, 1e-9)
        return 10 + int(min(1.0, max(0.0, frac)) * plot_w)

    onsets = [t for t in onsets if win0 <= t <= win1]
    phrases = [t for t in phrases if win0 <= t <= win1]

    y_cursor = top
    for (title, kind, y, color), lh in zip(lanes, lane_hs):
        x0, y0 = 10, y_cursor
        if kind == "wav":
            mins, maxs = peak_buckets(y, plot_w)
            mid = y0 + lh // 2
            amp = lh // 2 - 2
            dr.rectangle([x0, y0, x0 + plot_w, y0 + lh], fill=(24, 27, 35))
            for i in range(plot_w):
                dr.line([(x0 + i, mid - int(maxs[i] * amp)), (x0 + i, mid - int(mins[i] * amp))],
                        fill=color)
        else:
            rgb = _mel_rgb(mel_db(y), plot_w, lh)
            img.paste(Image.fromarray(rgb), (x0, y0))
        # markers across the lane
        for t in phrases:
            dr.line([(x_of(t), y0), (x_of(t), y0 + lh)], fill=(90, 96, 110))
        for t in onsets:
            dr.line([(x_of(t), y0), (x_of(t), y0 + lh)], fill=(120, 220, 140))
        for t in stats["clicks_in_window"]:
            if kind == "mel" and title.startswith("render"):
                dr.line([(x_of(t), y0), (x_of(t), y0 + lh)], fill=(255, 60, 60))
        dr.text((x0 + 4, y0 + 2), title, fill=(200, 205, 218))
        y_cursor += lh + gap

    # time axis ticks (absolute seconds; step scales with the window)
    step = 5 if (win1 - win0) > 20 else (2 if (win1 - win0) > 6 else 1)
    tick = int(math.ceil(win0 / step) * step)
    while tick <= win1:
        dr.line([(x_of(tick), height - 22), (x_of(tick), height - 16)], fill=(120, 126, 140))
        dr.text((x_of(tick) + 2, height - 16), f"{tick}s", fill=(150, 156, 170))
        tick += step

    img.save(out_png)
    stats["png"] = out_png
    return stats


if __name__ == "__main__":
    import argparse
    import json
    ap = argparse.ArgumentParser()
    ap.add_argument("take")
    ap.add_argument("render")
    ap.add_argument("out_png")
    ap.add_argument("--score", default=None, help="score clip json (list or dict)")
    ap.add_argument("--label", default="")
    ap.add_argument("--t0", type=float, default=0.0)
    ap.add_argument("--t1", type=float, default=None)
    args = ap.parse_args()
    sc = None
    if args.score and os.path.isfile(args.score):
        with open(args.score) as f:
            sc = json.load(f)
        sc = sc[0] if isinstance(sc, list) else sc
    st = render_panel(args.take, args.render, sc, args.out_png, label=args.label,
                      t0=args.t0, t1=args.t1)
    print(json.dumps(st, indent=1))

"""Audio decode + embedding for the drum matcher.

`load_audio` decodes (soundfile), mono-sums, resamples to 44.1k, peak-normalizes and
trims silence, and tags anything > ~3 s as a loop (excluded from the one-shot index).
`EngineeredEmbedder` is the always-available baseline (librosa/numpy features on a
fixed 1 s window — the spec's competitive fallback). `ClapEmbedder` is gated behind the
teardown venv (laion_clap), absent → `available` False, exactly like SA3/transform.

The index owns standardization + L2-normalization (see index.py); embedders return RAW
feature vectors so the same standardizer applies to every embedder.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Union

import numpy as np

SR = 44100
WINDOW_S = 1.0
LOOP_THRESHOLD_S = 3.0
TRIM_TOP_DB = 40.0

AudioLike = Union[str, Path, "np.ndarray", tuple]


@dataclass
class LoadedAudio:
    y: np.ndarray            # mono float32 @ SR, peak-normalized, silence-trimmed
    sr: int
    kind: str                # "one_shot" | "loop"
    raw_duration_s: float
    content_hash: str        # sha256 of decoded+resampled mono PCM (exact-dup key)


def load_audio(path: Union[str, Path]) -> LoadedAudio:
    """Decode → mono → 44.1k → peak-norm → trim. Raises on empty/silent/undecodable
    (the caller flags + skips; never fatal to a library scan)."""
    import soundfile as sf

    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if data.size == 0:
        raise ValueError("empty audio")
    y = data.mean(axis=1).astype(np.float32)  # mono-sum
    raw_dur = len(y) / float(sr)

    if sr != SR:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=SR).astype(np.float32)
        sr = SR

    # exact-dup key on the decoded+resampled mono signal (gain-independent dups are
    # caught later by min-distance collapse, not here).
    content_hash = hashlib.sha256(np.ascontiguousarray(y, dtype=np.float32).tobytes()).hexdigest()

    peak = float(np.max(np.abs(y))) if y.size else 0.0
    if peak <= 1e-9:
        raise ValueError("silent audio")
    y = y / peak

    import librosa
    y, _ = librosa.effects.trim(y, top_db=TRIM_TOP_DB)
    if y.size == 0:
        raise ValueError("all-silence after trim")

    kind = "loop" if raw_dur > LOOP_THRESHOLD_S else "one_shot"
    return LoadedAudio(y=y.astype(np.float32), sr=sr, kind=kind,
                       raw_duration_s=raw_dur, content_hash=content_hash)


def _window(y: np.ndarray, sr: int) -> np.ndarray:
    n = int(WINDOW_S * sr)
    if len(y) >= n:
        return y[:n]
    return np.pad(y, (0, n - len(y)))


def _temporal_features(y: np.ndarray, sr: int) -> tuple[float, float, float]:
    """log-attack-time, log-decay-time (peak→10%), log-duration — robust to zeros."""
    a = np.abs(y)
    win = max(1, int(0.005 * sr))
    env = np.convolve(a, np.ones(win) / win, mode="same")
    if env.size == 0 or float(env.max()) <= 0.0:
        return 0.0, 0.0, 0.0
    peak = int(np.argmax(env))
    pv = float(env[peak])
    lat = float(np.log1p(peak / sr))
    thr = 0.1 * pv
    after = np.where(env[peak:] <= thr)[0]
    decay_t = (float(after[0]) / sr) if after.size else (len(env) - peak) / sr
    return lat, float(np.log1p(decay_t)), float(np.log1p(len(y) / sr))


class Embedder(Protocol):
    version: str
    available: bool

    def embed(self, y: np.ndarray, sr: int) -> np.ndarray: ...


class EngineeredEmbedder:
    """Hand-engineered timbre features — deterministic, no model download.

    Vector = [mfcc(20) mean+std, {centroid, rolloff85, flatness, bandwidth, zcr, rms}
    mean+std, log-attack-time, log-decay-time, log-duration]. Raw (un-standardized);
    the index standardizes across the corpus then L2-normalizes."""

    version = "engineered-v1"
    available = True

    def embed(self, y: np.ndarray, sr: int) -> np.ndarray:
        import librosa

        y = np.asarray(y, dtype=np.float32)
        w = _window(y, sr)
        feats: list[np.ndarray] = []

        mfcc = librosa.feature.mfcc(y=w, sr=sr, n_mfcc=20)
        feats += [mfcc.mean(axis=1), mfcc.std(axis=1)]

        spec = [
            librosa.feature.spectral_centroid(y=w, sr=sr),
            librosa.feature.spectral_rolloff(y=w, sr=sr, roll_percent=0.85),
            librosa.feature.spectral_flatness(y=w),
            librosa.feature.spectral_bandwidth(y=w, sr=sr),
            librosa.feature.zero_crossing_rate(w),
            librosa.feature.rms(y=w),
        ]
        for f in spec:
            feats += [f.mean(axis=1), f.std(axis=1)]

        lat, ldecay, ldur = _temporal_features(y, sr)
        feats.append(np.array([lat, ldecay, ldur], dtype=np.float64))

        v = np.concatenate([np.asarray(f, dtype=np.float64).ravel() for f in feats])
        return v.astype(np.float32)


class ClapEmbedder:
    """CLAP audio-tower embedding — gated behind the teardown venv (laion_clap).

    Mirrors the SA3/transform posture: if the dep is absent, `available` is False and
    the matcher uses EngineeredEmbedder instead. Lazy-loaded; one model per process."""

    version = "clap-htsat-fused"

    def __init__(self) -> None:
        self._model = None

    @property
    def available(self) -> bool:
        import importlib.util
        return importlib.util.find_spec("laion_clap") is not None

    def _ensure(self):
        if self._model is None:
            import laion_clap  # type: ignore
            m = laion_clap.CLAP_Module(enable_fusion=True)
            m.load_ckpt()
            self._model = m
        return self._model

    def embed(self, y: np.ndarray, sr: int) -> np.ndarray:
        if not self.available:
            raise RuntimeError("ClapEmbedder unavailable (run service/teardown/setup-teardown.sh)")
        import librosa
        model = self._ensure()
        y48 = librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=48000)
        vec = model.get_audio_embedding_from_data(x=y48[None, :], use_tensor=False)
        return np.asarray(vec, dtype=np.float32).ravel()

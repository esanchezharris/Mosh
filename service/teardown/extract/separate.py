"""Stem separation behind a Separator interface. DemucsSeparator (htdemucs) is the default
when installed (~9.2 dB SDR, MIT); gated on the dep. `"other"` is a melodic SOUP, not an
instrument — callers tag it low confidence and never auto-promote it.
"""
from __future__ import annotations

from typing import Protocol

import numpy as np

STEMS = ("drums", "bass", "vocals", "other")


class Separator(Protocol):
    available: bool

    def split(self, y: np.ndarray, sr: int) -> dict[str, np.ndarray]: ...


class DemucsSeparator:
    """htdemucs via the demucs API. Returns {drums,bass,vocals,other} as mono float32."""

    def __init__(self, model_name: str = "htdemucs") -> None:
        self.model_name = model_name
        self._model = None

    @property
    def available(self) -> bool:
        import importlib.util
        return importlib.util.find_spec("demucs") is not None

    def _ensure(self):
        if self._model is None:
            from demucs.pretrained import get_model
            self._model = get_model(self.model_name)
            self._model.eval()
        return self._model

    def split(self, y: np.ndarray, sr: int) -> dict[str, np.ndarray]:
        import torch
        from demucs.apply import apply_model

        model = self._ensure()
        y = np.asarray(y, dtype=np.float32)
        if y.ndim == 1:
            y = np.stack([y, y])              # demucs wants stereo (channels, samples)
        # resample to the model rate if needed
        if sr != model.samplerate:
            import librosa
            y = np.stack([librosa.resample(c, orig_sr=sr, target_sr=model.samplerate) for c in y])
            sr = model.samplerate
        wav = torch.from_numpy(y)[None]       # (1, channels, samples)
        with torch.no_grad():
            est = apply_model(model, wav, split=True, overlap=0.25, progress=False)[0]  # (stems, ch, samples)
        out: dict[str, np.ndarray] = {}
        for i, name in enumerate(model.sources):
            out[name] = est[i].mean(0).cpu().numpy().astype(np.float32)  # mono-sum each stem
        # normalize keys to STEMS (htdemucs sources == drums,bass,other,vocals)
        return {k: out.get(k, np.zeros(1, np.float32)) for k in STEMS}

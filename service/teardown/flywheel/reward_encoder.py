"""§11 upgrade: a REAL music encoder (MERT) behind the same `embed(audio, sr) -> vec` shape
the engineered baseline uses, so the reward head can be trained/scored on music-grounded
features instead of speech-tuned ones (the spec's "MuQ/MERT, NOT Audiobox" call).

MERT-v1-95M is a self-supervised music model; we mean-pool its hidden states into a fixed
vector. Runs on MPS (Apple GPU) when available. Heavy deps (torch/transformers) live ONLY
here and in the reward venv — the rest of the teardown lane stays torch-free. `available()`
gates it exactly like SA3/RAVE; callers fall back to the engineered embedder when absent.
"""
from __future__ import annotations

import functools
from typing import Optional

import numpy as np

MERT_MODEL = "m-a-p/MERT-v1-95M"
MERT_SR = 24000


def _have_torch() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


@functools.lru_cache(maxsize=2)
def _load_mert(model_name: str = MERT_MODEL):
    import torch
    from transformers import AutoModel

    device = "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu")
    model = AutoModel.from_pretrained(model_name, trust_remote_code=True)
    model.eval().to(device)
    return model, device


def _resample(audio: np.ndarray, sr: int, target: int) -> np.ndarray:
    if sr == target:
        return audio.astype(np.float32)
    import math
    # high-quality resample via librosa (already a base dep)
    import librosa
    return librosa.resample(audio.astype(np.float32), orig_sr=sr, target_sr=target).astype(np.float32)


class MertEncoder:
    """Frozen MERT → fixed embedding. version string flows into cache/fingerprint keys."""

    name = "mert"

    def __init__(self, model_name: str = MERT_MODEL, layer: str = "mean") -> None:
        self.model_name = model_name
        self.layer = layer
        self.version = f"mert95m-{layer}-v1"

    @staticmethod
    def available() -> bool:
        return _have_torch()

    def embed(self, audio, sr: int = 44100) -> np.ndarray:
        import torch

        if isinstance(audio, tuple):
            audio, sr = audio
        x = np.asarray(audio, dtype=np.float32)
        if x.ndim > 1:
            x = x.mean(axis=-1)
        x = _resample(x, sr, MERT_SR)
        peak = float(np.max(np.abs(x))) or 1.0
        x = x / peak

        model, device = _load_mert(self.model_name)
        with torch.no_grad():
            t = torch.from_numpy(x).float().unsqueeze(0).to(device)
            out = model(t, output_hidden_states=True)
            hs = out.hidden_states  # tuple[L] of (1, T, H)
            stacked = torch.stack(hs, dim=0)            # (L, 1, T, H)
            # mean over time, then mean over layers → (H,)
            vec = stacked.mean(dim=2).mean(dim=0).squeeze(0)
            v = vec.detach().cpu().numpy().astype(np.float32)
        n = float(np.linalg.norm(v)) or 1.0
        return v / n


def get_encoder(prefer: Optional[str] = None):
    """Return MertEncoder when torch/transformers are present, else the §1 engineered
    embedder (always available). `prefer='engineered'` forces the baseline (for A/B)."""
    if prefer == "engineered" or (prefer is None and not MertEncoder.available()):
        from teardown.drummatch.embed import EngineeredEmbedder
        return EngineeredEmbedder()
    if prefer in (None, "mert") and MertEncoder.available():
        return MertEncoder()
    from teardown.drummatch.embed import EngineeredEmbedder
    return EngineeredEmbedder()

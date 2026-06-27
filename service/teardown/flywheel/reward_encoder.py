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
import json
import os
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


HEAD_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reward_head.json")


class TrainedRewardHead:
    """The TRAINED §11 head as a §12 `pull`: embed with MERT, measure trained-diagonal-weighted
    proximity to good exemplars → 0..1 (closer ⇒ higher). Loads the reward_head.json artifact
    train_reward.py writes. Falls back gracefully (pull ≈ 0.5) with no exemplars."""

    def __init__(self, head_path: str = HEAD_PATH, encoder: Optional["MertEncoder"] = None) -> None:
        with open(head_path) as f:
            self.head = json.load(f)
        self.w = np.asarray(self.head["weights"], dtype=np.float64)
        self.version = f"trained-{self.head.get('encoder', 'mert')}"
        self.encoder = encoder or MertEncoder()
        self._exemplars: list = []
        # the head's weights are dimensioned for the encoder it was trained on; a mismatch
        # would silently broadcast/garble the weighted distance. Validate up front.
        if int(self.head.get("dim", len(self.w))) != len(self.w):
            raise ValueError(f"reward_head dim {self.head.get('dim')} != weights len {len(self.w)}")
        if self.head.get("encoder") and self.head["encoder"] != self.encoder.version:
            print(f"  [reward] WARNING: head trained on {self.head['encoder']!r} but live encoder "
                  f"is {self.encoder.version!r} — weights may not apply", flush=True)

    @staticmethod
    def available(head_path: str = HEAD_PATH) -> bool:
        return MertEncoder.available() and os.path.isfile(head_path)

    @staticmethod
    def _finite(v: np.ndarray) -> bool:
        return bool(v.size) and bool(np.all(np.isfinite(v)))

    def add_exemplars(self, audios) -> int:
        """audios: list of (audio, sr) good references — the 'sounds like good music' anchors.
        NaN/Inf or wrong-dim embeddings are skipped (a poisoned exemplar would wreck pull())."""
        for a in audios:
            au, sr = a if isinstance(a, tuple) else (a, 44100)
            v = self.encoder.embed(au, sr)
            if v.shape == self.w.shape and self._finite(v):
                self._exemplars.append(v)
        return len(self._exemplars)

    def _wdist(self, a: np.ndarray, b: np.ndarray) -> float:
        d = a.astype(np.float64) - b.astype(np.float64)
        return float(np.sqrt(np.sum(self.w * d * d)) + 1e-9)

    def pull(self, audio, sr: int = 44100) -> float:
        if not self._exemplars:
            return 0.5
        v = self.encoder.embed(audio, sr)
        if v.shape != self.w.shape or not self._finite(v):
            return 0.0                                   # broken embedding → no reward, never NaN
        d = min(self._wdist(v, e) for e in self._exemplars)
        return float(1.0 / (1.0 + d)) if np.isfinite(d) else 0.0


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

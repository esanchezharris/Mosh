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


def _have_muq() -> bool:
    try:
        import muq  # noqa: F401
        return _have_torch()
    except Exception:
        return False


def _device() -> str:
    import torch
    return "mps" if torch.backends.mps.is_available() else (
        "cuda" if torch.cuda.is_available() else "cpu")


@functools.lru_cache(maxsize=2)
def _load_mert(model_name: str = MERT_MODEL):
    import torch  # noqa: F401
    from transformers import AutoModel

    device = _device()
    model = AutoModel.from_pretrained(model_name, trust_remote_code=True)
    model.eval().to(device)
    return model, device


MUQ_SSL_MODEL = "OpenMuQ/MuQ-large-msd-iter"
MUQ_MULAN_MODEL = "OpenMuQ/MuQ-MuLan-large"
MUQ_SR = 24000


@functools.lru_cache(maxsize=2)
def _load_muq(model_name: str = MUQ_SSL_MODEL):
    from muq import MuQ
    device = _device()
    model = MuQ.from_pretrained(model_name).eval().to(device)
    return model, device


@functools.lru_cache(maxsize=2)
def _load_mulan(model_name: str = MUQ_MULAN_MODEL):
    from muq import MuQMuLan
    device = _device()
    model = MuQMuLan.from_pretrained(model_name).eval().to(device)
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

    def embed_layers(self, audio, sr: int = 44100) -> np.ndarray:
        """Per-layer pooled (mean over time), each L2-normalized → (L, H). For layer-selection
        analysis (the mean-over-all-layers `embed` can be suboptimal — best layer varies)."""
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
            stacked = torch.stack(out.hidden_states, dim=0)      # (L, 1, T, H)
            mat = stacked.mean(dim=2).squeeze(1).cpu().numpy().astype(np.float32)  # (L, H)
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return mat / norms


class MuQEncoder:
    """Frozen MuQ (music SSL, MuQ-large-msd-iter) → fixed embedding behind the same shape as MERT.
    Mean over hidden-state layers + time by default; `embed_layers` exposes per-layer for selection."""

    name = "muq"

    def __init__(self, model_name: str = MUQ_SSL_MODEL, layer: str = "mean") -> None:
        self.model_name = model_name
        self.layer = layer
        self.version = f"muq-large-{layer}-v1"

    @staticmethod
    def available() -> bool:
        return _have_muq()

    def _layers(self, audio, sr: int) -> np.ndarray:
        """(L, H) per-layer time-pooled hidden states (un-normalized)."""
        import torch

        if isinstance(audio, tuple):
            audio, sr = audio
        x = np.asarray(audio, dtype=np.float32)
        if x.ndim > 1:
            x = x.mean(axis=-1)
        x = _resample(x, sr, MUQ_SR)
        peak = float(np.max(np.abs(x))) or 1.0
        x = x / peak
        model, device = _load_muq(self.model_name)
        with torch.no_grad():
            t = torch.from_numpy(x).float().unsqueeze(0).to(device)
            out = model(t, output_hidden_states=True)
            stacked = torch.stack(out.hidden_states, dim=0)      # (L, 1, T, H)
            return stacked.mean(dim=2).squeeze(1).cpu().numpy().astype(np.float32)  # (L, H)

    def embed(self, audio, sr: int = 44100) -> np.ndarray:
        v = self._layers(audio, sr).mean(axis=0)                 # mean over layers → (H,)
        n = float(np.linalg.norm(v)) or 1.0
        return (v / n).astype(np.float32)

    def embed_layers(self, audio, sr: int = 44100) -> np.ndarray:
        mat = self._layers(audio, sr)
        norms = np.linalg.norm(mat, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return mat / norms


class MuQMuLanEncoder:
    """MuQ-MuLan audio tower (contrastive text↔audio — the direct CLAP analog, 512-d). The most
    promising raw CLAP-challenger: its embedding space is contrastively organized like CLAP's."""

    name = "muq-mulan"

    def __init__(self, model_name: str = MUQ_MULAN_MODEL) -> None:
        self.model_name = model_name
        self.version = "muq-mulan-large-v1"

    @staticmethod
    def available() -> bool:
        return _have_muq()

    def embed(self, audio, sr: int = 44100) -> np.ndarray:
        import torch

        if isinstance(audio, tuple):
            audio, sr = audio
        x = np.asarray(audio, dtype=np.float32)
        if x.ndim > 1:
            x = x.mean(axis=-1)
        x = _resample(x, sr, MUQ_SR)
        peak = float(np.max(np.abs(x))) or 1.0
        x = x / peak
        model, device = _load_mulan(self.model_name)
        with torch.no_grad():
            t = torch.from_numpy(x).float().unsqueeze(0).to(device)
            v = model(wavs=t)[0].cpu().numpy().astype(np.float32)  # (512,) audio embedding
        n = float(np.linalg.norm(v)) or 1.0
        return (v / n).astype(np.float32)


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


COMPOSITE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "composite_reward.pt")


class CompositeRewardHead:
    """The VALIDATED §11 composite reward pull — drop-in for TrainedRewardHead (.pull / .add_exemplars
    / .available). pull(audio) = α·(TIMBRE proximity to good exemplars in raw-MuQ space) + (1-α)·(TIMING
    proximity in the learned φ-projection space). Beats raw CLAP on timbre + isolated-timing + in-mix-timing
    (held-out-by-source, source-clustered CI, artifact-controlled — see VERIFY_REAL 11-keystone-v3/v4).
    Loads `composite_reward.pt` (built by build_composite_reward.py): proj_state + ex_timbre + ex_timing."""

    def __init__(self, path: str = COMPOSITE_PATH, encoder: Optional["MuQEncoder"] = None) -> None:
        import torch
        from teardown.flywheel.finetune_encoder import _make_proj
        blob = torch.load(path, map_location="cpu", weights_only=False)
        self.meta = blob["meta"]
        self.alpha = float(self.meta.get("alpha", 0.5))
        self.version = f"composite-{self.meta.get('encoder', 'muq')}-v1"
        self.encoder = encoder or MuQEncoder()
        self._ex_timbre = blob["ex_timbre"].numpy().astype(np.float64)   # (N, in_dim) raw-MuQ
        self._ex_timing = blob["ex_timing"].numpy().astype(np.float64)   # (N, out_dim) learned timing
        self._proj = _make_proj(int(self.meta["in_dim"]))                # 1024→256→128, on device
        self._proj.load_state_dict(blob["proj_state"])
        self._proj.eval()
        self._exemplars = list(self._ex_timbre)                          # non-empty ⇒ has_pull gate passes

    @staticmethod
    def available(path: str = COMPOSITE_PATH) -> bool:
        return MuQEncoder.available() and os.path.isfile(path)

    def _project(self, v: np.ndarray) -> np.ndarray:
        import torch
        with torch.no_grad():
            t = torch.tensor(v[None, :], dtype=torch.float32, device=_device())
            return self._proj(t)[0].cpu().numpy().astype(np.float64)

    def pull(self, audio, sr: int = 44100) -> float:
        v = self.encoder.embed(audio, sr).astype(np.float64)             # (in_dim,) L2-normed
        if v.shape[0] != self._ex_timbre.shape[1] or not np.all(np.isfinite(v)):
            return 0.0                                                    # broken embedding → never NaN
        d_t = float(np.min(np.sqrt(((self._ex_timbre - v) ** 2).sum(axis=1))))
        pv = self._project(v.astype(np.float32))
        d_g = float(np.min(np.sqrt(((self._ex_timing - pv) ** 2).sum(axis=1))))
        if not (np.isfinite(d_t) and np.isfinite(d_g)):
            return 0.0
        return float(self.alpha / (1.0 + d_t) + (1.0 - self.alpha) / (1.0 + d_g))

    def add_exemplars(self, audios) -> int:
        """Extend the good-music exemplar set (timbre + timing spaces) at runtime."""
        for a in audios:
            au, sr = a if isinstance(a, tuple) else (a, 44100)
            v = self.encoder.embed(au, sr).astype(np.float64)
            if v.shape[0] == self._ex_timbre.shape[1] and np.all(np.isfinite(v)):
                self._ex_timbre = np.vstack([self._ex_timbre, v])
                self._ex_timing = np.vstack([self._ex_timing, self._project(v.astype(np.float32))])
                self._exemplars.append(v)
        return len(self._exemplars)

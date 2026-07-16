"""In-process SA3-Medium engine (05 §6, App. B) — carved from the research spike's
`mlx_inproc.py`. Loads T5Gemma + conditioner + DiT-medium + SAME-L decoder ONCE and
serves generate / re-imagine. Owned by the single worker thread in `server.py`:
NOT thread-safe (the loaded model is process-global and mutated per call), so it must
never be called concurrently.

Runs only under `$SA3_MLX_DIR/.venv/bin/python` (needs mlx + the SA3 model code). The
two carve paths from `mlx_inproc.py` are preserved verbatim: the load sequence and the
`gen()` decode path (steering setup, pingpong schedule with `sigma_max=init_noise_level`,
init-mix `init_lat*(1-σ) + noise*σ`, decode + `save_wav`). The two hardcoded paths
become env vars `SA3_MLX_DIR` (model) and — for colours — `COLORRACK_DATA`.

DURATION IS PINNED at load: the DiT bakes `T_lat` (from `SA3_SECONDS`, default 8s) into
its latent grid, so one loaded engine serves one duration. Variable-length is a later rung.
"""
from __future__ import annotations

import math
import os
import sys
import threading

SA3_MLX_DIR = os.environ.get("SA3_MLX_DIR") or os.path.expanduser(
    "~/AI/stable-audio-3/optimized/mlx")
SECONDS = float(os.environ.get("SA3_SECONDS", "8.0"))   # pins the latent grid (see header)

_engine = None
_engine_lock = threading.Lock()


def engine_available() -> bool:
    """True if the SA3 model code + dir are present (gates the capability + /health)."""
    return os.path.isdir(SA3_MLX_DIR) and os.path.isfile(
        os.path.join(SA3_MLX_DIR, "scripts", "sa3_mlx.py"))


def get_engine():
    """Lazily construct the singleton (heavy: ~seconds, first SA3 job only)."""
    global _engine
    with _engine_lock:
        if _engine is None:
            _engine = _Engine()
        return _engine


class _Engine:
    def __init__(self):
        # Import the SA3 model code in place (no copy): mirrors mlx_inproc.py L16-23,
        # but reads SA3_MLX_DIR from env instead of the hardcoded ~/AI path.
        os.chdir(SA3_MLX_DIR)                              # weights resolve repo-relative
        if SA3_MLX_DIR not in sys.path:
            sys.path.insert(0, SA3_MLX_DIR)
        scripts = os.path.join(SA3_MLX_DIR, "scripts")
        if scripts not in sys.path:
            sys.path.insert(0, scripts)
        import numpy as np
        import mlx.core as mx
        import sa3_mlx as S

        self.np, self.mx, self.S = np, mx, S
        self.DTYPE, self.DEC_DTYPE = mx.float16, mx.float32
        self.SECONDS = SECONDS
        self.SAMPLES_PER_LATENT = S.SAMPLES_PER_LATENT
        self.T_LAT = max(1, math.ceil(SECONDS * S.SAMPLE_RATE / S.SAMPLES_PER_LATENT))
        self.STEPS = int(os.environ.get("SA3_STEPS", "8"))

        # Load once (mlx_inproc.py L38-44).
        self.enc = S.T5Gemma.from_npz(str(S.ensure_local(S.T5GEMMA_NPZ_REL)))
        self.padding_emb, self.secs_embedder = S.load_conditioner_from_npz(
            str(S.ensure_local(S.DIT_CHOICES["medium"]["ckpt"])), prefix="cond.")
        self.dit_model, self._dit_ckpt = S.load_dit("medium", T_lat=self.T_LAT, dtype=self.DTYPE)
        self.decoder, _chunk_fn, _ = S.load_decoder("same-l", self.DEC_DTYPE)
        self._tf = self.dit_model.transformer
        self._encoder = None
        # LoRA rack state (merge-at-rack-change; see sa3/lora_runtime.py).
        # _lora_sig identifies the currently-merged rack; _lora_keys are the
        # DiT param keys a merge touched (what restore_base must reload).
        self._lora_sig = None
        self._lora_keys = []

    # ── carved from mlx_inproc._encode_audio ──
    def encode_init(self, path):
        S, mx, np = self.S, self.mx, self.np
        if self._encoder is None:
            self._encoder = S.load_encoder("same-l", mx.float32)[0]
        a = S.read_wav(path)                                          # (2, T)
        tgt = self.T_LAT * self.SAMPLES_PER_LATENT
        a = a[:, :tgt] if a.shape[-1] >= tgt else np.pad(a, ((0, 0), (0, tgt - a.shape[-1])))
        patches = S.patch_audio(a[None], patch_size=256)
        lat = self._encoder(mx.array(patches)); mx.eval(lat)
        return lat.astype(self.DTYPE)                                 # (1, 256, T_LAT)

    # ── carved from mlx_inproc._cond ──
    def _cond(self, prompt):
        S, mx = self.S, self.mx
        embeds, mask = self.enc.encode([prompt], max_len=256)
        embeds = embeds.astype(self.DTYPE)
        embeds_padded = S.apply_prompt_padding(embeds, mask, self.padding_emb.astype(self.DTYPE))
        seconds_embed = self.secs_embedder(self.SECONDS).astype(self.DTYPE)
        cross_attn = mx.concatenate([embeds_padded, seconds_embed], axis=1)
        return cross_attn, seconds_embed[:, 0, :]

    # ── carved from mlx_inproc.gen (decode-and-save path only; no activation dump) ──
    def _gen(self, prompt, seed, steers, out_wav, init_lat=None, init_noise_level=1.0):
        S, mx, np = self.S, self.mx, self.np
        cross_attn, global_cond = self._cond(prompt)
        self._tf._dump = None
        self._tf._steer_layer = -1; self._tf._steer_alpha = 0.0; self._tf._steer_vec = None
        self._tf._steers = [(int(L), float(a), mx.array(np.asarray(v, dtype=np.float32)))
                            for (L, a, v) in (steers or [])]
        sigma_max = float(init_noise_level)
        sigmas = S.build_pingpong_schedule(self.STEPS, sigma_max=sigma_max, use_logsnr_shift=True)
        pure = mx.random.normal((1, 256, self.T_LAT), dtype=self.DTYPE, key=mx.random.key(seed))
        noise = (init_lat * (1.0 - sigma_max) + pure * sigma_max) if init_lat is not None else pure
        mx.eval(noise)

        def model_fn(x, t):
            return self.dit_model(x, t, cross_attn, global_cond, local_add_cond=None)

        latents = S.sample_flow_pingpong(model_fn, noise, sigmas, seed=seed + 1,
                                         paste_back=None, on_step=None)
        mx.eval(latents)
        patches = self.decoder(latents.astype(self.DEC_DTYPE)); mx.eval(patches)
        audio = S.patched_decode(patches, patch_size=256, channels=2); mx.eval(audio)
        audio_np = np.array(audio.astype(mx.float32))[0]
        req = int(round(self.SECONDS * S.SAMPLE_RATE))
        if audio_np.shape[-1] > req:
            audio_np = audio_np[..., :req]
        S.save_wav(out_wav, audio_np)

    # ── LoRA rack (merge-at-rack-change; single worker thread only) ──
    def apply_lora_rack(self, rack):
        """Merge a resolved LoRA rack into the DiT (or restore base for []).

        rack: [{"path", "sha256", "strength"}, ...] in rack order, strength>0.
        Signature-gated: re-merges only when the rack actually changed, so
        back-to-back renders with the same rack pay nothing. Returns
        {"ms", "targets", "cached"}.
        """
        from . import lora_runtime as LR
        sig = LR.rack_signature(rack)
        if sig == self._lora_sig:
            return {"ms": 0, "targets": 0, "cached": True}

        import time as _time
        t0 = _time.time()
        if not rack:
            if self._lora_keys:
                LR.restore_base(self.dit_model, self._dit_ckpt, self._lora_keys,
                                mx=self.mx)
            self._lora_keys = []
            self._lora_sig = sig
            return {"ms": int((_time.time() - t0) * 1000), "targets": 0,
                    "cached": False}

        stats = LR.merge_rack(self.dit_model, self._dit_ckpt, rack, mx=self.mx)
        new_keys = stats.pop("keys")
        # Keys the PREVIOUS rack touched but this one doesn't must revert to
        # pristine, or they'd keep stale merged values.
        stale = [k for k in self._lora_keys if k not in set(new_keys)]
        if stale:
            LR.restore_base(self.dit_model, self._dit_ckpt, stale, mx=self.mx)
        self._lora_keys = new_keys
        self._lora_sig = sig
        stats["ms"] = int((_time.time() - t0) * 1000)
        stats["cached"] = False
        return stats

    # ── public API ──
    def generate(self, prompt, seed, steers=None, out_wav=None):
        self._gen(prompt, seed, steers, out_wav, init_lat=None, init_noise_level=1.0)

    def reimagine(self, prompt, seed, init_lat, init_noise_level, steers=None, out_wav=None):
        self._gen(prompt, seed, steers, out_wav, init_lat=init_lat,
                  init_noise_level=init_noise_level)

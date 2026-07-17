"""Time-scheduled steering — per-latent-position schedules on SA3 steer vectors.

SA3's steer hook (`dit_mlx_medium.ContinuousTransformer`) adds `alpha*vec` to the
content tokens `x[:, NUM_MEM:, :]` (shape [B, T_lat, E]) UNIFORMLY across latent
positions, every diffusion step. Each latent position ≈ 92.9 ms of audio, so the
latent-position axis IS the clip timeline. A per-position schedule lets a steer act
more toward the END of the clip — e.g. the "Sustain" color holds the opening
character across the whole clip instead of letting the onset prior decay.

Two parts:
  • `build_envelope(spec, t_lat, lat_s)` — pure numpy; a T-independent envelope spec
    (from a color's `envelope` field) → a [t_lat] per-position multiplier. HERMETIC.
  • `install_scheduled_steer_patch()` — replaces `ContinuousTransformer.__call__` with
    a version that honors an optional per-steer schedule (a 4th element on each
    `_steers` entry). Byte-identical to stock when every schedule is None (proven:
    diff 0.0). Called once by the engine at model load; only exercised under real SA3.
"""
from __future__ import annotations

import numpy as np

_DEFAULTS = {"lo": 0.0, "hi": 1.0, "knee_s": 1.5}


def build_envelope(spec, t_lat: int, lat_s: float):
    """T-independent envelope spec → [t_lat] float32 per-position multiplier (or None).

    spec kinds (all default lo=0, hi=1, knee_s=1.5):
      None / {}   → None (no schedule; the steer stays uniform == stock)
      "flat"      → hi everywhere (uniform at `hi`)
      "linear"    → lo..hi across the clip (hold more toward the end)
      "hold"      → lo through the first knee_s seconds, then ramp lo→hi (leave the
                    intro alone, prop up the decaying tail). Clip shorter than the
                    knee → all lo (no tail to hold).
    """
    if not spec:
        return None
    kind = spec.get("kind", "hold")
    lo = float(spec.get("lo", _DEFAULTS["lo"]))
    hi = float(spec.get("hi", _DEFAULTS["hi"]))
    n = int(t_lat)
    if n <= 1:
        return np.full(max(n, 0), hi if kind == "flat" else lo, dtype=np.float32)
    if kind == "flat":
        return np.full(n, hi, dtype=np.float32)
    if kind == "linear":
        return np.linspace(lo, hi, n, dtype=np.float32)
    if kind == "hold":
        knee = int(round(float(spec.get("knee_s", _DEFAULTS["knee_s"])) / lat_s))
        knee = max(0, min(knee, n))                  # clamp into [0, n]
        m = np.empty(n, dtype=np.float32)
        m[:knee] = lo
        if knee < n:
            m[knee:] = np.linspace(lo, hi, n - knee, dtype=np.float32)
        return m
    raise ValueError(f"unknown envelope kind: {kind!r}")


_PATCHED = False


def install_scheduled_steer_patch() -> None:
    """Replace ContinuousTransformer.__call__ with a schedule-aware version.

    Each `_steers` entry may be a 3-tuple `(layer, alpha, vec)` (uniform, == stock)
    or a 4-tuple `(layer, alpha, vec, sched)` where `sched` is an mx.array[T_lat]
    per-position multiplier. Idempotent; byte-identical when all scheds are None.
    """
    global _PATCHED
    if _PATCHED:
        return
    import mlx.core as mx
    from models.defs import dit_mlx_medium as D

    NUM_MEM = D.NUM_MEMORY_TOKENS

    def patched_call(self, x, context, global_embed, local_add_cond_zeros):
        B, T, _ = x.shape
        x = self.project_in(x)
        mem = mx.broadcast_to(self.memory_tokens[None], (B, NUM_MEM, D.EMBED_DIM))
        x = mx.concatenate([mem, x], axis=1)

        g = self.global_cond_embedder[0](global_embed)
        g = D.nn.silu(g)
        g = self.global_cond_embedder[2](g)
        global_cond = g

        for li, layer in enumerate(self.layers):
            local_emb = layer.to_local_embed(local_add_cond_zeros)
            pad = mx.zeros((B, NUM_MEM, D.EMBED_DIM), dtype=local_emb.dtype)
            local_emb_padded = mx.concatenate([pad, local_emb], axis=1)
            x = layer(x, context, global_cond, local_emb_padded)

            # (1) read-only activation tap (unchanged from stock)
            if self._dump is not None:
                mx.eval(x)
                self._dump(li, D.np.array(x[:, NUM_MEM:, :], copy=True))

            # (2) single-steer path (unchanged from stock)
            if self._steer_vec is not None and li == self._steer_layer:
                vec = (self._steer_alpha * self._steer_vec.astype(x.dtype)).astype(x.dtype)
                x = mx.concatenate([x[:, :NUM_MEM, :], x[:, NUM_MEM:, :] + vec], axis=1)

            # (3) multi-steer composition, now with an optional per-steer schedule
            if self._steers:
                content = x[:, NUM_MEM:, :]
                for entry in self._steers:
                    _sl, _sa, _sv = entry[0], entry[1], entry[2]
                    if _sl != li:
                        continue
                    base = (_sa * _sv.astype(x.dtype)).astype(x.dtype)          # [E]
                    sched = entry[3] if len(entry) > 3 else None                # [T] or None
                    if sched is None:
                        content = content + base                                # broadcast (== stock)
                    else:
                        content = content + (sched.astype(x.dtype)[None, :, None] * base)
                x = mx.concatenate([x[:, :NUM_MEM, :], content], axis=1)

        x = x[:, NUM_MEM:, :]
        x = self.project_out(x)
        return x

    D.ContinuousTransformer.__call__ = patched_call
    _PATCHED = True

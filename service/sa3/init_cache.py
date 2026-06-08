"""Init-latent cache (05 §5) — cache the VAE-encoded init latents of a source clip
so that changing only seed / nl / colors re-uses the encode instead of re-running the
SAME-L encoder. Keyed by MD5(source bytes) + encoder variant + T_LAT (so trimming the
source or changing SA3_SECONDS busts the cache correctly).
"""
from __future__ import annotations

import hashlib
import os

CACHE_DIR = os.environ.get(
    "SA3_INIT_CACHE", os.path.expanduser("~/.cache/mosh/sa3_init"))
ENCODER_VARIANT = "same-l"


def _key(input_wav: str, t_lat: int) -> str:
    h = hashlib.md5(open(input_wav, "rb").read()).hexdigest()
    return f"{h}_{ENCODER_VARIANT}_T{t_lat}.npy"


def get_or_encode(eng, input_wav: str):
    """Return (init_lat (mlx array, eng.DTYPE), "hit"|"miss")."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, _key(input_wav, eng.T_LAT))
    if os.path.exists(path):
        lat = eng.mx.array(eng.np.load(path)).astype(eng.DTYPE)
        return lat, "hit"
    lat = eng.encode_init(input_wav)                          # MISS → encode
    eng.np.save(path, eng.np.array(lat.astype(eng.mx.float32)))
    return lat, "miss"

"""StableAudio3Adapter (05 §2, §6) — the real generative model behind the same
`render(input_wav, output_wav, params) -> manifest` contract as the FakeAdapter.

Full carve: re-imagine (audio→audio with steering) + generate (text→audio), the
ASTD-clamped colour rack, the init-latent cache, and judge-panel QA. The heavy
engine imports lazily so FakeAdapter-only runs never load MLX. Called only by the
single serialized worker thread in server.py (MLX is not concurrent).
"""
from __future__ import annotations

import os
import wave

NL_MAX_RECOGNIZABLE = 0.5   # >0.5 stops resembling the source (re-imagine guard, 05 §6)
NL_MIN = 0.01               # <0.01 is a near-identity encode round-trip → not worth a render


def _wav_meta(path):
    with wave.open(path, "rb") as w:
        return w.getframerate(), w.getnchannels(), w.getnframes()


def available() -> bool:
    from sa3 import engine as E
    if E.engine_available():
        return True

    try:
        from adapters import stable_audio3_cuda as cuda
        return cuda.available()
    except Exception:
        return False


def backend_name() -> str:
    from sa3 import engine as E
    if E.engine_available():
        return "mlx"

    try:
        from adapters import stable_audio3_cuda as cuda
        if cuda.available():
            return "cuda"
    except Exception:
        pass
    return "unavailable"


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    # Lazy heavy imports (only when an SA3 job actually runs).
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
    from sa3 import engine as E
    from sa3 import init_cache, qa
    from colors import runtime as CR

    if not E.engine_available():
        try:
            from adapters import stable_audio3_cuda as cuda
            if cuda.available():
                return cuda.render(input_wav, output_wav, params)
        except Exception:
            raise
        raise RuntimeError("stable_audio3 unavailable (no MLX or Windows CUDA backend found)")

    output_wav = os.path.abspath(output_wav)
    input_wav = os.path.abspath(input_wav) if input_wav else input_wav

    prompt = params.get("prompt") or ""
    seed = int(params.get("seed", 0))
    colors = params.get("colors") or []
    lab = bool(params.get("lab", False))
    steers = CR.resolve_steers(colors, lab=lab)             # validated / clamped / composed

    eng = E.get_engine()                                    # singleton; first call loads the model

    # mode: re-imagine when we have a source + an init-noise-level, else generate.
    has_src = bool(input_wav) and os.path.exists(input_wav)
    nl = params.get("nl", None)
    init_status = "n/a"
    if has_src and nl is not None:
        nl = float(nl)
        if nl < NL_MIN:
            raise ValueError(f"nl={nl} below {NL_MIN}: degenerate (no audible change)")
        nl = min(nl, NL_MAX_RECOGNIZABLE)
        init_lat, init_status = init_cache.get_or_encode(eng, input_wav)
        eng.reimagine(prompt, seed, init_lat, init_noise_level=nl,
                      steers=steers, out_wav=output_wav)
        mode = "audio_to_audio"
    else:
        eng.generate(prompt, seed, steers=steers, out_wav=output_wav)
        mode = "text_to_audio"

    sr, ch, nframes = _wav_meta(output_wav)
    manifest = {
        "ok": True, "adapter": "stable_audio3", "mode": mode,
        "duration_s": round(nframes / float(sr), 3),
        "sample_rate": sr, "channels": ch,
        "seconds_pinned": eng.SECONDS,
        "init_cache": init_status,
        "steers": [{"layer": L, "alpha": round(a, 4)} for (L, a, _v) in steers],
        "pq": None, "pq_base": None, "flags": [],
    }
    # Best-effort QA (judges venv); never fails the render.
    qa.augment_manifest(manifest, output_wav, source_wav=input_wav if has_src else None)
    return manifest

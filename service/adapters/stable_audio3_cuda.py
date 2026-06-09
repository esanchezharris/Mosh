"""Windows CUDA backend for the canonical stable_audio3 adapter.

This keeps the public service protocol and adapter id canonical (`stable_audio3`)
while using the locally installed `stable_audio_3` CUDA package on Windows. The
CUDA package name is an internal compatibility detail.
"""
from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import os
import time
from collections import OrderedDict

MODEL_DIR = os.environ.get("MOSH_SA3_MODEL_DIR", "E:/comfy4_models/unet")
USE_HALF = os.environ.get("MOSH_SA3_HALF", "1") != "0"
SAMPLER = os.environ.get("MOSH_SA3_SAMPLER", "pingpong")
MAX_DURATION = float(os.environ.get("MOSH_SA3_MAX_DURATION", "12.0"))
PEAK_DBFS = float(os.environ.get("MOSH_SA3_PEAK_DBFS", "-0.5"))
STEERING = os.environ.get("MOSH_SA3_STEERING", "1") != "0"
JUDGE = os.environ.get("MOSH_JUDGE", "dsp")
LATENT_CACHE_MAX = int(os.environ.get("MOSH_SA3_LATENT_CACHE", "8"))

_MODEL_LOCK = None
_MODEL = None
_INIT_LATENT_CACHE: "OrderedDict[str, object]" = OrderedDict()


def available() -> bool:
    model_dir = os.path.abspath(os.path.expanduser(MODEL_DIR))
    return (
        os.path.isfile(os.path.join(model_dir, "model_config.json"))
        and os.path.isfile(os.path.join(model_dir, "model.safetensors"))
        and importlib.util.find_spec("stable_audio_3") is not None
        and importlib.util.find_spec("torch") is not None
        and importlib.util.find_spec("soundfile") is not None
        and importlib.util.find_spec("numpy") is not None
    )


def _log(msg: str) -> None:
    print(f"[sa3-cuda] {msg}", flush=True)


def _lock():
    global _MODEL_LOCK
    if _MODEL_LOCK is None:
        import threading
        _MODEL_LOCK = threading.Lock()
    return _MODEL_LOCK


def _quality(wav_out, sr, src_2d, in_sr):
    if JUDGE == "none":
        return {"pq": None, "pq_base": None, "flags": []}
    try:
        import quality_readout as judge
        q = judge.analyze_array(wav_out, sr)
        out = {
            "pq": q.get("pq"),
            "pq_base": None,
            "flags": q.get("flags", []),
            "metrics": q.get("metrics", {}),
            "judge": "dsp",
        }
        if src_2d is not None:
            try:
                out["pq_base"] = judge.analyze_array(src_2d, in_sr).get("pq")
            except Exception:
                out["pq_base"] = None
        return out
    except Exception as exc:
        _log(f"quality readout unavailable: {exc!r}")
        return {"pq": None, "pq_base": None, "flags": ["qa_unavailable"]}


def _normalize_colors(colors):
    out = []
    for c in colors or []:
        if isinstance(c, dict):
            name = str(c.get("name", "")).strip()
            if name:
                out.append({"name": name, "value": float(c.get("value", 100))})
        else:
            name = str(c).strip()
            if name:
                out.append({"name": name, "value": 100.0})
    return out


def _steers_for(colors, lab):
    if not STEERING:
        return [], []
    try:
        from colors import runtime as colorrack
        if not colorrack.available():
            return [], []
        norm = _normalize_colors(colors)
        steers = colorrack.resolve_steers(norm, lab=bool(lab)) if norm else []
        summary = [{"name": c["name"], "value": c["value"]} for c in norm]
        return steers, summary
    except ValueError as exc:
        raise RuntimeError(str(exc)) from exc
    except Exception as exc:
        _log(f"colorrack unavailable: {exc!r}")
        return [], []


def _resolve_blocks(sm):
    return sm.model.model.model.transformer.layers


@contextlib.contextmanager
def _steer(sm, steers):
    if not steers:
        yield {"n": 0, "applied": []}
        return

    import torch

    blocks = _resolve_blocks(sm)
    ref = next(sm.model.model.model.parameters())
    fired = {"n": 0, "applied": []}
    handles = []

    def make_hook(alpha, vec_np):
        v = (alpha * torch.as_tensor(vec_np, dtype=ref.dtype, device=ref.device)).reshape(1, 1, -1)

        def hook(_module, _inputs, output):
            fired["n"] += 1
            if isinstance(output, tuple):
                return (output[0] + v.to(output[0].dtype),) + tuple(output[1:])
            return output + v.to(output.dtype)

        return hook

    try:
        for layer_idx, alpha, vec_np in steers:
            if 0 <= int(layer_idx) < len(blocks):
                handles.append(blocks[int(layer_idx)].register_forward_hook(make_hook(alpha, vec_np)))
                fired["applied"].append({"layer": int(layer_idx), "alpha": round(float(alpha), 4)})
        yield fired
    finally:
        for h in handles:
            h.remove()


@contextlib.contextmanager
def _latent_cache(sm, source_key, report):
    orig = getattr(sm, "_encode_audio_input", None)
    if orig is None:
        yield
        return

    def shim(audio_input, audio_sample_size, inpaint_mask=None):
        pt = sm.model.pretransform
        dt = str(next(pt.parameters()).dtype)
        key = f"{source_key}|{audio_sample_size}|{dt}|{pt.io_channels}|{sm.model.sample_rate}"
        cached = _INIT_LATENT_CACHE.get(key)
        if cached is not None:
            _INIT_LATENT_CACHE.move_to_end(key)
            report["init_cache"] = "hit"
            return cached, inpaint_mask

        latents, mask = orig(audio_input, audio_sample_size, inpaint_mask)
        _INIT_LATENT_CACHE[key] = latents
        while len(_INIT_LATENT_CACHE) > LATENT_CACHE_MAX:
            _INIT_LATENT_CACHE.popitem(last=False)
        report["init_cache"] = "miss"
        return latents, mask

    try:
        sm._encode_audio_input = shim
        yield
    finally:
        sm._encode_audio_input = orig


def _load_model():
    global _MODEL
    with _lock():
        if _MODEL is not None:
            return _MODEL

        import json
        import torch
        from stable_audio_3.loading_utils import load_diffusion_cond
        from stable_audio_3.model import StableAudioModel

        model_dir = os.path.abspath(os.path.expanduser(MODEL_DIR))
        cfg_path = os.path.join(model_dir, "model_config.json")
        ckpt_path = os.path.join(model_dir, "model.safetensors")
        if not os.path.isfile(cfg_path) or not os.path.isfile(ckpt_path):
            raise FileNotFoundError(
                f"Stable Audio 3 model not found in {model_dir}; set MOSH_SA3_MODEL_DIR."
            )

        device = "cuda" if torch.cuda.is_available() else "cpu"
        use_half = USE_HALF and device == "cuda"
        with open(cfg_path, "r", encoding="utf-8") as f:
            model_config = json.load(f)

        _log(f"loading model from {model_dir} (device={device}, half={use_half})")
        t0 = time.time()
        model = load_diffusion_cond(model_config, ckpt_path, device=device, model_half=use_half)
        sa3 = StableAudioModel(model, model_config, device, use_half)
        _MODEL = (sa3, int(model.sample_rate))
        _log(f"model ready in {time.time() - t0:.1f}s (sr={_MODEL[1]})")
        return _MODEL


def _load_source(input_wav_path: str, start_sec: float, length_sec: float):
    import numpy as np
    import soundfile as sf
    import torch

    data, in_sr = sf.read(input_wav_path, dtype="float32", always_2d=True)
    if start_sec or length_sec:
        s = max(0, int(start_sec * in_sr))
        n = int(length_sec * in_sr) if length_sec > 0 else (data.shape[0] - s)
        data = data[s:s + n, :]
    tensor = torch.from_numpy(data.T.copy())
    return in_sr, tensor, np.asarray(data, dtype=np.float32)


def _source_key(data_2d, in_sr) -> str:
    import numpy as np

    h = hashlib.sha256()
    h.update(np.ascontiguousarray(data_2d, dtype=np.float32).tobytes())
    h.update(str(in_sr).encode("utf-8"))
    return h.hexdigest()[:24]


def _write_wav(path: str, audio, sr: int):
    import numpy as np
    import soundfile as sf
    import torch

    wav = audio[0].detach().to(torch.float32).cpu().transpose(0, 1).numpy()
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    target = 10.0 ** (PEAK_DBFS / 20.0)
    if peak > target and peak > 0.0:
        wav = wav * (target / peak)
    wav = np.clip(wav, -1.0, 1.0)
    sf.write(path, wav, sr, subtype="PCM_24")
    return int(wav.shape[1]), wav


def render(input_wav: str, output_wav: str, params: dict) -> dict:
    import torch

    output_wav = os.path.abspath(output_wav)
    input_wav = os.path.abspath(input_wav) if input_wav else input_wav
    os.makedirs(os.path.dirname(output_wav), exist_ok=True)

    prompt = params.get("prompt") or ""
    seed = int(params.get("seed", 0))
    steps = int(params.get("steps", 8) or 8)
    cfg = float(params.get("cfg", 1.0) or 1.0)
    nl = float(params.get("nl", 0.4) or 0.4)
    duration = min(MAX_DURATION, float(params.get("durationSec", params.get("duration_s", 4.0)) or 4.0))

    sa3, sr = _load_model()
    steers, colors_applied = _steers_for(params.get("colors"), params.get("lab", False))

    gen_kwargs = dict(
        prompt=prompt,
        duration=duration,
        steps=steps,
        cfg_scale=cfg,
        seed=seed,
        sampler_type=SAMPLER,
        chunked_decode=True,
        callback=lambda _info: None,
    )

    mode = "text_to_audio"
    src_2d = None
    in_sr = sr
    report = {}
    has_src = bool(input_wav) and os.path.isfile(input_wav)
    if has_src and params.get("nl", None) is not None:
        mode = "audio_to_audio"
        in_sr, src, src_2d = _load_source(
            input_wav,
            float(params.get("inputStartSec", 0.0) or 0.0),
            float(params.get("inputLengthSec", 0.0) or 0.0),
        )
        gen_kwargs["init_audio"] = (in_sr, src)
        gen_kwargs["init_noise_level"] = min(0.5, max(0.01, nl))

    t0 = time.time()
    with _steer(sa3, steers) as steer_info:
        if mode == "audio_to_audio":
            with _latent_cache(sa3, _source_key(src_2d, in_sr), report):
                audio = sa3.generate(**gen_kwargs)
        else:
            audio = sa3.generate(**gen_kwargs)

    channels, wav_out = _write_wav(output_wav, audio, sr)
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    q = _quality(wav_out, sr, src_2d, in_sr)
    return {
        "ok": True,
        "adapter": "stable_audio3",
        "backend": "cuda",
        "mode": mode,
        "duration_s": round(len(wav_out) / float(sr), 3),
        "sample_rate": sr,
        "channels": channels,
        "seconds_pinned": duration,
        "init_cache": report.get("init_cache", "n/a"),
        "steers": steer_info["applied"],
        "colors": colors_applied,
        "seed": seed,
        "render_sec": round(time.time() - t0, 2),
        "pq": q.get("pq"),
        "pq_base": q.get("pq_base"),
        "flags": q.get("flags", []),
        "metrics": q.get("metrics", {}),
        "judge": q.get("judge"),
    }

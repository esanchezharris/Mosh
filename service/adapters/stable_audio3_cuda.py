"""Windows CUDA backend for the canonical stable_audio3 adapter.

This keeps the public service protocol and adapter id canonical (`stable_audio3`)
while using the locally installed `stable_audio_3` CUDA package on Windows. The
CUDA package name is an internal compatibility detail.

FIT-013 parity with the MLX adapter: whole-clip coverage (loop/stitch windows
pinned to SA3_SECONDS), the LoRA rack applied at runtime in-memory on the GPU
(shared lora_merge math — bit-parity with a disk bake), the NL degenerate-render
guard, and QA on the final stitched output.
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
# One render window. Must agree with the native side's ra.winLen (render-ahead) and
# the MLX engine's pinned SA3_SECONDS — setup-sa3-cuda.ps1 persists SA3_SECONDS so
# the coupling is explicit. Long clips are covered by clip_coverage.render windows.
WINDOW_SECONDS = min(MAX_DURATION, float(os.environ.get("SA3_SECONDS", "8.0")))
# Sampler tuning is ENGINE-LEVEL config (env), NOT a per-render param — the exact
# posture of the MLX engine's SA3_STEPS. The native side no longer sends cfg/steps
# (they had no audible effect on the canonical MLX path and only busted the cache),
# so read them here and default to this backend's validated values (30 steps / cfg 7.0,
# the config the Windows SA3-CUDA selftest passed). They are deliberately out of the
# per-render params, but folded into SERVICE_BUILD (server.py) so re-tuning the env
# still invalidates cached renders — a service-build class of change.
STEPS = max(1, int(os.environ.get("MOSH_SA3_STEPS", "30")))
CFG_SCALE = float(os.environ.get("MOSH_SA3_CFG", "7.0"))

_MODEL_LOCK = None
_MODEL = None
_INIT_LATENT_CACHE: "OrderedDict[str, object]" = OrderedDict()

# Runtime LoRA state (FIT-013): mirrors sa3/engine.py's apply_loras semantics on
# torch — pristine stashes of touched params, idempotent on the selection key.
_LORA_APPLIED_KEY = None                  # None = fresh, "" = stock applied
_LORA_BASE: dict = {}                     # module name -> (param, pristine stash)
_LORA_TOUCHED: set = set()


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
        flags = q.get("flags", [])
        out = {
            "pq": q.get("pq"),
            "pq_base": None,
            "flags": flags,
            "metrics": q.get("metrics", {}),
            "judge": "dsp",
            # AL-006: human-readable readout. The DSP path is a 0–10 pq + flags (no Audiobox
            # axes), so feed those into the shared reasoning helper.
            "reasoning": judge.judge_reasoning(
                axes={"PQ": q["pq"]} if q.get("pq") is not None else None, flags=flags),
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
        _reset_lora_state()               # fresh weights: any stashes are stale
        _log(f"model ready in {time.time() - t0:.1f}s (sr={_MODEL[1]})")
        return _MODEL


# ── runtime LoRA apply (FIT-013) — torch twin of sa3/engine.py apply_loras ──────────

def _reset_lora_state():
    global _LORA_APPLIED_KEY
    _LORA_BASE.clear()
    _LORA_TOUCHED.clear()
    _LORA_APPLIED_KEY = None


def _loras_key(lora_sel) -> str:
    """Stable identity for a resolved selection ("" == stock) — must build the
    exact same string as the MLX adapter so manifests/caches agree."""
    return "|".join(f"{n}@{s}" for n, _f, s in lora_sel)


def _lora_roots(sm):
    """Candidate modules the LoRA safetensors' torch names resolve against. The
    trained tree hangs off the diffusion wrapper; serving wraps it deeper."""
    roots = []
    for path in ("model.model.model", "model.model", "model"):
        obj = sm
        for part in path.split("."):
            obj = getattr(obj, part, None)
            if obj is None:
                break
        if obj is not None and hasattr(obj, "get_parameter") and obj not in roots:
            roots.append(obj)
    return roots or [sm]


def _resolve_lora_param(roots, module: str):
    """LoRA module name -> live nn.Parameter, or None (skip+report, never fatal).
    Names are torch-native (same tree train_lora.py trained), so unlike the MLX
    path there is no npz key mapping — strip the 'model.' prefix and look up
    '<module>.weight' against the candidate roots."""
    rel = module[len("model."):] if module.startswith("model.") else module
    for root in roots:
        for name in (rel, module):
            try:
                return root.get_parameter(name + ".weight")
            except AttributeError:
                continue
    return None


def _compute_updated_torch(torch, roots, selection):
    """Updated weights for a selection, computed on the params' device via the
    shared lora_merge.apply_dora(xp=torch). Mirrors engine._compute_updated_mx:
    1x1-conv reshape (torch layout [out, in, 1]), stored-dtype cast BETWEEN
    stacked LoRAs. Returns ({module: (param, new_weight)}, report)."""
    import json

    from sa3 import lora_merge as LM

    work: dict = {}                       # module -> [param, W (stored dtype)]
    applied, skipped = 0, []
    for name, path, strength in selection:
        tensors, meta = LM.read_safetensors(path)     # numpy; rank-16 factors are tiny
        cfg = json.loads(meta.get("lora_config", "{}")) if meta else {}
        rank = float(cfg.get("rank", 16))
        alpha = float(cfg.get("alpha", cfg.get("lora_alpha", rank)))
        adapter_type = cfg.get("adapter_type", "dora-rows")
        if adapter_type not in ("dora-rows", "dora", "lora"):
            raise ValueError(f"{name}: unsupported adapter_type {adapter_type!r}")
        scaling = alpha / rank
        for module, parts in sorted(LM.group_lora(tensors).items()):
            if module not in work:
                param = _resolve_lora_param(roots, module)
                if param is None:
                    skipped.append(f"{name}:{module}")
                    continue
                work[module] = [param, param.data]
            param, W = work[module]
            if W.ndim == 3 and W.shape[2] == 1:       # torch Conv1d 1x1: [out, in, 1]
                W2 = W[:, :, 0]
            elif W.ndim == 2:
                W2 = W
            else:
                skipped.append(f"{name}:{module}")
                continue
            A, B = parts.get("lora_A"), parts.get("lora_B")
            if A is None or B is None or B.shape[0] != W2.shape[0] or A.shape[1] != W2.shape[1]:
                skipped.append(f"{name}:{module}")
                continue
            mag = None
            if adapter_type in ("dora-rows", "dora"):
                m = parts.get("magnitude")
                if m is None or m.shape[0] != W2.shape[0]:
                    skipped.append(f"{name}:{module}")
                    continue
                mag = torch.as_tensor(m, dtype=torch.float32, device=param.device)
            V = LM.apply_dora(
                torch, W2,
                torch.as_tensor(A, dtype=torch.float32, device=param.device),
                torch.as_tensor(B, dtype=torch.float32, device=param.device),
                mag, adapter_type, scaling, strength)             # f32, 2D
            V = V.to(W.dtype)             # stored-dtype cast between stacked LoRAs
            work[module] = [param, V.unsqueeze(-1) if W.ndim == 3 else V]
            applied += 1
    return ({m: (p, w) for m, (p, w) in work.items()},
            {"applied": applied, "skipped": skipped})


def _apply_loras_cuda(sm, selection, loras_key: str) -> dict:
    """engine.apply_loras semantics on the torch model: idempotent on loras_key,
    restore-then-apply, empty selection == stock. ~one param.copy_ per touched
    weight, all on-device — the strength slider stays interactive."""
    global _LORA_APPLIED_KEY
    if loras_key == _LORA_APPLIED_KEY:
        return {"applied": None, "skipped": [], "reused": True}
    import torch

    _restore_base_cuda()
    if not selection:
        _LORA_APPLIED_KEY = loras_key                 # now current (stock)
        return {"applied": 0, "skipped": [], "reused": False}
    updated, report = _compute_updated_torch(torch, _lora_roots(sm), selection)
    stash_cpu = os.environ.get("MOSH_SA3_LORA_STASH", "gpu") == "cpu"
    with torch.no_grad():
        for module, (param, V) in updated.items():
            if module not in _LORA_BASE:              # pristine stash on first touch
                stash = param.data.detach().clone()
                _LORA_BASE[module] = (param, stash.cpu() if stash_cpu else stash)
            param.data.copy_(V)
            _LORA_TOUCHED.add(module)
    _LORA_APPLIED_KEY = loras_key
    report["reused"] = False
    return report


def _restore_base_cuda() -> None:
    """Copy every touched param back to its pristine stash (stash kept for reuse)."""
    global _LORA_APPLIED_KEY
    if _LORA_TOUCHED:
        import torch
        with torch.no_grad():
            for module in list(_LORA_TOUCHED):
                param, stash = _LORA_BASE[module]
                param.data.copy_(stash.to(param.device))
        _LORA_TOUCHED.clear()
    _LORA_APPLIED_KEY = None


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

    import clip_coverage
    from adapters import stable_audio3_adapter as _canon   # NL guard constants
    from loras import registry as LR

    output_wav = os.path.abspath(output_wav)
    input_wav = os.path.abspath(input_wav) if input_wav else input_wav
    os.makedirs(os.path.dirname(output_wav), exist_ok=True)

    prompt = params.get("prompt") or ""
    seed = int(params.get("seed", 0))
    lab = bool(params.get("lab", False))   # Lab defeats the NL upper clamp (parity with the MLX adapter)
    # Engine-level sampler tuning (env), not per-render params (see STEPS/CFG_SCALE above).
    steps = STEPS
    cfg = CFG_SCALE

    sa3, sr = _load_model()
    steers, colors_applied = _steers_for(params.get("colors"), params.get("lab", False))

    # LoRA rack — runtime in-memory apply, parity with the MLX adapter (resolve
    # raises pre-GPU on a bad selection; empty == stock; idempotent on the key).
    lora_sel = LR.resolve(params.get("loras") or [], lab=bool(params.get("lab", False)))
    loras_key = _loras_key(lora_sel)
    _t0 = time.perf_counter()
    _apply_loras_cuda(sa3, lora_sel, loras_key)
    apply_ms = round((time.perf_counter() - _t0) * 1000.0, 1)

    has_src = bool(input_wav) and os.path.isfile(input_wav)
    orig_input = input_wav

    def _render_window(in_wav, out_wav, p):
        # ONE SA3 window (<= WINDOW_SECONDS). Re-imagine when this window has a
        # source + nl, else generate. clip_coverage.render slices long clips into
        # windows / one loop cycle and passes them through here.
        win_src = bool(in_wav) and os.path.isfile(in_wav)
        nl = p.get("nl", None)
        report = {}
        src_2d = None
        in_sr = sr
        gen_kwargs = dict(
            prompt=prompt,
            steps=steps,
            cfg_scale=cfg,
            seed=seed,
            sampler_type=SAMPLER,
            chunked_decode=True,
            callback=lambda _info: None,
        )
        if win_src and nl is not None:
            mode = "audio_to_audio"
            nlv = _canon.clamp_nl(float(nl), lab)   # shared guard: 0.5 cap normal, uncapped in Lab (MLX/CUDA parity)
            # Explicit slice params apply only to the caller's original file —
            # coverage windows arrive pre-sliced.
            is_orig = in_wav == orig_input
            in_sr, src, src_2d = _load_source(
                in_wav,
                float(p.get("inputStartSec", 0.0) or 0.0) if is_orig else 0.0,
                float(p.get("inputLengthSec", 0.0) or 0.0) if is_orig else 0.0,
            )
            gen_kwargs["init_audio"] = (in_sr, src)
            gen_kwargs["init_noise_level"] = nlv
            # Pinned window, like the MLX engine's SECONDS — the stitcher trims.
            gen_kwargs["duration"] = WINDOW_SECONDS
        else:
            mode = "text_to_audio"
            gen_kwargs["duration"] = min(MAX_DURATION, float(
                p.get("durationSec", p.get("duration_s", WINDOW_SECONDS)) or WINDOW_SECONDS))

        t0 = time.time()
        with _steer(sa3, steers) as steer_info:
            if mode == "audio_to_audio":
                with _latent_cache(sa3, _source_key(src_2d, in_sr), report):
                    audio = sa3.generate(**gen_kwargs)
            else:
                audio = sa3.generate(**gen_kwargs)

        channels, wav_out = _write_wav(out_wav, audio, sr)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        return {
            "ok": True,
            "adapter": "stable_audio3",
            "backend": "cuda",
            "mode": mode,
            "duration_s": round(len(wav_out) / float(sr), 3),
            "sample_rate": sr,
            "channels": channels,
            "seconds_pinned": WINDOW_SECONDS,
            "init_cache": report.get("init_cache", "n/a"),
            "steers": steer_info["applied"],
            "colors": colors_applied,
            "loras": [{"name": n, "strength": s} for (n, _f, s) in lora_sel],
            "lora_apply": "runtime",
            "apply_ms": apply_ms,
            "seed": seed,
            "render_sec": round(time.time() - t0, 2),
        }

    manifest = clip_coverage.render(_render_window, input_wav, output_wav, params, WINDOW_SECONDS)

    # Best-effort QA once, on the FINAL (tiled/stitched) output — parity with the
    # MLX adapter's qa.augment_manifest placement; the judge stays the DSP readout.
    try:
        import soundfile as sf
        wav_final, sr_final = sf.read(output_wav, dtype="float32", always_2d=True)
        src_2d, in_sr = None, sr_final
        if has_src:
            try:
                src_2d, in_sr = sf.read(orig_input, dtype="float32", always_2d=True)
            except Exception:
                src_2d = None
        q = _quality(wav_final, sr_final, src_2d, in_sr)
    except Exception as exc:
        _log(f"final QA unavailable: {exc!r}")
        q = {"pq": None, "pq_base": None, "flags": ["qa_unavailable"]}
    manifest.update({
        "pq": q.get("pq"),
        "pq_base": q.get("pq_base"),
        "flags": q.get("flags", []),
        "metrics": q.get("metrics", {}),
        "judge": q.get("judge"),
    })
    return manifest

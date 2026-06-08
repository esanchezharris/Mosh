"""StableAudio3Adapter — the real CUDA generative adapter (Tier-B).

The first REAL ``GenerativeModelAdapter`` behind the same interface the FakeAdapter
proved (``name`` / ``health()`` / ``render(request, on_progress, is_canceled)``). It
wraps the locally-installed **Stable Audio 3 Medium** CUDA model (``stable_audio_3`` in
the ComfyUI venv, weights at ``E:/comfy4_models/unet``) and supports both spec modes:

  * ``generate``  — text -> audio.
  * ``reimagine`` — audio-to-audio: encode the source loop, re-noise at
    ``init_noise_level`` (<=0.5 keeps it recognizably the same song), denoise with
    the prompt + colors. The creative core (05 §6).

THREE formerly-deferred features now shipped (the COLORRACK calibration arrived):

  1. **Real "colors" via activation steering (05 §6).** The COLORRACK runtime
     (``service/colors``) maps each color's 0-100 ASTD slider to a steering tuple
     ``(peak_layer, alpha, vec[1536])`` (ASTD-clamped; Lab mode unlocks). We inject
     ``alpha*vec`` into the residual stream of the DiT's TransformerBlock at
     ``peak_layer`` via a forward hook for the duration of one ``generate()`` call.
     This replaces the old prompt-text approximation. ``/colors`` (``colors()``)
     returns each color's ASTD ceiling so the UI can clamp its sliders.
  2. **Init-latent cache (05 §5).** For reimagine, the source VAE-encode is cached
     keyed by source content + region + size + dtype, so changing only seed / colors /
     ``init_noise_level`` reuses the encoded latents (the manifest reports hit/miss).
     Implemented by intercepting ``_encode_audio_input`` — no library patch.
  3. **Judge / quality readout (05 §7).** ``quality_readout`` scores every render
     (pq in [0,10] + flags) and, for reimagine, the source (``pqBase``) for a delta.
     A heuristic DSP proxy (numpy+soundfile) — a learned judge can override it later
     behind ``MOSH_JUDGE``.

Imported LAZILY (only when ``MOSH_ADAPTER=stable_audio_3``) so the FakeAdapter path
stays dependency-free.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
import threading
import time
from collections import OrderedDict

import numpy as np
import soundfile as sf
import torch

# service/ is on sys.path (server.py's dir) → the colorrack runtime + judge import.
try:  # real activation-steering colors (optional — degrades to no steering if absent)
    import colors.runtime as colorrack
except Exception:  # noqa: BLE001
    colorrack = None
try:
    import quality_readout as judge
except Exception:  # noqa: BLE001
    judge = None


# ── config (env-overridable; the C++ host sets these in the child process env) ──
#: Default on the SSD (cuts the ~228 s HDD cold load). Override with MOSH_SA3_MODEL_DIR.
MODEL_DIR = os.environ.get("MOSH_SA3_MODEL_DIR", "C:/mosh-models/sa3")
USE_HALF = os.environ.get("MOSH_SA3_HALF", "1") != "0"
SAMPLER = os.environ.get("MOSH_SA3_SAMPLER", "pingpong")
MAX_DURATION = float(os.environ.get("MOSH_SA3_MAX_DURATION", "12.0"))
#: Peak-normalize the output to this dBFS (SA3 output routinely exceeds full scale; a
#: hard clamp would clip — normalizing to a hair below 0 dBFS is standard SA3 practice).
PEAK_DBFS = float(os.environ.get("MOSH_SA3_PEAK_DBFS", "-0.5"))
#: Master switch for activation steering (1 = real colors; 0 = ignore colors).
STEERING = os.environ.get("MOSH_SA3_STEERING", "1") != "0"
#: Judge backend: "dsp" (heuristic readout, default), "none" (skip).
JUDGE = os.environ.get("MOSH_JUDGE", "dsp")
#: Init-latent cache capacity (entries; latents are small fp16 tensors).
LATENT_CACHE_MAX = int(os.environ.get("MOSH_SA3_LATENT_CACHE", "8"))

_MODEL_LOCK = threading.Lock()
_MODEL = None  # (sa3, sample_rate)
_INIT_LATENT_CACHE: "OrderedDict[str, object]" = OrderedDict()


def _log(msg: str) -> None:
    print(f"[sa3] {msg}", file=sys.stderr, flush=True)


class _Canceled(Exception):
    """Raised from the sampler callback to abort a render cooperatively."""


# ── colors → steering tuples (real activation steering; 05 §6) ──────────────────
def _normalize_colors(colors):
    """Accept the C++ ``[{name, value}]`` form or the legacy ``["name", ...]`` form;
    return ``[{name, value}]`` for the COLORRACK runtime."""
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


def _resolve_blocks(sm):
    """The DiT's ordered TransformerBlock list (recon-verified chain). 24 @ dim 1536."""
    return sm.model.model.model.transformer.layers


@contextlib.contextmanager
def _steer(sm, steers):
    """Inject ``alpha*vec[1536]`` into the residual stream output of each block at the
    given layer, for the duration of one generate() call. steers: [(layer, alpha, vec_np)].
    A no-op (and a clean yield) when steers is empty so callers needn't branch."""
    if not steers:
        yield {"n": 0, "applied": []}
        return
    blocks = _resolve_blocks(sm)
    ref = next(sm.model.model.model.parameters())  # dtype/device (fp16 cuda)
    fired = {"n": 0, "applied": []}
    handles = []

    def make_hook(alpha, vec_np):
        v = (alpha * torch.as_tensor(vec_np, dtype=ref.dtype, device=ref.device)).reshape(1, 1, -1)

        def hook(module, inputs, output):
            fired["n"] += 1
            if isinstance(output, tuple):  # block returns a bare tensor, but be safe
                return (output[0] + v.to(output[0].dtype),) + tuple(output[1:])
            return output + v.to(output.dtype)
        return hook

    try:
        for layer_idx, alpha, vec_np in steers:
            n = len(blocks)
            if not (0 <= layer_idx < n):
                _log(f"steer layer {layer_idx} out of range 0..{n-1}; skipping")
                continue
            handles.append(blocks[layer_idx].register_forward_hook(make_hook(alpha, vec_np)))
            fired["applied"].append({"layer": int(layer_idx), "alpha": round(float(alpha), 4)})
        yield fired
    finally:
        for h in handles:
            h.remove()


def _steers_for(colors, lab):
    """Resolve UI colors → [(layer, alpha, vec_np)] via the COLORRACK runtime.
    Returns (steers, applied_summary). Empty when steering is off/unavailable."""
    if not STEERING or colorrack is None or not colorrack.available():
        return [], []
    norm = _normalize_colors(colors)
    if not norm:
        return [], []
    try:
        steers = colorrack.resolve_steers(norm, lab=bool(lab))
    except ValueError as e:  # no_stack_with violation → surface as a render error
        raise RuntimeError(str(e)) from e
    summary = [{"name": n["name"], "value": n["value"]} for n in norm]
    return steers, summary


# ── init-latent cache (05 §5) — intercept _encode_audio_input ───────────────────
@contextlib.contextmanager
def _latent_cache(sm, source_key, report):
    """Cache the source VAE-encode by (source content+region) × (audio_sample_size,
    dtype, channels, target_sr). On a hit, reuse the encoded latents (skip the encode).
    audio_sample_size is supplied by generate(), so we never re-derive it."""
    orig = sm._encode_audio_input

    def shim(audio_input, audio_sample_size, inpaint_mask=None):
        pt = sm.model.pretransform
        dt = str(next(pt.parameters()).dtype)
        key = f"{source_key}|{audio_sample_size}|{dt}|{pt.io_channels}|{sm.model.sample_rate}"
        cached = _INIT_LATENT_CACHE.get(key)
        if cached is not None:
            _INIT_LATENT_CACHE.move_to_end(key)
            report["initLatentCache"] = "hit"
            return cached, inpaint_mask
        latents, mask = orig(audio_input, audio_sample_size, inpaint_mask)
        _INIT_LATENT_CACHE[key] = latents
        while len(_INIT_LATENT_CACHE) > LATENT_CACHE_MAX:
            _INIT_LATENT_CACHE.popitem(last=False)
        report["initLatentCache"] = "miss"
        return latents, mask

    try:
        sm._encode_audio_input = shim  # type: ignore[assignment]
        yield
    finally:
        sm._encode_audio_input = orig  # type: ignore[assignment]


def _load_model():
    global _MODEL
    with _MODEL_LOCK:
        if _MODEL is not None:
            return _MODEL

        from stable_audio_3.loading_utils import load_diffusion_cond
        from stable_audio_3.model import StableAudioModel

        model_dir = os.path.abspath(os.path.expanduser(MODEL_DIR))
        cfg_path = os.path.join(model_dir, "model_config.json")
        ckpt_path = os.path.join(model_dir, "model.safetensors")
        if not os.path.isfile(cfg_path) or not os.path.isfile(ckpt_path):
            raise FileNotFoundError(
                f"Stable Audio 3 model not found in {model_dir} "
                "(need model_config.json + model.safetensors). Set MOSH_SA3_MODEL_DIR."
            )

        device = "cuda" if torch.cuda.is_available() else "cpu"
        use_half = USE_HALF and device == "cuda"
        with open(cfg_path, "r", encoding="utf-8") as f:
            model_config = json.load(f)

        _log(f"loading model from {model_dir} (device={device}, half={use_half}) ...")
        t0 = time.time()
        model = load_diffusion_cond(model_config, ckpt_path, device=device, model_half=use_half)
        sa3 = StableAudioModel(model, model_config, device, use_half)
        _MODEL = (sa3, int(model.sample_rate))
        steer_state = "on" if (STEERING and colorrack and colorrack.available()) else "off"
        _log(f"model ready in {time.time()-t0:.1f}s (sr={_MODEL[1]}, steering={steer_state})")
        return _MODEL


def _load_source(input_wav_path: str, start_sec: float, length_sec: float):
    """Load the reimagine source as (sr, tensor[C,T]), sliced to the region."""
    data, in_sr = sf.read(input_wav_path, dtype="float32", always_2d=True)  # [frames, ch]
    if start_sec or length_sec:
        s = max(0, int(start_sec * in_sr))
        n = int(length_sec * in_sr) if length_sec > 0 else (data.shape[0] - s)
        data = data[s:s + n, :]
    tensor = torch.from_numpy(data.T.copy())  # [C, T]
    return in_sr, tensor, data  # data = [frames, ch] for hashing + pq_base


def _source_key(data_2d, in_sr) -> str:
    """Content hash of the sliced source region (captures both file content + slice)."""
    h = hashlib.sha256()
    h.update(np.ascontiguousarray(data_2d, dtype=np.float32).tobytes())
    h.update(str(in_sr).encode())
    return h.hexdigest()[:24]


def _write_wav(path: str, audio: torch.Tensor, sr: int):
    """audio: [B, C, T]. Peak-normalize to PEAK_DBFS, write 24-bit PCM.
    Returns (channels, wav[T,C]) so the caller can score it without re-reading."""
    wav = audio[0].detach().to(torch.float32).cpu().transpose(0, 1).numpy()  # [T, C]
    peak = float(np.max(np.abs(wav))) if wav.size else 0.0
    target = 10.0 ** (PEAK_DBFS / 20.0)
    if peak > target and peak > 0.0:
        wav = wav * (target / peak)               # avoid hard clipping (SA3 exceeds 1.0)
    wav = np.clip(wav, -1.0, 1.0)
    sf.write(path, wav, sr, subtype="PCM_24")
    return int(wav.shape[1]), wav


def _score_source_learned(lj, src_2d, in_sr):
    """Write the reimagine source region to a temp WAV and learned-score its PQ."""
    import tempfile
    tmp = os.path.join(tempfile.gettempdir(), f"mosh_judge_src_{os.getpid()}.wav")
    try:
        sf.write(tmp, src_2d, in_sr, subtype="PCM_24")
        learned = lj.score(tmp)
        return float(learned["PQ"]) if learned and "PQ" in learned else None
    except Exception:  # noqa: BLE001
        return None
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _quality(wav_out, sr, src_2d, in_sr, out_path):
    """pq/flags for the output (+ pqBase for a reimagine source). Best-effort.

    The DSP readout (flags + a fallback pq) is ALWAYS computed. When MOSH_JUDGE=learned,
    Meta's Audiobox-Aesthetics PQ (via the producer-lab sidecar) OVERRIDES the pq while
    the DSP flags are kept — a learned aesthetic score plus signal-hygiene flags. Any
    sidecar failure silently leaves the DSP pq (graceful degrade)."""
    if JUDGE == "none" or judge is None:
        return {}
    try:
        dsp = judge.analyze_array(wav_out, sr)
    except Exception as exc:  # noqa: BLE001 — QA must never fail a render
        _log(f"dsp readout failed: {exc!r}")
        return {}

    q = {"pq": dsp["pq"], "flags": dsp["flags"], "metrics": dsp["metrics"], "judge": "dsp"}
    pq_base = None
    if src_2d is not None:
        try:
            pq_base = judge.analyze_array(src_2d, in_sr)["pq"]
        except Exception:  # noqa: BLE001
            pq_base = None

    if JUDGE == "learned":
        lj = judge.learned_judge()
        learned = lj.score(out_path)
        if learned and "PQ" in learned:
            q["pq"] = round(float(learned["PQ"]), 2)
            q["judge"] = "audiobox"
            q["aesthetics"] = {k: round(float(learned[k]), 2)
                               for k in ("PQ", "PC", "CE", "CU") if k in learned}
            if src_2d is not None:
                base = _score_source_learned(lj, src_2d, in_sr)
                if base is not None:
                    pq_base = base
        else:
            _log("learned judge unavailable → DSP pq")

    if pq_base is not None and q["pq"] is not None:
        q["pqBase"] = round(float(pq_base), 2)
        q["pqDelta"] = round(q["pq"] - q["pqBase"], 2)
    return q


class StableAudio3Adapter:
    name = "stable_audio_3"

    def health(self) -> dict:
        steer_on = bool(STEERING and colorrack and colorrack.available())
        return {
            "generate": True,
            "reimagine": True,
            "colors": steer_on,
            "judge": JUDGE if judge is not None else "none",
            "initLatentCache": True,
        }

    def colors(self) -> list:
        """The /colors descriptor: each color's ASTD ceiling + metadata for the UI."""
        if colorrack is None or not colorrack.available():
            return []
        return colorrack.descriptor()

    def warmup(self) -> None:
        try:
            _load_model()
        except Exception as exc:  # noqa: BLE001 - warmup is best-effort
            _log(f"warmup failed (will retry on first render): {exc!r}")
        # Preload the learned judge sidecar (its model load is also slow) so the first
        # scored render isn't a stall. Best-effort — falls back to DSP if it fails.
        if JUDGE == "learned" and judge is not None:
            try:
                judge.learned_judge().warmup()
            except Exception as exc:  # noqa: BLE001
                _log(f"learned judge warmup failed (will fall back to DSP): {exc!r}")

    def render(self, request: dict, on_progress, is_canceled):
        job_id = request["jobId"]
        cache_key = request["cacheKey"]
        out_dir = request["outDir"]
        mode = request.get("mode", "generate")
        prompt = request.get("prompt", "")
        seed = int(request.get("seed", 0))
        duration = min(MAX_DURATION, float(request.get("durationSec", 4.0) or 4.0))
        steps = int(request.get("steps", 8) or 8)
        cfg = float(request.get("cfg", 1.0) or 1.0)
        nl = float(request.get("nl", 0.4) or 0.4)

        os.makedirs(out_dir, exist_ok=True)
        wav_path = os.path.join(out_dir, f"{job_id}.wav")
        manifest_path = os.path.join(out_dir, f"{job_id}.manifest.json")

        sa3, sr = _load_model()
        on_progress(0.02)
        if is_canceled():
            return None

        # Real colors → steering tuples (ASTD-clamped; Lab unlocks). Empty = no steer.
        steers, colors_applied = _steers_for(request.get("colors"), request.get("lab", False))

        def cb(info):
            if is_canceled():
                raise _Canceled()
            i = int(info.get("i", 0))
            on_progress(0.05 + 0.80 * min(1.0, (i + 1) / max(1, steps)))

        gen_kwargs = dict(
            prompt=prompt, duration=duration, steps=steps, cfg_scale=cfg, seed=seed,
            sampler_type=SAMPLER, chunked_decode=True, callback=cb,
        )

        src_2d = None
        in_sr = sr
        source_key = None
        report = {}
        if mode == "reimagine":
            in_path = request.get("inputWavPath", "")
            if not in_path or not os.path.isfile(in_path):
                raise FileNotFoundError(f"reimagine requires inputWavPath; got {in_path!r}")
            in_sr, src, src_2d = _load_source(
                in_path, float(request.get("inputStartSec", 0.0) or 0.0),
                float(request.get("inputLengthSec", 0.0) or 0.0),
            )
            source_key = _source_key(src_2d, in_sr)
            gen_kwargs["init_audio"] = (in_sr, src)
            gen_kwargs["init_noise_level"] = min(0.5, max(0.0, nl))

        try:
            t0 = time.time()
            with _steer(sa3, steers) as steer_info:
                if mode == "reimagine":
                    with _latent_cache(sa3, source_key, report):
                        audio = sa3.generate(**gen_kwargs)
                else:
                    audio = sa3.generate(**gen_kwargs)
        except _Canceled:
            _cleanup(wav_path)
            return None
        except torch.cuda.OutOfMemoryError as e:  # pragma: no cover - hardware dependent
            torch.cuda.empty_cache()
            raise RuntimeError(
                "Stable Audio 3 ran out of VRAM. Try a shorter duration or free GPU memory."
            ) from e

        if is_canceled():
            _cleanup(wav_path)
            return None

        on_progress(0.90)
        channels, wav_out = _write_wav(wav_path, audio, sr)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        quality = _quality(wav_out, sr, src_2d, in_sr, wav_path)

        manifest = {
            "wavPath": wav_path,
            "manifestPath": manifest_path,
            "cacheKey": cache_key,
            "adapter": self.name,
            "mode": mode,
            "durationSec": duration,
            "sampleRate": sr,
            "channels": channels,
            "seed": seed,
            "renderSec": round(time.time() - t0, 2),
            "colors": colors_applied,
            "steering": steer_info["applied"],
            "lab": bool(request.get("lab", False)),
        }
        manifest.update(quality)
        if "initLatentCache" in report:
            manifest["initLatentCache"] = report["initLatentCache"]
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, sort_keys=True)

        on_progress(1.0)
        _log(f"job {job_id[:8]} {mode} done in {manifest['renderSec']}s "
             f"steers={steer_info['applied']} cache={report.get('initLatentCache','-')} "
             f"pq={quality.get('pq','-')} -> {wav_path}")
        return manifest


def _cleanup(wav_path: str) -> None:
    try:
        os.remove(wav_path)
    except OSError:
        pass

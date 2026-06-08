"""StableAudio3Adapter — the real CUDA generative adapter (Tier-B).

The first REAL ``GenerativeModelAdapter`` behind the same interface the FakeAdapter
proved (``name`` / ``health()`` / ``render(request, on_progress, is_canceled)``). It
wraps the locally-installed **Stable Audio 3 Medium** CUDA model (the user's machine:
``stable_audio_3`` in the ComfyUI venv, weights at ``E:/comfy4_models/unet``) and
supports both spec modes:

  * ``generate``  — text -> audio.
  * ``reimagine`` — audio-to-audio: encode the source loop, re-noise at
    ``init_noise_level`` (<=0.5 keeps it recognizably the same song), denoise with
    the prompt. This is the creative core (05 §6).

This module imports torch + stable_audio_3, so it is imported LAZILY (only when
``MOSH_ADAPTER=stable_audio_3``) — the FakeAdapter path stays dependency-free.

v0 limitations (documented, deferred):
  * "colors" are approximated as prompt text (a small name->phrase table). Real
    activation-steering needs the COLORRACK_DATA calibration, which is not present.
  * the judge-panel quality readout (pq/flags) is omitted (needs the judge venv).
  * init-latent caching (skip VAE re-encode on seed-only change) is not implemented;
    correctness comes from the C++ full-fingerprint RenderCache.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time

import numpy as np
import soundfile as sf
import torch


# ── config (env-overridable; the C++ host sets these in the child process env) ──
MODEL_DIR = os.environ.get("MOSH_SA3_MODEL_DIR", "E:/comfy4_models/unet")
USE_HALF = os.environ.get("MOSH_SA3_HALF", "1") != "0"
SAMPLER = os.environ.get("MOSH_SA3_SAMPLER", "pingpong")
#: Hard cap on render length — VRAM on a 12 GB card is tight (a 4 s generate peaks
#: ~12 GB during the first compile); longer durations risk OOM. Override per machine.
MAX_DURATION = float(os.environ.get("MOSH_SA3_MAX_DURATION", "12.0"))

#: A loaded StableAudioModel is cached for the service-process lifetime so the
#: ~9 GB load (slow from an HDD) is paid once, not per render.
_MODEL_LOCK = threading.Lock()
_MODEL = None  # (sa3, sample_rate)


def _log(msg: str) -> None:
    print(f"[sa3] {msg}", file=sys.stderr, flush=True)


class _Canceled(Exception):
    """Raised from the sampler callback to abort a render cooperatively."""


# ── v0 "colors" -> prompt-text approximation (real steering deferred) ───────────
_COLOR_PHRASES = {
    "grit": "gritty, distorted, saturated",
    "air": "airy, open high-end, breathy",
    "brightness": "bright, crisp, present",
    "aggression": "aggressive, hard-hitting",
    "distortion": "distorted, overdriven",
    "epic": "epic, cinematic, huge",
    "drum_aggression": "punchy aggressive drums",
    "grid_tightness": "tight, quantized, on-grid",
}


def _augment_prompt(prompt: str, colors) -> str:
    if not colors:
        return prompt
    extra = [_COLOR_PHRASES.get(str(c).strip(), str(c).strip()) for c in colors if str(c).strip()]
    extra = [e for e in extra if e]
    return (prompt + ", " + ", ".join(extra)) if extra else prompt


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
        _log(f"model ready in {time.time()-t0:.1f}s (sample_rate={_MODEL[1]})")
        return _MODEL


def _load_source(input_wav_path: str, start_sec: float, length_sec: float):
    """Load the reimagine source as (sample_rate, tensor[C,T]), sliced to the region."""
    data, in_sr = sf.read(input_wav_path, dtype="float32", always_2d=True)  # [frames, channels]
    if start_sec or length_sec:
        s = max(0, int(start_sec * in_sr))
        n = int(length_sec * in_sr) if length_sec > 0 else (data.shape[0] - s)
        data = data[s:s + n, :]
    tensor = torch.from_numpy(data.T.copy())  # [C, T]
    return in_sr, tensor


def _write_wav(path: str, audio: torch.Tensor, sr: int) -> int:
    """audio: [B, C, T] in [-1, 1]. Writes 24-bit PCM. Returns channel count."""
    wav = audio[0].detach().to(torch.float32).cpu().clamp(-1, 1).transpose(0, 1).numpy()  # [T, C]
    sf.write(path, wav, sr, subtype="PCM_24")
    return int(wav.shape[1])


class StableAudio3Adapter:
    name = "stable_audio_3"

    def health(self) -> dict:
        return {"generate": True, "reimagine": True}

    def warmup(self) -> None:
        """Preload the model (the ~9 GB load is slow from an HDD). Called in a
        background thread at service startup so the first render isn't a long stall."""
        try:
            _load_model()
        except Exception as exc:  # noqa: BLE001 - warmup is best-effort
            _log(f"warmup failed (will retry on first render): {exc!r}")

    def render(self, request: dict, on_progress, is_canceled):
        job_id = request["jobId"]
        cache_key = request["cacheKey"]
        out_dir = request["outDir"]
        mode = request.get("mode", "generate")
        prompt = _augment_prompt(request.get("prompt", ""), request.get("colors"))
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

        # Per-step progress + cooperative cancel. Sampling occupies ~[0.05, 0.85];
        # leave headroom for the VAE decode/write (no callback fires there).
        def cb(info):
            if is_canceled():
                raise _Canceled()
            i = int(info.get("i", 0))
            on_progress(0.05 + 0.80 * min(1.0, (i + 1) / max(1, steps)))

        gen_kwargs = dict(
            prompt=prompt, duration=duration, steps=steps, cfg_scale=cfg, seed=seed,
            sampler_type=SAMPLER, chunked_decode=True, callback=cb,
        )

        if mode == "reimagine":
            in_path = request.get("inputWavPath", "")
            if not in_path or not os.path.isfile(in_path):
                raise FileNotFoundError(f"reimagine requires inputWavPath; got {in_path!r}")
            in_sr, src = _load_source(
                in_path, float(request.get("inputStartSec", 0.0) or 0.0),
                float(request.get("inputLengthSec", 0.0) or 0.0),
            )
            gen_kwargs["init_audio"] = (in_sr, src)
            gen_kwargs["init_noise_level"] = min(0.5, max(0.0, nl))

        try:
            t0 = time.time()
            audio = sa3.generate(**gen_kwargs)
        except _Canceled:
            _cleanup(wav_path)
            return None
        except torch.cuda.OutOfMemoryError as e:  # pragma: no cover - hardware dependent
            torch.cuda.empty_cache()
            raise RuntimeError(
                "Stable Audio 3 ran out of VRAM. Try a shorter duration or free GPU memory."
            ) from e
        finally:
            pass

        if is_canceled():
            _cleanup(wav_path)
            return None

        on_progress(0.90)
        channels = _write_wav(wav_path, audio, sr)
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

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
        }
        with open(manifest_path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, sort_keys=True)

        on_progress(1.0)
        _log(f"job {job_id[:8]} {mode} done in {manifest['renderSec']}s -> {wav_path}")
        return manifest


def _cleanup(wav_path: str) -> None:
    try:
        os.remove(wav_path)
    except OSError:
        pass

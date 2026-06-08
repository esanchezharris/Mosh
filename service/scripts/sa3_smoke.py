#!/usr/bin/env python3
"""Standalone CUDA smoke test for Stable Audio 3 (Phase 0 de-risk).

Run with the ComfyUI venv python (which has torch+cu130 and stable_audio_3):

    & C:\\ComfyUI\\venv\\Scripts\\python.exe service\\scripts\\sa3_smoke.py

Proves, BEFORE any Mosh integration:
  1. the model loads from E:/comfy4_models/unet on the RTX 4070 in fp16,
  2. text->audio `generate` works + a per-step `callback` fires (progress/cancel hook),
  3. audio-to-audio "reimagine" works via `init_audio=(sr, tensor)` + `init_noise_level`,
and reports VRAM + wall-clock so we know the real latency the async render must hide.
"""

from __future__ import annotations

import json
import math
import os
import time

import torch

MODEL_DIR = os.environ.get("MOSH_SA3_MODEL_DIR", "E:/comfy4_models/unet")
OUT_DIR = os.path.join(os.path.dirname(__file__), "_sa3_smoke_out")
USE_HALF = os.environ.get("MOSH_SA3_HALF", "1") != "0"


def log(msg: str) -> None:
    print(f"[sa3_smoke] {msg}", flush=True)


def vram() -> str:
    if not torch.cuda.is_available():
        return "no-cuda"
    free, total = torch.cuda.mem_get_info()
    used = (total - free) / (1024**3)
    return f"{used:.2f} GB used / {total/(1024**3):.2f} GB"


def load_model():
    from stable_audio_3.loading_utils import load_diffusion_cond
    from stable_audio_3.model import StableAudioModel

    cfg = os.path.join(MODEL_DIR, "model_config.json")
    ckpt = os.path.join(MODEL_DIR, "model.safetensors")
    assert os.path.isfile(cfg), f"missing {cfg}"
    assert os.path.isfile(ckpt), f"missing {ckpt}"

    device = "cuda" if torch.cuda.is_available() else "cpu"
    use_half = USE_HALF and device == "cuda"
    with open(cfg, "r", encoding="utf-8") as f:
        model_config = json.load(f)

    log(f"loading model from {MODEL_DIR} (device={device}, half={use_half}) ...")
    t0 = time.time()
    model = load_diffusion_cond(model_config, ckpt, device=device, model_half=use_half)
    sa3 = StableAudioModel(model, model_config, device, use_half)
    log(f"model ready in {time.time()-t0:.1f}s  sample_rate={model.sample_rate}  VRAM {vram()}")
    return sa3, device


def make_progress_cb(label: str, total_steps: int):
    seen = {"n": 0}

    def cb(info):
        i = int(info.get("i", seen["n"]))
        seen["n"] = i + 1
        pct = (i + 1) / max(1, total_steps)
        log(f"  {label} step {i+1}/{total_steps}  ({pct*100:.0f}%)")

    return cb


def save_wav(path: str, audio: torch.Tensor, sr: int) -> None:
    # torchaudio.save needs torchcodec (not installed); soundfile is present and
    # writes float->PCM cleanly. soundfile wants [frames, channels].
    import soundfile as sf

    # audio is [B, C, T]; take batch 0 -> [C, T] -> [T, C] float32 in [-1, 1].
    wav = audio[0].detach().to(torch.float32).cpu().clamp(-1, 1).transpose(0, 1).numpy()
    sf.write(path, wav, sr, subtype="PCM_24")
    log(f"  wrote {path}  shape={tuple(wav.shape)}")


def synth_source(sr: int, seconds: float = 4.0) -> torch.Tensor:
    """A simple stereo source loop (two detuned saw-ish tones) to feed reimagine."""
    n = int(sr * seconds)
    t = torch.linspace(0, seconds, n)
    left = 0.3 * torch.sign(torch.sin(2 * math.pi * 110.0 * t))
    right = 0.3 * torch.sin(2 * math.pi * 220.5 * t)
    return torch.stack([left, right], dim=0)  # [2, T]


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    log(f"torch {torch.__version__}  cuda_available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        log(f"GPU: {torch.cuda.get_device_name(0)}  VRAM {vram()}")

    sa3, device = load_model()
    sr = int(sa3.model.sample_rate)
    steps = 8

    # 1) text -> audio
    log("GENERATE: text -> audio (4s, 8 steps)")
    t0 = time.time()
    gen = sa3.generate(
        prompt="a punchy lo-fi hip hop drum loop, vinyl crackle, 90 bpm",
        duration=4.0, steps=steps, cfg_scale=1.0, seed=42,
        sampler_type="pingpong", chunked_decode=True,
        callback=make_progress_cb("generate", steps),
    )
    log(f"GENERATE done in {time.time()-t0:.1f}s  VRAM {vram()}")
    save_wav(os.path.join(OUT_DIR, "generate.wav"), gen, sr)
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # 2) audio -> audio "reimagine" (init_audio + init_noise_level <= 0.5)
    log("REIMAGINE: audio -> audio (init_noise_level=0.4)")
    src = synth_source(sr, 4.0)
    save_wav(os.path.join(OUT_DIR, "reimagine_source.wav"), src.unsqueeze(0), sr)
    t0 = time.time()
    re = sa3.generate(
        prompt="warm tape-saturated synth pad, gritty, analog",
        duration=4.0, steps=steps, cfg_scale=1.0, seed=7,
        sampler_type="pingpong", chunked_decode=True,
        init_audio=(sr, src), init_noise_level=0.4,
        callback=make_progress_cb("reimagine", steps),
    )
    log(f"REIMAGINE done in {time.time()-t0:.1f}s  VRAM {vram()}")
    save_wav(os.path.join(OUT_DIR, "reimagine.wav"), re, sr)

    log("SMOKE TEST PASSED — generate + reimagine both produced audio.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

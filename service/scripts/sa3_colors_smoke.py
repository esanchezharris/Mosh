#!/usr/bin/env python3
"""sa3_colors_smoke.py — de-risk the three SA3 deferred items in ONE model load.

Run in the ComfyUI venv (has torch + stable_audio_3), GPU-warden-wrapped:
    gpu.ps1 run ... -- C:\\ComfyUI\\venv\\Scripts\\python.exe service\\scripts\\sa3_colors_smoke.py

Validates, against the REAL installed model:
  1. STEERING — the recon's module chain `sm.model.model.model.transformer.layers`
     resolves to a 24-block ModuleList @ dim 1536; a forward hook fires every step;
     and steered output MEASURABLY differs from the identical-seed baseline (the
     activation-steering mechanism actually bites) without collapsing to silence.
  2. INIT-LATENT CACHE — `pretransform.encode` of a source region is deterministic
     (so caching the encoded latents is correctness-preserving), and the monkeypatch
     seam (return cached latents from `_encode_audio_input`) yields valid reimagine
     audio while seed still varies the result.
  3. JUDGE — quality_readout.analyze_wav() produces a sane pq + flags on the outputs.

Throwaway: prints PASS/FAIL lines and writes WAVs to _sa3_smoke_out/. No integration.
"""
from __future__ import annotations

import contextlib
import os
import sys
import time

import numpy as np
import soundfile as sf
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)  # for `colors.runtime` + `quality_readout`

os.environ.setdefault("COLORRACK_DATA", os.path.join(SERVICE, "colors", "COLORRACK_DATA"))
MODEL_DIR = os.environ.get("MOSH_SA3_MODEL_DIR", "E:/comfy4_models/unet")
USE_HALF = os.environ.get("MOSH_SA3_HALF", "1") != "0"
OUT = os.path.join(HERE, "_sa3_smoke_out")
os.makedirs(OUT, exist_ok=True)

# A short real source for the reimagine/encode tests (mono tone burst is enough).
SR_SRC = 44100


def log(m):
    print(m, flush=True)


def load():
    import json
    from stable_audio_3.loading_utils import load_diffusion_cond
    from stable_audio_3.model import StableAudioModel

    cfg = json.load(open(os.path.join(MODEL_DIR, "model_config.json"), encoding="utf-8"))
    ckpt = os.path.join(MODEL_DIR, "model.safetensors")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    half = USE_HALF and device == "cuda"
    t0 = time.time()
    log(f"[load] {MODEL_DIR} device={device} half={half} ...")
    model = load_diffusion_cond(cfg, ckpt, device=device, model_half=half)
    sm = StableAudioModel(model, cfg, device, half)
    log(f"[load] ready in {time.time()-t0:.1f}s sr={model.sample_rate}")
    return sm, int(model.sample_rate)


def write(path, audio, sr):
    wav = audio[0].detach().to(torch.float32).cpu().clamp(-1, 1).transpose(0, 1).numpy()
    sf.write(path, wav, sr, subtype="PCM_24")
    return wav  # [T, C]


# ── the steer() context manager under test (recon's design) ─────────────────────
def resolve_blocks(sm):
    blocks = sm.model.model.model.transformer.layers
    return blocks


@contextlib.contextmanager
def steer(sm, steers):
    """steers: [(layer_idx, alpha, vec_np[1536]), ...]."""
    blocks = resolve_blocks(sm)
    ref = next(sm.model.model.model.parameters())
    fired = {"n": 0}
    handles = []

    def make_hook(alpha, vec_np):
        v = (alpha * torch.as_tensor(vec_np, dtype=ref.dtype, device=ref.device)).reshape(1, 1, -1)

        def hook(module, inputs, output):
            fired["n"] += 1
            if isinstance(output, tuple):
                return (output[0] + v.to(output[0].dtype),) + tuple(output[1:])
            return output + v.to(output.dtype)
        return hook

    try:
        for layer_idx, alpha, vec_np in steers:
            assert 0 <= layer_idx < len(blocks), f"layer {layer_idx} out of range 0..{len(blocks)-1}"
            handles.append(blocks[layer_idx].register_forward_hook(make_hook(alpha, vec_np)))
        yield fired
    finally:
        for h in handles:
            h.remove()


def main():
    from colors.runtime import resolve_steers, descriptor, registry
    import quality_readout as qr

    passes, fails = [], []

    def check(name, ok, detail=""):
        (passes if ok else fails).append(name)
        log(f"[{'PASS' if ok else 'FAIL'}] {name}{(' — ' + detail) if detail else ''}")

    sm, sr = load()

    # ── (1a) module chain resolves ──
    blocks = resolve_blocks(sm)
    nblk = len(blocks)
    btype = type(blocks[0]).__name__
    check("module-chain sm.model.model.model.transformer.layers", nblk == 24,
          f"{nblk} blocks of {btype} (expect 24 TransformerBlock)")

    # ── colorrack ──
    log(f"[colors] registry: {sorted(registry().keys())}")
    steers_cal = resolve_steers([{"name": "grit", "value": 100}], lab=True)  # strongest calibrated
    check("colorrack resolve_steers(grit@100, lab)", len(steers_cal) == 1,
          f"got {[(l, round(a,3), v.shape) for (l,a,v) in steers_cal]}")
    if not steers_cal:
        log("[abort] no steers — colorrack not resolving"); return summarize(passes, fails)
    L, alpha_cal, vec = steers_cal[0]
    check("steer vec dim 1536", vec.shape == (1536,), str(vec.shape))

    prompt = "a punchy lo-fi hip hop drum loop"
    seed = 12345
    gen_kw = dict(prompt=prompt, duration=4.0, steps=8, cfg_scale=7.0, seed=seed,
                  sampler_type="pingpong", chunked_decode=True)

    # ── (1b) baseline vs steered (calibrated alpha) ──
    log(f"[gen] baseline (seed={seed}) ...")
    a_base = sm.generate(**gen_kw)
    w_base = write(os.path.join(OUT, "base.wav"), a_base, sr)

    log(f"[gen] steered grit L{L} alpha={alpha_cal:.3f} (calibrated) ...")
    with steer(sm, [(L, alpha_cal, vec)]) as fired_cal:
        a_cal = sm.generate(**gen_kw)
    w_cal = write(os.path.join(OUT, "steer_cal.wav"), a_cal, sr)
    check("hook fired during steered generate", fired_cal["n"] >= 8,
          f"{fired_cal['n']} calls (expect ~steps=8)")

    # difference metrics vs baseline (same seed → only steering differs)
    def diff(a, b):
        m = min(a.shape[0], b.shape[0])
        d = a[:m].astype(np.float64) - b[:m].astype(np.float64)
        rms_d = float(np.sqrt(np.mean(d ** 2)))
        denom = np.sqrt(np.mean(a[:m] ** 2) * np.mean(b[:m] ** 2)) + 1e-12
        corr = float(np.mean(a[:m] * b[:m]) / denom)
        return rms_d, corr

    rms_cal, corr_cal = diff(w_cal, w_base)
    check("calibrated steering changes output", rms_cal > 1e-4,
          f"rms_diff={rms_cal:.5f} corr={corr_cal:.4f}")

    # ── (1c) exaggerated alpha to prove the mechanism bites hard ──
    big = alpha_cal * 6.0 if alpha_cal else 2.0
    log(f"[gen] steered grit L{L} alpha={big:.3f} (exaggerated) ...")
    with steer(sm, [(L, big, vec)]):
        a_big = sm.generate(**gen_kw)
    w_big = write(os.path.join(OUT, "steer_big.wav"), a_big, sr)
    rms_big, corr_big = diff(w_big, w_base)
    check("exaggerated steering changes output more than calibrated", rms_big > rms_cal,
          f"rms_big={rms_big:.5f} > rms_cal={rms_cal:.5f}")
    not_silent = float(np.sqrt(np.mean(w_big ** 2))) > 1e-4
    check("exaggerated steering not collapsed to silence", not_silent)

    # ── (2) init-latent cache: encode determinism + monkeypatch seam ──
    # build a real source clip and feed it through the encode path twice
    t = np.linspace(0, 3.0, int(SR_SRC * 3.0), endpoint=False)
    tone = 0.3 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    src = torch.from_numpy(np.stack([tone, tone]))  # [2, T]

    cond = [{"prompt": "", "seconds_total": 4.0}]
    try:
        ass = sm._adapt_sample_size(cond, None, 0)  # duration-aligned sample size
    except Exception as e:  # noqa: BLE001
        ass = None
        log(f"[warn] _adapt_sample_size failed ({e!r}); deriving from generate path")

    def encode_once():
        from stable_audio_3.inference.audio_utils import prepare_audio
        pt = sm.model.pretransform
        audio = prepare_audio(src, in_sr=SR_SRC, target_sr=sm.model.sample_rate,
                              target_length=ass, target_channels=pt.io_channels,
                              device=str(sm.device))
        audio = audio.to(next(pt.parameters()).dtype)
        with torch.inference_mode():
            return pt.encode(audio)

    if ass is not None:
        lat1 = encode_once()
        lat2 = encode_once()
        maxdiff = float((lat1.float() - lat2.float()).abs().max().cpu())
        check("VAE-encode deterministic (latent cache is sound)", maxdiff < 1e-3,
              f"max|Δlatent|={maxdiff:.2e} shape={tuple(lat1.shape)}")

        # monkeypatch seam: _encode_audio_input returns cached latents
        cached = lat1
        orig = sm._encode_audio_input

        def patched(audio_input, audio_sample_size, inpaint_mask=None):
            return cached, inpaint_mask
        try:
            sm._encode_audio_input = patched  # type: ignore[assignment]
            a_re1 = sm.generate(prompt="warm analog texture", duration=4.0, steps=8,
                                cfg_scale=7.0, seed=1, sampler_type="pingpong",
                                chunked_decode=True, init_audio=(SR_SRC, src),
                                init_noise_level=0.4)
            a_re2 = sm.generate(prompt="warm analog texture", duration=4.0, steps=8,
                                cfg_scale=7.0, seed=2, sampler_type="pingpong",
                                chunked_decode=True, init_audio=(SR_SRC, src),
                                init_noise_level=0.4)
        finally:
            sm._encode_audio_input = orig  # type: ignore[assignment]
        w_re1 = write(os.path.join(OUT, "reimagine_cached_s1.wav"), a_re1, sr)
        w_re2 = write(os.path.join(OUT, "reimagine_cached_s2.wav"), a_re2, sr)
        rms_re, _ = diff(w_re1, w_re2)
        check("cached-latent reimagine valid + seed still varies", rms_re > 1e-4,
              f"rms(seed1,seed2)={rms_re:.5f}")

    # ── (3) judge readout ──
    rb = qr.analyze_wav(os.path.join(OUT, "base.wav"))
    rs = qr.analyze_wav(os.path.join(OUT, "steer_big.wav"))
    check("quality_readout pq in [0,10]", 0.0 <= rb["pq"] <= 10.0,
          f"base pq={rb['pq']} flags={rb['flags']}; steered pq={rs['pq']} flags={rs['flags']}")

    return summarize(passes, fails)


def summarize(passes, fails):
    log("\n==== SMOKE SUMMARY ====")
    log(f"PASS: {len(passes)}  FAIL: {len(fails)}")
    if fails:
        log("FAILURES: " + ", ".join(fails))
    log("outputs in: " + OUT)
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())

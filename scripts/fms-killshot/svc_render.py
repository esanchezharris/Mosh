#!/usr/bin/env python3
"""SVC render (the finish-my-song CORE, post-pivot 2026-07-06).

A decent sung GUIDE + a short VOICE REFERENCE -> a clean render of that performance in the
reference's voice, entirely local on the Mac (SoulX-Singer-SVC via the MLX/MPS bridge). SVC is
audio->audio: it PRESERVES the guide's melody/rhythm/words and just re-voices+cleans it — no
score authoring, no forced alignment, no F0-snapping (the matrix proved this beats score-mode
reconstruction on any real sing: mainvox clear-take words 38/54 vs score 28/54, timing 0.876).

Runs under the SoulX-Singer-MLX bridge venv. Set SOULX_MAC_DIR to the bridge root
(default ~/AI/soulx-mac). Requires the bf16 checkpoint + rmvpe.pt already downloaded (see the
[[soulx-on-mac-mlx]] memory / bring-up).

  cd $SOULX_MAC_DIR/SoulX-Singer-MLX && PYTHONPATH=. PYTORCH_ENABLE_MPS_FALLBACK=1 \
    $SOULX_MAC_DIR/venv/bin/python <this> --guide guide.wav --ref voice_ref.wav --out clean.wav

GOTCHAs baked in: SVC needs explicit --n_steps/--cfg (bridge hasattr bug); no --fp16/--auto_shift
on Mac; a ≤10s reference (a 30s prompt crashes the MPS STFT); output is peak-normalized (SVC can
run hot ~1.0).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile

MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
BRIDGE = os.path.join(MAC, "SoulX-Singer-MLX")
VENV_PY = os.path.join(MAC, "venv/bin/python")
MODEL = os.path.join(BRIDGE, "models/SoulX-Singer-bf16")
RMVPE = os.path.join(BRIDGE, "pretrained_models/SoulX-Singer-Preprocess/rmvpe/rmvpe.pt")


def extract_f0(wav: str, out_npy: str):
    sys.path.insert(0, BRIDGE)
    from preprocess.tools.f0_extraction import F0Extractor
    pe = F0Extractor(model_path=RMVPE, is_half=False, device="mps", target_sr=24000, hop_size=480)
    pe.process(wav, f0_path=out_npy)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--guide", required=True, help="the sung take to clean (any length)")
    ap.add_argument("--ref", required=True, help="short voice reference (≤10s) to render in")
    ap.add_argument("--out", required=True, help="output wav path")
    ap.add_argument("--n_steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=3.0)
    ap.add_argument("--peak", type=float, default=0.95, help="peak-normalize target")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        gf0, rf0 = os.path.join(td, "guide_f0.npy"), os.path.join(td, "ref_f0.npy")
        print("extracting F0 (guide + ref) …", flush=True)
        extract_f0(os.path.abspath(args.guide), gf0)
        extract_f0(os.path.abspath(args.ref), rf0)

        save_dir = os.path.join(td, "svc")
        env = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")
        cmd = [VENV_PY, os.path.join(BRIDGE, "scripts/inference_mlx_bridge.py"),
               "--model", MODEL, "--component", "svc", "--device", "mps",
               "--prompt_wav_path", os.path.abspath(args.ref), "--prompt_f0_path", rf0,
               "--target_wav_path", os.path.abspath(args.guide), "--target_f0_path", gf0,
               "--n_steps", str(args.n_steps), "--cfg", str(args.cfg), "--pitch_shift", "0",
               "--save_dir", save_dir]
        print(f"SVC render (n_steps={args.n_steps}, cfg={args.cfg}) …", flush=True)
        r = subprocess.run(cmd, cwd=BRIDGE, env=env)
        if r.returncode != 0:
            print("SVC render failed", file=sys.stderr)
            return 1

        import soundfile as sf
        import numpy as np
        gen = os.path.join(save_dir, "generated.wav")
        a, sr = sf.read(gen)
        a = a / max(1e-6, np.abs(a).max()) * args.peak      # tame SVC's hot output
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        sf.write(args.out, a, sr)
        print(f"done -> {args.out}  ({len(a)/sr:.1f}s @ {sr}Hz, peak {np.abs(a).max():.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Hybrid render driver (FMS stage 6) — SVC (clear/sung spans) + melody-mode (rewritten
spans, sung on the take's real F0), overlaid. Owner-gated: runs under the SoulX-Singer-MLX
bridge venv (torch + RMVPE + soundfile; phonemes via g2p through phonology.core).

  bridge-venv-python hybrid_render_run.py --sheet sheet-final.json --take take.wav \
      --ref own-10s.wav --ref-meta own-10s.json --out DIR [--slice 14 --t-end 13]

Pipeline: slice the take -> RMVPE F0 (50 fps) -> author_melody_metadata (rewritten lines,
his real F0) -> render melody-mode -> render SVC over the slice -> overlay by rewrite span.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import soundfile as sf

MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
BRIDGE = os.path.join(MAC, "SoulX-Singer-MLX")
VENV_PY = os.path.join(MAC, "venv/bin/python")
MODEL = os.path.join(BRIDGE, "models/SoulX-Singer-bf16")
RMVPE = os.path.join(BRIDGE, "pretrained_models/SoulX-Singer-Preprocess/rmvpe/rmvpe.pt")
PHONESET = os.path.join(BRIDGE, "soulxsinger/utils/phoneme/phone_set.json")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)
import render_hybrid as rh  # noqa: E402


def extract_f0_hz(wav: str) -> list:
    """RMVPE F0 (Hz per 20ms frame, 50 fps) as a plain list — 0.0 on unvoiced frames."""
    sys.path.insert(0, BRIDGE)
    from preprocess.tools.f0_extraction import F0Extractor
    pe = F0Extractor(model_path=RMVPE, is_half=False, device="mps", target_sr=24000, hop_size=480)
    with tempfile.TemporaryDirectory() as td:
        out = os.path.join(td, "f0.npy")
        pe.process(wav, f0_path=out)
        return np.load(out).astype(float).reshape(-1).tolist()


def slice_wav(src: str, dst: str, t1: float, sr_out: int = 24000) -> str:
    a, sr = sf.read(src)
    if a.ndim > 1:
        a = a.mean(axis=1)
    a = a[: int(t1 * sr)]
    if sr != sr_out:
        n = int(len(a) * sr_out / sr)
        a = np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a)
    sf.write(dst, a, sr_out)
    return dst


def _load_mono(path: str):
    a, sr = sf.read(path)
    if a.ndim > 1:
        a = a.mean(axis=1)
    return a.astype(float), sr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--take", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--ref-meta", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--slice", type=float, default=14.0, help="seconds of the take to render")
    ap.add_argument("--t-end", type=float, default=13.0, help="only rewritten lines starting before this")
    ap.add_argument("--n-steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=3.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    sheet = json.load(open(a.sheet))
    env = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")

    print(f"1) slice take -> {a.slice}s @ 24k", flush=True)
    slice_path = slice_wav(a.take, os.path.join(a.out, "take_slice.wav"), a.slice)

    print("2) RMVPE F0 (50fps) of the slice", flush=True)
    take_f0 = extract_f0_hz(slice_path)
    print(f"   {len(take_f0)} f0 frames ({len(take_f0)/50:.1f}s); voiced median "
          f"{np.median([x for x in take_f0 if x>0]) if any(x>0 for x in take_f0) else 0:.0f}Hz")

    print("3) author melody-mode metadata (rewritten lines, his F0)", flush=True)
    md = rh.author_melody_metadata(sheet, take_f0, fps=50, t_end=a.t_end, name="hybrid")
    if not md.get("ok"):
        print(f"FATAL author: {md.get('error')}", file=sys.stderr)
        return 1
    mt = os.path.join(a.out, "melody_target.json")
    json.dump(md["score"], open(mt, "w"))
    print(f"   {md['rewritten']} rewritten lines, {md['events']} events, {md['n_frames']} f0 frames, "
          f"clip {md['score'][0]['time']}")

    print("4) render melody-mode (control=melody)", flush=True)
    mel_dir = os.path.join(a.out, "melody")
    os.makedirs(mel_dir, exist_ok=True)
    r = subprocess.run([VENV_PY, os.path.join(BRIDGE, "scripts/inference_mlx_bridge.py"),
                        "--model", MODEL, "--component", "svs", "--control", "melody", "--device", "mps",
                        "--prompt_wav_path", a.ref, "--prompt_metadata_path", a.ref_meta,
                        "--target_metadata_path", mt, "--phoneset_path", PHONESET,
                        "--n_steps", str(a.n_steps), "--cfg", str(a.cfg), "--pitch_shift", "0",
                        "--save_dir", mel_dir], cwd=BRIDGE, env=env)
    if r.returncode != 0:
        print("FATAL: melody render failed", file=sys.stderr)
        return 1
    melody_wav = os.path.join(mel_dir, "generated.wav")

    print("5) render SVC over the slice (clear/sung spans)", flush=True)
    svc_wav = os.path.join(a.out, "svc.wav")
    r = subprocess.run([VENV_PY, os.path.join(HERE, "svc_render.py"), "--guide", slice_path,
                        "--ref", a.ref, "--out", svc_wav, "--n_steps", str(a.n_steps), "--cfg", str(a.cfg)],
                       env=env)
    if r.returncode != 0:
        print("FATAL: SVC render failed", file=sys.stderr)
        return 1

    print("6) overlay (SVC + melody by rewrite span)", flush=True)
    svc, sr = _load_mono(svc_wav)
    mel, _ = _load_mono(melody_wav)
    if len(mel) < len(svc):
        mel = np.concatenate([mel, np.zeros(len(svc) - len(mel))])
    else:
        mel = mel[: len(svc)]
    spans = [(s, e) for (s, e) in rh.rewrite_spans(sheet) if s < a.t_end]
    out = np.array(rh.overlay(svc.tolist(), mel.tolist(), spans, sr, xfade_ms=25))
    out = out / max(1e-6, np.abs(out).max()) * 0.95
    final = os.path.join(a.out, "hybrid.wav")
    sf.write(final, out, sr)
    print(f"done -> {final}  ({len(out)/sr:.1f}s @ {sr}Hz, {len(spans)} rewritten spans: "
          f"{[(round(s,1),round(e,1)) for s,e in spans]})")
    print(f"   SVC-only: {svc_wav}   melody-only: {melody_wav}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

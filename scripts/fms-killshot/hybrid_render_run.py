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


def slice_wav(src: str, dst: str, t0: float, t1: float, sr_out: int = 24000) -> str:
    a, sr = sf.read(src)
    if a.ndim > 1:
        a = a.mean(axis=1)
    a = a[int(t0 * sr): int(t1 * sr)]
    if sr != sr_out:
        n = int(len(a) * sr_out / sr)
        a = np.interp(np.linspace(0, len(a), n, endpoint=False), np.arange(len(a)), a)
    sf.write(dst, a, sr_out)
    return dst


def window_sheet(sheet: dict, t0: float, t1: float) -> dict:
    """Keep lines whose lineScore overlaps [t0,t1] and shift every slot/segment time by -t0,
    so the sheet's timeline matches a slice cut at t0 (author + F0 + overlay all stay aligned)."""
    import copy
    lines, scores = [], []
    for ln, sc in zip(sheet.get("lines", []), sheet.get("lineScores", [])):
        slots = (sc or {}).get("slots") or []
        if not slots:
            continue
        a0 = min(float(x["start"]) for x in slots)
        b0 = max(float(x["end"]) for x in slots)
        if a0 < t0 or b0 > t1:          # keep only lines FULLY inside the window
            continue
        nsc = copy.deepcopy(sc)
        for s in nsc["slots"]:
            s["start"] = float(s["start"]) - t0
            s["end"] = float(s["end"]) - t0
            for seg in s.get("segments", []):
                seg["start"] = float(seg["start"]) - t0
                seg["end"] = float(seg["end"]) - t0
        lines.append(ln)
        scores.append(nsc)
    return {**sheet, "lines": lines, "lineScores": scores}


def _load_mono(path: str):
    a, sr = sf.read(path)
    if a.ndim > 1:
        a = a.mean(axis=1)
    return a.astype(float), sr


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sheet", required=True)
    ap.add_argument("--take", required=True)
    ap.add_argument("--ref", required=True, help="melody-mode prompt wav (needs its .json)")
    ap.add_argument("--ref-meta", required=True, help="melody-mode prompt metadata (.json with f0)")
    ap.add_argument("--svc-ref", default="", help="SVC voice reference (defaults to --ref); a clean "
                    "self-slice of the take makes the final sound like HIM")
    ap.add_argument("--out", required=True)
    ap.add_argument("--t-start", type=float, default=0.0, help="window start in the take (seconds)")
    ap.add_argument("--dur", type=float, default=14.0, help="window duration (seconds) to render")
    ap.add_argument("--n-steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=3.0)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    t0, t1 = a.t_start, a.t_start + a.dur
    sheet = window_sheet(json.load(open(a.sheet)), t0, t1)
    env = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")

    print(f"1) slice take -> [{t0}, {t1}]s @ 24k", flush=True)
    slice_path = slice_wav(a.take, os.path.join(a.out, "take_slice.wav"), t0, t1)

    print("2) RMVPE F0 (50fps) of the slice", flush=True)
    take_f0 = extract_f0_hz(slice_path)
    print(f"   {len(take_f0)} f0 frames ({len(take_f0)/50:.1f}s); voiced median "
          f"{np.median([x for x in take_f0 if x>0]) if any(x>0 for x in take_f0) else 0:.0f}Hz")

    print("3) author melody-mode metadata (rewritten lines, his F0)", flush=True)
    md = rh.author_melody_metadata(sheet, take_f0, fps=50, t_end=a.dur, name="hybrid")
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

    print("5) build composite guide (his take + new-word melody spliced at rewrite spans)", flush=True)
    take_s, sr = _load_mono(slice_path)
    mel, _ = _load_mono(melody_wav)
    if len(mel) < len(take_s):
        mel = np.concatenate([mel, np.zeros(len(take_s) - len(mel))])
    else:
        mel = mel[: len(take_s)]
    spans = [(s, e) for (s, e) in rh.rewrite_spans(sheet) if s < a.dur]
    # Blend fix: rather than overlay two DIFFERENT-character renders (SVC vs melody), splice
    # the melody (new words on his F0) INTO his take, then run ONE SVC pass over the whole
    # thing below — so clear and rewritten spans come out as the same voice (no jarring seam).
    composite = np.array(rh.overlay(take_s.tolist(), mel.tolist(), spans, sr, xfade_ms=25))
    composite = composite / max(1e-6, np.abs(composite).max()) * 0.95
    composite_wav = os.path.join(a.out, "composite_guide.wav")
    sf.write(composite_wav, composite, sr)

    print("6) SVC over the composite -> one uniform voice (blend fix)", flush=True)
    svc_ref = a.svc_ref or a.ref     # a clean self-slice makes the final sound like HIM
    final = os.path.join(a.out, "hybrid.wav")
    r = subprocess.run([VENV_PY, os.path.join(HERE, "svc_render.py"), "--guide", composite_wav,
                        "--ref", svc_ref, "--out", final, "--n_steps", str(a.n_steps), "--cfg", str(a.cfg)],
                       env=env)
    if r.returncode != 0:
        print("FATAL: SVC render failed", file=sys.stderr)
        return 1
    print(f"done -> {final}  ({len(spans)} rewritten spans: {[(round(s,1),round(e,1)) for s,e in spans]})")
    print(f"   composite guide (pre-SVC): {composite_wav}   melody-only: {melody_wav}   svc-ref: {svc_ref}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

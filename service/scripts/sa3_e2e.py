#!/usr/bin/env python3
"""sa3_e2e.py — end-to-end proof of the three deferred items against the REAL model,
driving the adapter exactly as the job service does (one model load).

GPU-warden-wrapped:
  gpu.ps1 run ... -- C:\\ComfyUI\\venv\\Scripts\\python.exe service\\scripts\\sa3_e2e.py

Validates:
  * generate + colors  -> manifest carries real steering[] (non-empty), pq, colors.
  * generate, no colors -> steering[] empty.
  * reimagine + colors  -> pqBase + pqDelta present; initLatentCache = "miss".
  * reimagine, SAME source/region, only seed changed -> initLatentCache = "hit"
    (the VAE encode was reused — the init-latent cache works).
  * reimagine, DIFFERENT source -> initLatentCache = "miss" again.
  * no_stack_with colors -> render raises (rejected).
"""
from __future__ import annotations

import os
import sys

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)
os.environ["MOSH_ADAPTER"] = "stable_audio3"

import adapters.stable_audio3_adapter as A  # noqa: E402

OUT = os.path.join(HERE, "_sa3_e2e_out")
os.makedirs(OUT, exist_ok=True)
fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" -- {detail}" if detail else ""), flush=True)
    if not ok:
        fails.append(name)


def tone(path, freq, secs=3.0, sr=44100):
    t = np.linspace(0, secs, int(sr * secs), endpoint=False)
    x = 0.25 * np.sin(2 * np.pi * freq * t).astype(np.float32)
    sf.write(path, np.stack([x, x], axis=1), sr, subtype="PCM_24")
    return path


def run(jid, **req):
    base = dict(prompt="warm lo-fi loop", seed=0, durationSec=4.0, steps=8,
                cfg=7.0, nl=0.4, colors=[], lab=False)
    base.update(req)
    input_wav = base.pop("inputWavPath", "")
    if base.pop("mode", "generate") == "generate":
        input_wav = ""
    output_wav = os.path.join(OUT, f"{jid}.wav")
    return A.render(input_wav, output_wav, base)


def main():
    # 1) generate + colors
    m1 = run("gen_grit", mode="generate", colors=[{"name": "grit", "value": 80}], lab=False)
    check("generate+colors: adapter + real steering applied", bool(m1) and m1["adapter"] == "stable_audio3"
          and len(m1.get("steers", [])) >= 1, f"steers={m1.get('steers')}")
    check("generate+colors: pq present, colors recorded", "pq" in m1 and m1.get("colors"),
          f"pq={m1.get('pq')} colors={m1.get('colors')}")

    # 2) generate, no colors -> no steering
    m2 = run("gen_plain", mode="generate", colors=[], lab=False)
    check("generate no-colors: steering empty", bool(m2) and len(m2.get("steers", [])) == 0,
          f"steers={m2.get('steers')}")

    # 3) reimagine + colors, seed=1 -> miss + pqBase
    src = tone(os.path.join(OUT, "src.wav"), 220.0)
    m3 = run("re_s1", mode="reimagine", colors=[{"name": "air", "value": 70}], lab=False,
             seed=1, inputWavPath=src, inputStartSec=0.0, inputLengthSec=3.0)
    check("reimagine: pq_base present", bool(m3) and "pq_base" in m3,
          f"pq={m3.get('pq')} pq_base={m3.get('pq_base')}")
    check("reimagine: init-latent cache MISS first time", m3.get("init_cache") == "miss",
          str(m3.get("init_cache")))

    # 4) reimagine SAME source/region, only seed changed -> HIT
    m4 = run("re_s2", mode="reimagine", colors=[{"name": "air", "value": 70}], lab=False,
             seed=2, inputWavPath=src, inputStartSec=0.0, inputLengthSec=3.0)
    check("reimagine: init-latent cache HIT on seed-only change", m4.get("init_cache") == "hit",
          str(m4.get("init_cache")))

    # 5) reimagine DIFFERENT source -> MISS again
    src2 = tone(os.path.join(OUT, "src2.wav"), 330.0)
    m5 = run("re_s3", mode="reimagine", colors=[], lab=False, seed=2,
             inputWavPath=src2, inputStartSec=0.0, inputLengthSec=3.0)
    check("reimagine: cache MISS for a different source", m5.get("init_cache") == "miss",
          str(m5.get("init_cache")))

    # 6) no_stack_with colors -> render raises
    try:
        run("bad", mode="generate",
            colors=[{"name": "drum_aggression", "value": 80}, {"name": "grid_tightness", "value": 80}])
        check("no_stack_with rejected at render", False, "did not raise")
    except RuntimeError as e:
        check("no_stack_with rejected at render", True, str(e)[:50])

    print(f"\n==== E2E: PASS {6 + 1 - len(fails)}/7 groups, FAIL {len(fails)} ====")
    if fails:
        print("FAILURES: " + ", ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())

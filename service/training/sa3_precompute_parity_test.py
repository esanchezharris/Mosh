"""Parity: Mosh's precompute port vs pmetal's reference `precompute.py`.

THIS IS THE MANDATORY GATE for the precompute port, and it is not optional
politeness. The port reimplements, against a live warm engine, what pmetal's
script does with freshly-loaded models. Two ways to get it subtly wrong, both
of which train cleanly with a perfectly healthy loss curve and yield a WRONG
adapter:

  1. `seconds_total` built from the PADDED length instead of the clip's real
     duration — teaches a wrong length-to-content mapping.
  2. Pre-applying `to_cond_embed` — the trainer applies the projection itself,
     exactly as the DiT does at inference, so doing it here double-projects.

Neither shows up as an error. Only a numeric diff against the reference finds
them, so this test exists to make that diff mandatory.

Gated on real local assets (the MLX venv + SA3 weights); skips LOUDLY when
they are absent, in the same posture as every other real-asset test here.

Run: python3 service/training/sa3_precompute_parity_test.py
"""

from __future__ import annotations

import json
import math
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))          # service/training/
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/

TOL = 1e-3


def _write_sine(path: str, seconds: float, freq: float, sr: int = 44100) -> None:
    """A stereo wav of a real, non-round duration — the padded-vs-real trap only
    shows up when the clip does NOT land on a latent-grid boundary."""
    n = int(seconds * sr)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = bytearray()
        for i in range(n):
            v = int(12000 * math.sin(2 * math.pi * freq * i / sr))
            frames += struct.pack("<hh", v, v)
        w.writeframes(bytes(frames))


def _read_safetensors(path: str) -> dict:
    import numpy as np
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        hdr = json.loads(f.read(n))
        blob = f.read()
    out = {}
    for k, v in hdr.items():
        if k == "__metadata__":
            continue
        s, e = v["data_offsets"]
        dt = {"F16": np.float16, "F32": np.float32, "BF16": np.float32}.get(v["dtype"], np.float32)
        if v["dtype"] == "BF16":
            raw = np.frombuffer(blob[s:e], dtype=np.uint16).astype(np.uint32) << 16
            arr = raw.view(np.float32)
        else:
            arr = np.frombuffer(blob[s:e], dtype=dt)
        out[k] = arr.reshape(v["shape"]).astype(np.float32)
    return out


def main() -> None:
    try:
        from sa3 import engine as E
    except Exception as exc:  # noqa: BLE001
        print(f"SKIP sa3_precompute_parity_test: SA3 engine not importable ({exc})")
        print("     (needs the MLX venv — see service/run.sh; this test is MANDATORY on a dev Mac)")
        return
    if not E.engine_available():
        print("SKIP sa3_precompute_parity_test: SA3 engine unavailable on this machine")
        print("     (this test is MANDATORY on a dev Mac — do not let it skip silently in CI)")
        return

    import numpy as np
    import sa3_precompute as PC

    fails: list[str] = []
    with tempfile.TemporaryDirectory() as td:
        # 18.37s: deliberately NOT a multiple of the latent grid, so real and
        # padded durations differ and trap #1 is actually reachable.
        wav = os.path.join(td, "clip_a.wav")
        _write_sine(wav, 18.37, 220.0)
        caption = "kxc, rage trap instrumental, heavy distorted 808 bass, 152 bpm"

        out_dir = os.path.join(td, "pre")
        res = PC.precompute([{"id": "clip_a", "wav": wav, "caption": caption}], out_dir)
        if res["count"] != 1:
            print(f"FAIL precompute produced {res['count']} samples (skipped: {res['skipped']})")
            sys.exit(1)

        manifest = json.loads(Path(res["manifest_path"]).read_text())
        rec = manifest[0]
        tensors = _read_safetensors(os.path.join(out_dir, rec["tensor_file"]))

        # ── shape contract the pmetal loader depends on ──────────────────────
        if tensors["cross_attn_cond_raw"].shape != (257, 768):
            fails.append(f"cross_attn_cond_raw shape {tensors['cross_attn_cond_raw'].shape} != (257, 768)")
        if tensors["global_cond_raw"].shape != (768,):
            fails.append(f"global_cond_raw shape {tensors['global_cond_raw'].shape} != (768,)")
        if tensors["latent"].ndim != 2 or tensors["latent"].shape[0] != 256:
            fails.append(f"latent shape {tensors['latent'].shape} != (256, T_lat)")

        # ── TRAP 1: seconds_total must be the REAL pre-padding duration ──────
        real_seconds = 18.37
        if abs(rec["duration_seconds"] - real_seconds) > 0.01:
            fails.append(f"duration_seconds {rec['duration_seconds']} != real {real_seconds} "
                         "(padded length leaked into the manifest)")

        eng = E.get_engine()
        t_lat = int(rec["t_lat"])
        padded_seconds = t_lat * eng.SAMPLES_PER_LATENT / eng.S.SAMPLE_RATE
        if abs(padded_seconds - real_seconds) < 0.01:
            fails.append("test fixture is degenerate: padded == real duration, so the "
                         "padded-vs-real trap cannot be detected — pick another length")
        else:
            # The stored global_cond_raw must equal the seconds-embedding of the
            # REAL duration, and must NOT equal that of the padded one.
            _, g_real = eng.cond_for_training(caption, real_seconds)
            _, g_padded = eng.cond_for_training(caption, padded_seconds)
            g_real = np.array(g_real.astype(eng.mx.float32))
            g_padded = np.array(g_padded.astype(eng.mx.float32))
            stored = tensors["global_cond_raw"]
            d_real = float(np.max(np.abs(stored - g_real)))
            d_padded = float(np.max(np.abs(stored - g_padded)))
            if d_real > TOL:
                fails.append(f"global_cond_raw does not match the REAL-duration embedding (diff {d_real:.2e})")
            if d_padded <= TOL:
                fails.append("global_cond_raw ALSO matches the padded-duration embedding — "
                             "the two are indistinguishable, so this assertion proves nothing")

        # ── TRAP 2: conditioning must be RAW (pre-to_cond_embed) ─────────────
        # The raw cross-attn is 768-wide; a pre-projected one would be EMBED_DIM
        # (1536) wide. The shape check above already catches the blunt version;
        # this catches a same-width projection by comparing against the engine's
        # own raw output.
        cross_ref, _ = eng.cond_for_training(caption, real_seconds)
        cross_ref = np.array(cross_ref.astype(eng.mx.float32))
        d_cross = float(np.max(np.abs(tensors["cross_attn_cond_raw"] - cross_ref)))
        if d_cross > TOL:
            fails.append(f"cross_attn_cond_raw is not the engine's raw conditioning (diff {d_cross:.2e})")

        # ── the last token of cross-attn IS the seconds embedding ────────────
        # pmetal's loader relies on this (concat([embeds_padded, seconds_embed])).
        d_tail = float(np.max(np.abs(tensors["cross_attn_cond_raw"][256] - tensors["global_cond_raw"])))
        if d_tail > TOL:
            fails.append(f"cross_attn_cond_raw[256] != global_cond_raw (diff {d_tail:.2e}) — "
                         "the seconds token is not where the trainer expects it")

        # ── latent grid sized to THIS clip, not the render grid ──────────────
        expected_t_lat = max(1, math.ceil(int(real_seconds * eng.S.SAMPLE_RATE) / eng.SAMPLES_PER_LATENT))
        if t_lat != expected_t_lat:
            fails.append(f"t_lat {t_lat} != per-clip {expected_t_lat} (render grid leaked in)")
        if t_lat == eng.T_LAT and expected_t_lat != eng.T_LAT:
            fails.append("t_lat equals the engine's fixed render grid — clips are being padded to it")

    for f in fails:
        print("FAIL", f)
    if fails:
        sys.exit(1)
    print("sa3_precompute_parity_test: OK (real-not-padded seconds, raw conditioning, "
          "per-clip T_lat, seconds token placement)")


if __name__ == "__main__":
    main()

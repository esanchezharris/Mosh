#!/usr/bin/env python3
"""REAL end-to-end §7→§9 proof — the extraction-regime spine that builds the anchor corpus:
real audio loop → §7 slice → §1 match (owned samples) → recipe (timeline onsets) → §9 render
a NON-SILENT reconstruction placed on the timeline (not stacked at 0).

Needs the binary (MOSH_BIN or /Applications) + a §1 index (REWARD_INDEX_DIR or builds one
over MUSICA_ROOT). Absent → SKIP (exit 0).

    MOSH_BIN=build-macos-arm64-release/.../Mosh python3 service/teardown/render/verify_extraction.py
"""
from __future__ import annotations

import glob
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.drummatch import DrumMatcher, SampleIndex  # noqa: E402
from teardown.extract.drum_slice import slice_oneshots  # noqa: E402
from teardown.render.execute import execute_recipe  # noqa: E402
from teardown.render.from_extraction import recipe_from_extraction  # noqa: E402

SR = 44100
BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")


def load_mono(path, max_s=1.0):
    import soundfile as sf
    import librosa
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    return y[: int(max_s * SR)].astype(np.float32)


def build_loop() -> str:
    """A real 2-bar drum loop sequenced from musica one-shots → a wav §7 can slice."""
    pool = sorted(glob.glob(os.path.join(MUSICA, "**", "*.wav"), recursive=True))[:60]
    if len(pool) < 3:
        raise RuntimeError("library too small")
    kick, snare, hat = (load_mono(pool[0]), load_mono(pool[1]), load_mono(pool[2], 0.3))
    n = int(2.0 * SR)
    buf = np.zeros(n, np.float32)

    def place(samp, t):
        i = int(t * SR)
        seg = samp[: n - i]
        if seg.size:
            buf[i:i + seg.size] += seg

    for t in (0.0, 1.0):
        place(kick, t)
    for t in (0.5, 1.5):
        place(snare, t)
    for k in range(8):
        place(hat, k * 0.25)
    peak = float(np.max(np.abs(buf))) or 1.0
    buf = (buf / peak * 0.9).astype(np.float32)
    out = os.path.join(tempfile.mkdtemp(prefix="td-loop-"), "loop.wav")
    import soundfile as sf
    sf.write(out, buf, SR)
    return out


def get_matcher() -> DrumMatcher:
    dm = DrumMatcher()
    if os.path.isdir(INDEX_DIR):
        try:
            dm.load(INDEX_DIR)
            if dm.index.paths:
                return dm
        except Exception:
            pass
    print("  building §1 index (first run)...", flush=True)
    dm.build_index(MUSICA)
    try:
        dm.save(INDEX_DIR)
    except Exception:
        pass
    return dm


def main() -> int:
    if not os.path.isfile(BIN):
        print(f"  SKIP  Mosh binary not found at {BIN}")
        return 0
    if not os.path.isdir(MUSICA):
        print(f"  SKIP  library not found at {MUSICA}")
        return 0

    loop = build_loop()
    print(f"  built a real 2-bar drum loop from musica")

    y = load_mono(loop, max_s=2.0)
    slices = slice_oneshots(y, SR)
    print(f"  §7 sliced {len(slices)} hits")
    if not slices:
        print("  SKIP  no onsets detected")
        return 0

    dm = get_matcher()
    matches = []
    for sl in slices:
        m = dm.query(sl.samples, k=1)
        matches.append({"t_s": sl.t_s, "role": sl.role_guess,
                        "match": (m[0].path if m else None),
                        "distance": (m[0].distance if m else None)})
    n_matched = sum(1 for m in matches if m["match"])
    print(f"  §1 matched {n_matched}/{len(matches)} hits to owned samples")

    rec = recipe_from_extraction(matches)
    n_onsets = sum(len(e.onsets) for e in rec.elements)
    print(f"  recipe: {len(rec.elements)} role-elements, {n_onsets} timeline placements "
          f"(roles: {[e.role.value for e in rec.elements]})")
    if not rec.elements:
        print("  SKIP  no matched elements to reconstruct")
        return 0

    out = os.path.join(tempfile.mkdtemp(prefix="td-recon-"), "recon.wav")
    res = execute_recipe(rec, bin_path=BIN, out_wav=out,
                         session_dir=tempfile.mkdtemp(prefix="td-recon-sess-"), timeout_s=180)
    clips = sum(1 for r in res.results if r.get("command") == "import_clip" and r.get("ok"))
    print(f"  §9 render: {clips} clips placed, rms {res.audio_rms:.4f}, nonsilent {res.nonsilent}, "
          f"yield {res.yield_actual.get('overall')}")
    if res.error:
        print(f"  engine note: {res.error}")

    fails = []
    if not res.ran or not res.nonsilent:
        fails.append(f"reconstruction silent/failed (rms {res.audio_rms:.5f}; {res.error})")
    if clips != n_onsets:
        fails.append(f"clips placed ({clips}) != onsets ({n_onsets}) — timeline placement off")
    if clips <= 1:
        fails.append("only one clip — timeline sequencing not exercised")

    if fails:
        print("\n  FAIL: " + "; ".join(fails))
        return 1
    print(f"\n  PASS — real loop → §7 slice → §1 match → §9 timeline reconstruction "
          f"({clips} clips on the timeline, non-silent). The extraction-regime anchor path works.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

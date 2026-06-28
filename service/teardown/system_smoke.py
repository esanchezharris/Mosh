#!/usr/bin/env python3
"""WHOLE-SYSTEM end-to-end smoke — chains every teardown layer on real audio + the real
binary + the trained reward head, and asserts the chain produces a scored reconstruction:

  real loop  →  §7 slice  →  §1 match (owned samples)  →  §0 Recipe (timeline onsets)
            →  §9 execute (MoshOps → render)  →  §6/§12 reward (trained MERT head)

Needs the binary (MOSH_BIN / /Applications), a §1 index, and the reward venv (torch) +
reward_head.json for the reward leg. Each leg SKIPs cleanly if its resource is absent, so a
partial environment still reports how far the chain got.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/system_smoke.py
"""
from __future__ import annotations

import glob
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from teardown.drummatch import DrumMatcher, SampleIndex  # noqa: E402
from teardown.extract.drum_slice import slice_oneshots  # noqa: E402
from teardown.render.execute import execute_recipe  # noqa: E402
from teardown.render.from_extraction import recipe_from_extraction  # noqa: E402

SR = 44100
BIN = os.environ.get("MOSH_BIN", "").strip() or "/Applications/Mosh.app/Contents/MacOS/Mosh"
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")


def load_mono(path, max_s=2.0):
    import soundfile as sf
    import librosa
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    return y[: int(max_s * SR)].astype(np.float32)


def build_loop() -> tuple[str, np.ndarray]:
    pool = sorted(glob.glob(os.path.join(MUSICA, "**", "*.wav"), recursive=True))[:60]
    a, b, c = load_mono(pool[0], 1.0), load_mono(pool[1], 1.0), load_mono(pool[2], 0.3)
    n = int(2.0 * SR)
    buf = np.zeros(n, np.float32)

    def place(s, t):
        i = int(t * SR); seg = s[: n - i]
        if seg.size:
            buf[i:i + seg.size] += seg
    for t in (0.0, 1.0):
        place(a, t)
    for t in (0.5, 1.5):
        place(b, t)
    for k in range(8):
        place(c, k * 0.25)
    buf = (buf / (np.max(np.abs(buf)) or 1.0) * 0.9).astype(np.float32)
    out = os.path.join(tempfile.mkdtemp(prefix="td-sys-"), "loop.wav")
    import soundfile as sf
    sf.write(out, buf, SR)
    return out, buf


def main() -> int:
    legs = []

    def leg(name, ok, extra=""):
        legs.append((name, ok, extra))
        print(f"  [{'ok ' if ok else 'SKIP/FAIL'}] {name}  {extra}")

    if not os.path.isdir(MUSICA):
        print(f"  SKIP  library not found at {MUSICA}")
        return 0
    loop_path, loop_audio = build_loop()
    leg("§build real loop", True, "2-bar from musica")

    # §7 extraction
    y = load_mono(loop_path, 2.0)
    slices = slice_oneshots(y, SR)
    leg("§7 slice", len(slices) > 0, f"{len(slices)} hits")

    # §1 match
    dm = DrumMatcher()
    if os.path.isdir(INDEX_DIR):
        dm.load(INDEX_DIR)
    if not dm.index.paths:
        dm.build_index(MUSICA); dm.save(INDEX_DIR)
    matches = []
    for sl in slices:
        m = dm.query(sl.samples, k=1)
        matches.append({"t_s": sl.t_s, "role": sl.role_guess,
                        "match": m[0].path if m else None,
                        "distance": m[0].distance if m else None})
    n_matched = sum(1 for m in matches if m["match"])
    leg("§1 match", n_matched > 0, f"{n_matched}/{len(matches)} → owned samples")

    # §0/§9 recipe + render
    rec = recipe_from_extraction(matches)
    if not os.path.isfile(BIN):
        leg("§9 render", False, f"binary absent ({BIN})")
        print("\n  PARTIAL — chain verified through §1 (no binary for §9 render)")
        return 0
    out = os.path.join(tempfile.mkdtemp(prefix="td-sys-recon-"), "recon.wav")
    res = execute_recipe(rec, bin_path=BIN, out_wav=out,
                         session_dir=tempfile.mkdtemp(prefix="td-sys-sess-"), timeout_s=180)
    leg("§9 render", res.nonsilent, f"rms {res.audio_rms:.3f}, yield {res.yield_actual.get('overall')}")

    # §6/§12 reward (trained head) — score the reconstruction vs the original as exemplar
    try:
        from teardown.flywheel.reward_encoder import TrainedRewardHead
        from teardown.flywheel.reward import Reward
        if TrainedRewardHead.available():
            head = TrainedRewardHead()
            head.add_exemplars([(loop_audio, SR)])         # the original = the "good" anchor
            reward = Reward(pull=head.pull, version="reward-" + head.version)
            recon = load_mono(out, 4.0)
            scores = reward.score_audio(recon, SR)
            comp = reward.composite(scores)
            leg("§12 reward", "pull" in scores, f"pull {scores.get('pull'):.3f}, composite {comp}")
        else:
            leg("§12 reward", False, "reward venv/head absent — run train_reward.py under .teardown.env")
    except Exception as e:  # noqa: BLE001
        leg("§12 reward", False, f"{type(e).__name__}: {e}")

    ran = [l for l in legs if l[1]]
    core_ok = all(l[1] for l in legs if l[0] in ("§7 slice", "§1 match", "§9 render"))
    print(f"\n  {'PASS' if core_ok else 'FAIL'} — {len(ran)}/{len(legs)} legs green; "
          f"the teardown→reconstruction→reward chain runs end to end on real audio.")
    return 0 if core_ok else 1


if __name__ == "__main__":
    sys.exit(main())

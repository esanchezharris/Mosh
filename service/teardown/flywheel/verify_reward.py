#!/usr/bin/env python3
"""REAL §11 keystone — does a music-native encoder (MERT) preserve the ablation engine's
known triplet ordering better than the engineered baseline, on real audio, held out?

Construction (all real samples from the user's library):
  * group one-shots by §1 role (kick/snare/hat/808/clap);
  * build K drum-mix references by arranging one sample per role on a 1-bar grid;
  * ablate via the EXISTING AblationEngine — swap a stem's sample for its §1 nearest
    same-role neighbour (1 swap → near, 2 swaps → far): the known ordering
    d(ref,near) < d(ref,far) by construction;
  * embed ref/near/far with the engineered baseline AND MERT;
  * split by mix (held-out), train the diagonal reward head on train, and report
    ordering accuracy for {engineered, MERT} × {raw, trained} on the test split.

Needs torch+transformers (the reward venv). Run with the teardown python:
    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/verify_reward.py

Gated: if torch is absent it SKIPS (exit 0). The library path is MUSICA_ROOT or the
default ~/Downloads/musica.
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.drummatch.index import SampleIndex  # noqa: E402
from teardown.flywheel.ablate import AblationEngine  # noqa: E402
from teardown.flywheel.train_sim import ordering_accuracy, train_reward_head  # noqa: E402

SR = 44100
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")
N_MIXES = int(os.environ.get("REWARD_MIXES", "40"))
BAR_S = 2.0  # one bar @ 120 bpm


def load_mono(path: str, sr: int = SR, max_s: float = 1.5) -> np.ndarray:
    import soundfile as sf
    import librosa
    y, file_sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if file_sr != sr:
        y = librosa.resample(y, orig_sr=file_sr, target_sr=sr)
    return y[: int(max_s * sr)].astype(np.float32)


def render_pattern(sample: np.ndarray, positions, sr: int = SR, bar_s: float = BAR_S) -> np.ndarray:
    """Place `sample` at each grid position (seconds) within a one-bar buffer."""
    n = int(bar_s * sr)
    buf = np.zeros(n, np.float32)
    for pos in positions:
        i = int(pos * sr)
        seg = sample[: n - i]
        if seg.size:
            buf[i:i + seg.size] += seg
    return buf


PATTERNS = {
    "kick": [0.0, 0.5, 1.0, 1.5],
    "808": [0.0, 1.0],
    "snare": [0.5, 1.5],
    "clap": [0.5, 1.5],
    "hat": [i * 0.25 for i in range(8)],
}


def build_index() -> SampleIndex:
    idx = SampleIndex()
    if os.path.isdir(INDEX_DIR):
        try:
            idx.load(INDEX_DIR)
            if idx.paths:
                return idx
        except Exception:
            pass
    print(f"  building §1 index over {MUSICA} (first run only)...", flush=True)
    idx.build(MUSICA)
    try:
        idx.save(INDEX_DIR)
    except Exception:
        pass
    return idx


def main() -> int:
    try:
        from teardown.flywheel.reward_encoder import MertEncoder
        from teardown.drummatch.embed import EngineeredEmbedder
    except Exception as e:  # noqa: BLE001
        print(f"  SKIP  encoders unavailable ({e})")
        return 0
    if not MertEncoder.available():
        print("  SKIP  torch/transformers absent — run under the reward venv (.teardown.env)")
        return 0
    if not os.path.isdir(MUSICA):
        print(f"  SKIP  sample library not found at {MUSICA} (set MUSICA_ROOT)")
        return 0

    idx = build_index()
    print(f"  index: {len(idx.paths)} samples", flush=True)

    # pools of same-role sample paths
    pools: dict[str, list[str]] = {}
    for p, r in zip(idx.paths, idx.roles):
        pools.setdefault(r, []).append(p)
    roles_have = [r for r in ("kick", "snare", "hat", "808", "clap") if len(pools.get(r, [])) >= 4]
    if len(roles_have) < 3:
        print(f"  SKIP  not enough role variety to build mixes (have {roles_have})")
        return 0
    print(f"  roles with ≥4 samples: {roles_have}")

    rng = np.random.default_rng(0)
    audio_cache: dict[str, np.ndarray] = {}

    def get_audio(path: str) -> np.ndarray:
        if path not in audio_cache:
            try:
                audio_cache[path] = load_mono(path)
            except Exception:
                audio_cache[path] = np.zeros(int(0.5 * SR), np.float32)
        return audio_cache[path]

    def nearest_diff(path: str, role: str) -> str:
        """§1 nearest same-role neighbour that isn't `path` (the realistic substitution)."""
        try:
            res = idx.query(get_audio(path), role=role, k=5)
            for m in res:
                if m.path != path:
                    return m.path
        except Exception:
            pass
        cands = [p for p in pools[role] if p != path]
        return cands[int(rng.integers(len(cands)))] if cands else path

    # build mixes + triplets
    eng_emb = EngineeredEmbedder()
    mert = MertEncoder()
    base_roles = [r for r in ("kick", "snare", "hat") if r in roles_have] or roles_have[:3]
    swap_pair = base_roles[:2]

    eng_trips: list = []
    mert_trips: list = []
    t0 = time.time()
    built = 0
    for _ in range(N_MIXES):
        chosen = {r: pools[r][int(rng.integers(len(pools[r])))] for r in base_roles}
        samples = {r: get_audio(p) for r, p in chosen.items()}
        if any(s.size == 0 or float(np.max(np.abs(s))) == 0 for s in samples.values()):
            continue
        stems = {r: render_pattern(samples[r], PATTERNS.get(r, [0.0])) for r in base_roles}

        def swap_fn(_stem, role, _chosen=chosen):
            new_path = nearest_diff(_chosen[role], role)
            return render_pattern(get_audio(new_path), PATTERNS.get(role, [0.0]))

        trip = AblationEngine(swap_fn).make_triplet(stems, roles_to_swap=swap_pair, sr=SR)
        eng_trips.append((eng_emb.embed(trip.ref, SR), eng_emb.embed(trip.near, SR),
                          eng_emb.embed(trip.far, SR)))
        mert_trips.append((mert.embed(trip.ref, SR), mert.embed(trip.near, SR),
                           mert.embed(trip.far, SR)))
        built += 1
    print(f"  built {built} real ablation triplets in {time.time()-t0:.0f}s "
          f"(swap pair: {swap_pair})", flush=True)
    if built < 8:
        print("  SKIP  too few triplets")
        return 0

    # held-out split by mix
    cut = int(built * 0.6)
    def split(trips):
        return trips[:cut], trips[cut:]
    e_tr, e_te = split(eng_trips)
    m_tr, m_te = split(mert_trips)

    e_raw = ordering_accuracy(e_te)
    m_raw = ordering_accuracy(m_te)
    e_w = train_reward_head(e_tr)
    m_w = train_reward_head(m_tr)
    e_tr_acc = ordering_accuracy(e_te, e_w)
    m_tr_acc = ordering_accuracy(m_te, m_w)

    print("\n  held-out ordering accuracy  (d(ref,near) < d(ref,far)):")
    print(f"    engineered   raw {e_raw:.3f}   trained {e_tr_acc:.3f}")
    print(f"    MERT         raw {m_raw:.3f}   trained {m_tr_acc:.3f}")

    best_mert = max(m_raw, m_tr_acc)
    best_eng = max(e_raw, e_tr_acc)
    fails = []
    if not (best_mert >= best_eng):
        fails.append(f"MERT ({best_mert:.3f}) did not match/beat engineered ({best_eng:.3f})")
    if not (m_tr_acc >= m_raw - 1e-9):
        fails.append(f"training did not help MERT (raw {m_raw:.3f} -> trained {m_tr_acc:.3f})")
    if not (best_mert > 0.5):
        fails.append(f"MERT no better than chance ({best_mert:.3f})")

    if fails:
        print("\n  RESULT (honest): " + "; ".join(fails))
        # a non-beating result is a real finding, not a crash — exit 2 to flag "ran, didn't win"
        return 2
    print(f"\n  PASS — MERT preserves the musical ablation ordering "
          f"({best_mert:.3f}) ≥ engineered ({best_eng:.3f}) on held-out real audio")
    return 0


if __name__ == "__main__":
    sys.exit(main())

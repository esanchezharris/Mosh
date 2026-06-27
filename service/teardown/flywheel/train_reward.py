#!/usr/bin/env python3
"""§11 TRAINING DRIVER — scale the ablation-triplet set and train + SAVE the MERT reward
head (the diagonal weighting that preserves the musical-ablation ordering). This is the
"training" step: it produces a versioned reward_head.json artifact that the §6 oracle and
§12 reward load, plus the held-out keystone metric at scale.

Construction mirrors verify_reward.py but scaled: many real drum-mix references from the
library, ablated via the EXISTING AblationEngine (§1 nearest-neighbour swaps) across several
role-swap pairs, embedded with MERT (+ engineered for the baseline comparison), split by mix.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/train_reward.py [N_MIXES]

Gated on torch (reward venv). Writes service/teardown/flywheel/reward_head.json.
"""
from __future__ import annotations

import json
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
HEAD_OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reward_head.json")
BAR_S = 2.0
PATTERNS = {
    "kick": [0.0, 0.5, 1.0, 1.5], "808": [0.0, 1.0], "snare": [0.5, 1.5],
    "clap": [0.5, 1.5], "hat": [i * 0.25 for i in range(8)], "perc": [0.25, 0.75, 1.25, 1.75],
}
SWAP_PAIRS = [("kick", "snare"), ("snare", "hat"), ("kick", "hat"), ("808", "snare"), ("clap", "hat")]


def load_mono(path, max_s=1.5):
    import soundfile as sf
    import librosa
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    return y[: int(max_s * SR)].astype(np.float32)


def render_pattern(sample, positions):
    n = int(BAR_S * SR)
    buf = np.zeros(n, np.float32)
    for pos in positions:
        i = int(pos * SR)
        seg = sample[: n - i]
        if seg.size:
            buf[i:i + seg.size] += seg
    return buf


def main() -> int:
    n_mixes = int(sys.argv[1]) if len(sys.argv) > 1 else 160
    try:
        from teardown.flywheel.reward_encoder import MertEncoder
        from teardown.drummatch.embed import EngineeredEmbedder
    except Exception as e:  # noqa: BLE001
        print(f"  SKIP  encoders unavailable ({e})")
        return 0
    if not MertEncoder.available():
        print("  SKIP  torch absent — run under the reward venv (.teardown.env)")
        return 0
    if not os.path.isdir(MUSICA):
        print(f"  SKIP  library not found at {MUSICA}")
        return 0

    idx = SampleIndex()
    if os.path.isdir(INDEX_DIR):
        idx.load(INDEX_DIR)
    if not idx.paths:
        print("  building §1 index...", flush=True)
        idx.build(MUSICA)
        idx.save(INDEX_DIR)
    pools: dict = {}
    for p, r in zip(idx.paths, idx.roles):
        pools.setdefault(r, []).append(p)
    roles = [r for r in ("kick", "snare", "hat", "808", "clap", "perc") if len(pools.get(r, [])) >= 8]
    pairs = [(a, b) for a, b in SWAP_PAIRS if a in roles and b in roles]
    if len(roles) < 3 or not pairs:
        print(f"  SKIP  insufficient role variety (need ≥8/role; roles={roles})")
        return 0

    # DISJOINT train/test sample pools per role → "held out" means UNSEEN timbres, not just
    # new arrangements of seen ones (the leakage the review caught). Samples AND swaps for a
    # test mix come only from the test half.
    rng = np.random.default_rng(0)
    split_rng = np.random.default_rng(42)
    train_pools, test_pools = {}, {}
    for r in roles:
        ps = list(pools[r]); split_rng.shuffle(ps)
        h = len(ps) // 2
        train_pools[r], test_pools[r] = ps[:h], ps[h:]
    base_roles = roles[:3]
    print(f"  roles={roles} base={base_roles} swap-pairs={pairs}  "
          f"disjoint pools (train {[len(train_pools[r]) for r in base_roles]} / "
          f"test {[len(test_pools[r]) for r in base_roles]} per role)", flush=True)

    cache: dict = {}

    def aud(path):
        if path not in cache:
            try:
                cache[path] = load_mono(path)
            except Exception:
                cache[path] = np.zeros(int(0.4 * SR), np.float32)
        return cache[path]

    eng_emb = EngineeredEmbedder()
    mert = MertEncoder()
    t0 = time.time()

    def build(pool: dict, count: int):
        """count triplets drawn ONLY from `pool` (samples + same-role swaps)."""
        e_out, m_out = [], []
        for k in range(count):
            chosen = {r: pool[r][int(rng.integers(len(pool[r])))] for r in base_roles}
            samples = {r: aud(p) for r, p in chosen.items()}
            if any(s.size == 0 or float(np.max(np.abs(s))) == 0 for s in samples.values()):
                continue
            stems = {r: render_pattern(samples[r], PATTERNS.get(r, [0.0])) for r in base_roles}
            pair = pairs[k % len(pairs)]
            pair = (pair[0] if pair[0] in base_roles else base_roles[0],
                    pair[1] if pair[1] in base_roles else base_roles[1])

            def swap_fn(_stem, role, _c=chosen):
                cands = [p for p in pool[role] if p != _c[role]]
                npath = cands[int(rng.integers(len(cands)))] if cands else _c[role]
                return render_pattern(aud(npath), PATTERNS.get(role, [0.0]))

            trip = AblationEngine(swap_fn).make_triplet(stems, roles_to_swap=pair, sr=SR)
            e_out.append((eng_emb.embed(trip.ref, SR), eng_emb.embed(trip.near, SR), eng_emb.embed(trip.far, SR)))
            m_out.append((mert.embed(trip.ref, SR), mert.embed(trip.near, SR), mert.embed(trip.far, SR)))
        return e_out, m_out

    n_train, n_test = int(n_mixes * 0.7), max(20, int(n_mixes * 0.3))
    e_tr, m_tr = build(train_pools, n_train)
    e_te, m_te = build(test_pools, n_test)
    built = len(m_tr) + len(m_te)
    print(f"  built {len(m_tr)} train + {len(m_te)} test triplets (disjoint timbres) in "
          f"{time.time()-t0:.0f}s", flush=True)
    if len(m_tr) < 15 or len(m_te) < 10:
        print("  SKIP  too few triplets")
        return 1

    e_raw, m_raw = ordering_accuracy(e_te), ordering_accuracy(m_te)
    e_w = train_reward_head(e_tr)
    m_w = train_reward_head(m_tr)
    e_acc, m_acc = ordering_accuracy(e_te, e_w), ordering_accuracy(m_te, m_w)

    print("\n  ── held-out ordering accuracy (n_test={}) ──".format(len(m_te)))
    print(f"    engineered   raw {e_raw:.3f}   trained {e_acc:.3f}")
    print(f"    MERT         raw {m_raw:.3f}   trained {m_acc:.3f}")

    head = {
        "encoder": mert.version, "dim": int(len(m_w)),
        "weights": [round(float(x), 6) for x in m_w],
        "trained_on_triplets": built, "test_triplets": len(m_te),
        "ordering_acc": {"mert_raw": m_raw, "mert_trained": m_acc,
                         "engineered_raw": e_raw, "engineered_trained": e_acc},
        "roles": base_roles, "swap_pairs": [list(p) for p in pairs],
        "schema": "reward_head_v1",
    }
    with open(HEAD_OUT, "w") as f:
        json.dump(head, f, indent=1)
    print(f"\n  saved trained reward head → {HEAD_OUT}  (dim {head['dim']}, {built} triplets)")

    best_mert = max(m_raw, m_acc)
    if best_mert >= max(e_raw, e_acc) and best_mert > 0.5 and m_acc >= m_raw - 1e-9:
        print(f"  PASS — trained MERT head ({best_mert:.3f}) ≥ engineered, beats chance, training helped")
        return 0
    print(f"  RESULT (honest): MERT {best_mert:.3f} vs engineered {max(e_raw,e_acc):.3f}")
    return 2


if __name__ == "__main__":
    sys.exit(main())

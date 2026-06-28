#!/usr/bin/env python3
"""§11 — the MUSICAL-ablation experiment the scale result pointed to. Sample-swap ablations
are SPECTRAL (a different kick changes the spectrum) so the engineered baseline tracks them
fine. A TIMING shift changes the GROOVE while holding the samples (and thus the spectrum)
~constant — the musical axis where a music-native encoder (MERT) should beat spectral
features that are largely blind to micro-timing.

Builds drum mixes from the library, then ablates by SHIFTING one role's onsets:
  ref  = correct groove
  near = role shifted by a small δ (a subtle push/pull)
  far  = role shifted by a larger δ (an off-grid lurch)
Known ordering d(ref,near) < d(ref,far). Compares MERT vs engineered, held out by mix.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/train_reward_musical.py [N]
Gated on torch. Honest: reports whatever it finds.
"""
from __future__ import annotations

import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.drummatch.index import SampleIndex  # noqa: E402
from teardown.flywheel.train_sim import ordering_accuracy, train_reward_head  # noqa: E402

SR = 44100
MUSICA = os.environ.get("MUSICA_ROOT", os.path.expanduser("~/Downloads/musica"))
INDEX_DIR = os.environ.get("REWARD_INDEX_DIR", "/tmp/td-reward-index")
BAR_S = 2.0
BASE = {"kick": [0.0, 0.5, 1.0, 1.5], "snare": [0.5, 1.5], "hat": [i * 0.25 for i in range(8)]}
NEAR_SHIFT = 0.02   # 20 ms — a tasteful push
FAR_SHIFT = 0.09    # 90 ms — a clearly-off lurch


def load_mono(path, max_s=1.0):
    import soundfile as sf
    import librosa
    y, fsr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if fsr != SR:
        y = librosa.resample(y, orig_sr=fsr, target_sr=SR)
    return y[: int(max_s * SR)].astype(np.float32)


def render(samples: dict, positions: dict) -> np.ndarray:
    n = int(BAR_S * SR)
    buf = np.zeros(n, np.float32)
    for role, samp in samples.items():
        for pos in positions[role]:
            i = int(max(0.0, pos) * SR)
            seg = samp[: n - i]
            if i < n and seg.size:
                buf[i:i + seg.size] += seg
    peak = float(np.max(np.abs(buf))) or 1.0
    return (buf / peak * 0.9).astype(np.float32)


def main() -> int:
    n_mixes = int(sys.argv[1]) if len(sys.argv) > 1 else 120
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
        idx.build(MUSICA); idx.save(INDEX_DIR)
    pools: dict = {}
    for p, r in zip(idx.paths, idx.roles):
        pools.setdefault(r, []).append(p)
    roles = [r for r in ("kick", "snare", "hat") if len(pools.get(r, [])) >= 4]
    if len(roles) < 3:
        # fall back: any 3 roles with enough samples
        roles = [r for r, ps in pools.items() if len(ps) >= 4][:3]
        if len(roles) < 3:
            print(f"  SKIP  insufficient role variety ({list(pools)})")
            return 0
    print(f"  roles={roles}  near={NEAR_SHIFT*1000:.0f}ms far={FAR_SHIFT*1000:.0f}ms  mixes={n_mixes}", flush=True)

    # DISJOINT train/test sample pools → held-out = unseen timbres (the leakage fix).
    rng = np.random.default_rng(0)
    split_rng = np.random.default_rng(42)
    train_pools, test_pools = {}, {}
    for r in roles:
        ps = list(pools[r]); split_rng.shuffle(ps)
        h = len(ps) // 2
        train_pools[r], test_pools[r] = ps[:h] or ps, ps[h:] or ps
    cache: dict = {}

    def aud(p):
        if p not in cache:
            try:
                cache[p] = load_mono(p)
            except Exception:
                cache[p] = np.zeros(int(0.4 * SR), np.float32)
        return cache[p]

    eng_emb = EngineeredEmbedder()
    mert = MertEncoder()
    t0 = time.time()

    def build(pool: dict, count: int):
        e_out, m_out = [], []
        for k in range(count):
            chosen = {r: pool[r][int(rng.integers(len(pool[r])))] for r in roles}
            samples = {r: aud(p) for r, p in chosen.items()}
            if any(s.size == 0 or float(np.max(np.abs(s))) == 0 for s in samples.values()):
                continue
            shift_role = roles[k % len(roles)]               # which role's groove we perturb
            sign = 1.0 if (k % 2 == 0) else -1.0
            base = {r: list(BASE.get(r, [0.0, 1.0])) for r in roles}
            near = {r: list(base[r]) for r in roles}
            far = {r: list(base[r]) for r in roles}
            near[shift_role] = [p + sign * NEAR_SHIFT for p in base[shift_role]]
            far[shift_role] = [p + sign * FAR_SHIFT for p in base[shift_role]]
            ref_a, near_a, far_a = render(samples, base), render(samples, near), render(samples, far)
            e_out.append((eng_emb.embed(ref_a, SR), eng_emb.embed(near_a, SR), eng_emb.embed(far_a, SR)))
            m_out.append((mert.embed(ref_a, SR), mert.embed(near_a, SR), mert.embed(far_a, SR)))
        return e_out, m_out

    n_train, n_test = int(n_mixes * 0.7), max(20, int(n_mixes * 0.3))
    eng_tr, mert_tr = build(train_pools, n_train)
    eng_te, mert_te = build(test_pools, n_test)
    built = len(mert_tr) + len(mert_te)
    print(f"  built {len(mert_tr)} train + {len(mert_te)} test timing-ablation triplets "
          f"(disjoint timbres) in {time.time()-t0:.0f}s", flush=True)
    if built < 20:
        print("  SKIP  too few"); return 1

    e_raw = ordering_accuracy(eng_te); m_raw = ordering_accuracy(mert_te)
    e_w = train_reward_head(eng_tr); m_w = train_reward_head(mert_tr)
    e_acc = ordering_accuracy(eng_te, e_w); m_acc = ordering_accuracy(mert_te, m_w)

    print(f"\n  ── MUSICAL (timing) ablation — held-out ordering accuracy (n={len(mert_te)}) ──")
    print(f"    engineered   raw {e_raw:.3f}   trained {e_acc:.3f}")
    print(f"    MERT         raw {m_raw:.3f}   trained {m_acc:.3f}")
    best_m, best_e = max(m_raw, m_acc), max(e_raw, e_acc)
    margin = best_m - best_e
    print(f"\n  →  MERT {best_m:.3f} vs engineered {best_e:.3f}  (margin {margin:+.3f})")
    if margin > 0.05:
        print("  RESULT: MERT clearly wins on the MUSICAL axis — validates the §11 thesis "
              "(music-native beats spectral features on micro-timing/groove).")
    elif margin > 0.0:
        print("  RESULT: MERT edges ahead on timing (modest).")
    else:
        print("  RESULT (honest): MERT did NOT beat engineered even on timing — surprising; "
              "the embedding may be timing-insensitive at this δ, or the head underfits.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

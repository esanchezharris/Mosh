#!/usr/bin/env python3
"""§11 KEYSTONE — the go/no-go number.

Does a reward head trained on OUR anchors PRESERVE the ablation engine's known ordering
(ref closer to the 1-swap than the 2-swap) BETTER THAN RAW CLAP, held out BY SOURCE FILE?

Anchors are real project-file grooves (project_anchors.py). For each anchor we ablate (swap a
role's sample for a same-role library neighbour → 1-swap `near`, 2-swap `far`), embed ref/near/far
with MERT (the head's encoder), raw CLAP (the baseline the design must beat), and engineered
(reference). We hold out WHOLE ANCHORS (source files) — train the diagonal head on train-file
triplets, score ordering accuracy on unseen-file triplets — averaged over several source-splits.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/keystone.py <anchor_store> [per_pair] [n_splits]

DECISION (reported, not auto-acted): trained-MERT > raw-CLAP ⇒ the pull is validated; else NOT.
"""
from __future__ import annotations

import itertools
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.ablate import AblationEngine  # noqa: E402
from teardown.flywheel.anchors import AnchorStore  # noqa: E402
from teardown.flywheel.project_anchors import SR, _Pools, _load_sample, render_stem  # noqa: E402
from teardown.flywheel.train_sim import ordering_accuracy, train_reward_head  # noqa: E402


def _l2(v: np.ndarray) -> np.ndarray:
    n = float(np.linalg.norm(v))
    return (v / n).astype(np.float32) if n > 0 else v.astype(np.float32)


class ClapEmb:
    """Raw CLAP audio embedding via transformers (laion music CLAP) — no laion_clap dep needed."""
    version = "clap-hf-larger-music"

    def __init__(self, model_id: str = "laion/larger_clap_music"):
        from transformers import ClapModel, ClapProcessor
        self.m = ClapModel.from_pretrained(model_id).eval()
        self.p = ClapProcessor.from_pretrained(model_id)

    def embed(self, y: np.ndarray, sr: int) -> np.ndarray:
        import librosa
        import torch
        if sr != 48000:
            y = librosa.resample(y.astype(np.float32), orig_sr=sr, target_sr=48000)
        inp = self.p(audio=[y], sampling_rate=48000, return_tensors="pt")
        with torch.no_grad():
            f = self.m.get_audio_features(**inp)
        return f[0].cpu().numpy().astype(np.float32)


def _load_stem(path: str) -> np.ndarray:
    import soundfile as sf
    y, _ = sf.read(path, dtype="float32", always_2d=True)
    return y.mean(axis=1).astype(np.float32)


def _shift(onsets, dt: float):
    return [max(0.0, t + dt) for t in onsets]


def build_triplets(anchors, pools: _Pools, mode: str = "swap", per_pair: int = 1, seed: int = 0,
                   dt_small: float = 0.03, dt_large: float = 0.12):
    """Per anchor → (anchor_id, ref, near, far) triplets with a KNOWN ordering (near closer to ref).
    mode='swap'  : timbral — replace a role's sample with a same-role neighbour (1-swap vs 2-swap).
    mode='timing': MUSICAL — hold the timbre constant (re-derive each role's base sample
                   deterministically) and perturb ONE role's ONSETS; small shift=near, large=far,
                   both directions. Isolates the groove axis (the keystone's musical question)."""
    rng = np.random.default_rng(seed)
    mix = AblationEngine(lambda s, r: s).mix
    trips = []
    for a in anchors:
        roles = [r for r in a.stems if a.onsets.get(r)]
        if len(roles) < 2:
            continue
        n = int(a.window_s * SR)
        if mode == "timing":
            base_samp = {}
            for r in roles:
                sp = pools.pick(r, f"{a.anchor_id}:{r}")          # SAME pick as project_anchors → base timbre
                base_samp[r] = _load_sample(sp) if sp else np.zeros(int(0.4 * SR), np.float32)
            base_stems = {r: render_stem(a.onsets[r], base_samp[r], n) for r in roles}
            ref = mix(base_stems)
            for r0 in roles:
                for sign in (1.0, -1.0):
                    near = dict(base_stems)
                    near[r0] = render_stem(_shift(a.onsets[r0], sign * dt_small), base_samp[r0], n)
                    far = dict(base_stems)
                    far[r0] = render_stem(_shift(a.onsets[r0], sign * dt_large), base_samp[r0], n)
                    trips.append((a.anchor_id, ref, mix(near), mix(far)))
        else:
            base = {r: _load_stem(a.stems[r]) for r in roles}

            def swap(_stem, role, _a=a):
                samp = pools.pick(role, f"{_a.anchor_id}:{role}:{int(rng.integers(1 << 30))}")
                s = _load_sample(samp) if samp else np.zeros(int(0.4 * SR), np.float32)
                return render_stem(_a.onsets[role], s, n)

            eng = AblationEngine(swap)
            for r0, r1 in itertools.combinations(roles, 2):
                for _k in range(per_pair):
                    t = eng.make_triplet(base, roles_to_swap=(r0, r1), sr=SR)
                    trips.append((a.anchor_id, t.ref, t.near, t.far))
    return trips


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("usage: keystone.py <anchor_store> [per_pair=2] [n_splits=5]", file=sys.stderr)
        return 2
    store_dir = argv[0]
    per_pair = int(argv[1]) if len(argv) > 1 else 2
    n_splits = int(argv[2]) if len(argv) > 2 else 5
    mode = argv[3] if len(argv) > 3 else "swap"

    store = AnchorStore(store_dir)
    anchors = store.gold()
    print(f"  gold anchors (exact/deterministic): {len(anchors)} from "
          f"{len({a.anchor_id for a in anchors})} source files", flush=True)
    if len(anchors) < 4:
        print("  INSUFFICIENT anchors for a held-out-by-source keystone (need ≥4 source files).")
        return 1

    pools = _Pools()
    trips = build_triplets(anchors, pools, mode=mode, per_pair=per_pair)
    print(f"  mode={mode!r}: built {len(trips)} ablation triplets from {len(anchors)} anchors", flush=True)

    # encoders
    from teardown.drummatch.embed import EngineeredEmbedder
    from teardown.flywheel.reward_encoder import MertEncoder
    mert = MertEncoder()
    eng = EngineeredEmbedder()
    print("  loading CLAP (laion/larger_clap_music)…", flush=True)
    clap = ClapEmb()

    # embed every distinct mix once per encoder (ref repeats across an anchor's triplets)
    cache: dict = {}

    def emb(enc, name, y):
        key = (name, id(y))
        if key not in cache:
            cache[key] = _l2(enc.embed(y, SR))
        return cache[key]

    rows = []  # (anchor_id, {enc: (r,p,n)})
    for i, (aid, r, p, q) in enumerate(trips):
        e = {}
        for name, enc in (("mert", mert), ("clap", clap), ("eng", eng)):
            e[name] = (emb(enc, name, r), emb(enc, name, p), emb(enc, name, q))
        rows.append((aid, e))
        if (i + 1) % 25 == 0:
            print(f"    embedded {i+1}/{len(trips)}", flush=True)

    ids = sorted({aid for aid, _ in rows})
    results = {"clap_raw": [], "mert_raw": [], "mert_trained": [], "eng_raw": []}
    rng = np.random.default_rng(0)
    for sp in range(n_splits):
        order = list(ids)
        rng.shuffle(order)
        cut = max(1, int(round(0.7 * len(order))))
        train_ids, test_ids = set(order[:cut]), set(order[cut:])
        if not test_ids or not train_ids:
            continue
        tr = lambda enc: [r[1][enc] for r in rows if r[0] in train_ids]
        te = lambda enc: [r[1][enc] for r in rows if r[0] in test_ids]
        results["clap_raw"].append(ordering_accuracy(te("clap")))
        results["mert_raw"].append(ordering_accuracy(te("mert")))
        results["eng_raw"].append(ordering_accuracy(te("eng")))
        w = train_reward_head(tr("mert"))
        results["mert_trained"].append(ordering_accuracy(te("mert"), w))

    def stat(xs):
        return (round(float(np.mean(xs)), 4), round(float(np.min(xs)), 4), round(float(np.max(xs)), 4)) if xs else (0, 0, 0)

    print(f"\n  ── §11 KEYSTONE [{mode}] — held-out-BY-SOURCE ordering accuracy ({n_splits} splits) ──")
    for k in ("clap_raw", "mert_raw", "mert_trained", "eng_raw"):
        m, lo, hi = stat(results[k])
        print(f"    {k:14} mean {m:.4f}  [{lo:.4f}–{hi:.4f}]")
    clap = stat(results["clap_raw"])[0]
    trained = stat(results["mert_trained"])[0]
    delta = round(trained - clap, 4)
    print(f"\n  KEYSTONE: trained-MERT {trained:.4f}  vs  raw-CLAP {clap:.4f}   Δ={delta:+.4f}")
    print(f"  VERDICT: {'BEATS CLAP ✓' if delta > 0 else 'TIES/LOSES vs CLAP ✗'} "
          f"(report-only; do NOT auto-activate the pull)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

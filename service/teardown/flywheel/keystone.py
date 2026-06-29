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
            out = self.m.get_audio_features(**inp)
        # transformers 5.x returns BaseModelOutputWithPooling; the projected 512-d CLAP audio
        # embedding is `.pooler_output` (NOT `.last_hidden_state`, the 1024×2×32 HTSAT feature map).
        emb = out.pooler_output if hasattr(out, "pooler_output") else out
        return emb[0].cpu().numpy().astype(np.float32)


class GlobalStatEncoder:
    """Trivial global-statistics 'encoder' — a CONFOUND DETECTOR, not a real model. If near/far are
    orderable from a handful of GLOBAL scalars (loudness / crest / spectral centroid / ZCR), the
    ablation has a non-musical confound and any real encoder's 'win' could be trivially explained.
    On a clean musical ablation this should sit near chance (~0.5)."""
    version = "globalstat-ctrl-v1"

    def embed(self, y, sr: int) -> np.ndarray:
        x = np.asarray(y, dtype=np.float32)
        if x.ndim > 1:
            x = x.mean(axis=-1)
        rms = float(np.sqrt(np.mean(x * x) + 1e-12))
        peak = float(np.max(np.abs(x)) + 1e-12)
        crest = peak / rms
        S = np.abs(np.fft.rfft(x))
        f = np.fft.rfftfreq(len(x), 1.0 / sr)
        cen = float((f * S).sum() / (S.sum() + 1e-12))
        zcr = float(np.mean((np.abs(np.diff(np.sign(x))) > 0).astype(np.float32)))
        v = np.array([rms, crest, cen / 1000.0, zcr], dtype=np.float32)
        n = float(np.linalg.norm(v)) or 1.0
        return (v / n).astype(np.float32)


def _load_stem(path: str) -> np.ndarray:
    import soundfile as sf
    y, _ = sf.read(path, dtype="float32", always_2d=True)
    return y.mean(axis=1).astype(np.float32)


def _shift(onsets, dt: float):
    return [max(0.0, t + dt) for t in onsets]


def build_triplets(anchors, pools: _Pools, mode: str = "swap", per_pair: int = 1, seed: int = 0,
                   dt_small: float = 0.03, dt_large: float = 0.12, placebo: bool = False,
                   max_sample_s: float = 0.0):
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
                sd = len(base_samp[r0]) / SR                       # sample duration (s)
                # INTERIOR onsets only: shifting by ±dt_large can neither clamp at 0 nor truncate past
                # the window end → near/far differ from ref ONLY by interior-onset position (identical
                # stem energy / hit count). This kills the clamp + boundary-truncation confounds the
                # adversarial review flagged (which let `far` lose tail hits → non-musical energy cue).
                interior = [t for t in a.onsets[r0]
                            if t - dt_large >= 0.0 and (t + dt_large + sd) <= a.window_s]
                others = [t for t in a.onsets[r0] if t not in interior]   # held fixed across ref/near/far
                if not interior:
                    continue                                       # no clean onset to perturb → skip
                for sign in (1.0, -1.0):
                    near = dict(base_stems)
                    near[r0] = render_stem(others + _shift(interior, sign * dt_small), base_samp[r0], n)
                    far = dict(base_stems)
                    far[r0] = render_stem(others + _shift(interior, sign * dt_large), base_samp[r0], n)
                    trips.append((a.anchor_id, ref, mix(near), mix(far)))
        elif mode == "iso_timing":
            # CONFOUND-FREE timing: a SINGLE isolated stem, interior onsets shifted. A lone time-shifted
            # stem has shift-invariant RMS / crest / |FFT| / ZCR (energy only moves in time, magnitude
            # spectrum is phase-only) → gstat ≈ 0.5 BY CONSTRUCTION. A spectrogram-pooling encoder (CLAP)
            # sees ref/near/far as near-identical (same spectrum) ⇒ ~chance; only a temporal encoder can
            # order them. The clean test of "does the encoder PERCEIVE micro-timing", zero energy cue.
            for r0 in roles:
                sp = pools.pick(r0, f"{a.anchor_id}:{r0}")
                samp = _load_sample(sp) if sp else np.zeros(int(0.4 * SR), np.float32)
                if max_sample_s:                                # CONTROL: truncate so hits can't overlap
                    samp = samp[:max(1, int(max_sample_s * SR))]  # at any shift → kills the peak-norm/overlap artifact
                sd = len(samp) / SR
                interior = [t for t in a.onsets[r0]
                            if t - dt_large >= 0.0 and (t + dt_large + sd) <= a.window_s]
                others = [t for t in a.onsets[r0] if t not in interior]
                if not interior:
                    continue
                ref_s = render_stem(a.onsets[r0], samp, n)
                for sign in (1.0, -1.0):
                    near_s = render_stem(others + _shift(interior, sign * dt_small), samp, n)
                    # PLACEBO: far gets the SAME magnitude as near (opposite sign) → near/far are
                    # symmetric about ref ⇒ NO true ordering. A genuine micro-timing model scores ~0.5
                    # here; a model reading a non-timing artifact (sample identity / render fingerprint)
                    # would deviate. The decisive artifact control for the synthetic→real claim.
                    far_dt = -sign * dt_small if placebo else sign * dt_large
                    far_s = render_stem(others + _shift(interior, far_dt), samp, n)
                    trips.append((a.anchor_id, ref_s, near_s, far_s))
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
        print("usage: keystone.py <anchor_store> [per_pair=2] [n_splits=5] [mode=swap|timing]", file=sys.stderr)
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

    # encoders — raw music encoders compete with raw CLAP (zero overfit risk); the diagonal head
    # is known-inert (the keystone result). MuQ-MuLan's audio tower is the strongest CLAP-analog.
    from teardown.drummatch.embed import EngineeredEmbedder
    from teardown.flywheel.reward_encoder import MertEncoder, MuQEncoder, MuQMuLanEncoder
    mert = MertEncoder()
    eng = EngineeredEmbedder()
    gstat = GlobalStatEncoder()
    muq = MuQEncoder()
    print("  loading MuQ-MuLan (contrastive audio tower)…", flush=True)
    mulan = MuQMuLanEncoder()
    print("  loading CLAP (laion/larger_clap_music)…", flush=True)
    clap = ClapEmb()

    # embed every distinct mix once per encoder (ref repeats across an anchor's triplets)
    cache: dict = {}

    def emb(enc, name, y):
        key = (name, id(y))
        if key not in cache:
            cache[key] = _l2(enc.embed(y, SR))
        return cache[key]

    # per-layer matrices (L,H) for encoders that expose embed_layers — for honest layer-selection
    cacheL: dict = {}

    def embL(enc, name, y):
        key = (name, id(y))
        if key not in cacheL:
            cacheL[key] = enc.embed_layers(y, SR)        # (L,H), each row already L2-normed
        return cacheL[key]

    layered = [("mert", mert), ("muq", muq)]
    rows = []   # (anchor_id, {enc: (r,p,n)})
    rowsL = []  # (anchor_id, {enc: ((L,H),(L,H),(L,H))})
    for i, (aid, r, p, q) in enumerate(trips):
        e = {}
        for name, enc in (("mert", mert), ("clap", clap), ("eng", eng), ("muq", muq),
                          ("mulan", mulan), ("gstat", gstat)):
            e[name] = (emb(enc, name, r), emb(enc, name, p), emb(enc, name, q))
        rows.append((aid, e))
        eL = {name: (embL(enc, name, r), embL(enc, name, p), embL(enc, name, q)) for name, enc in layered}
        rowsL.append((aid, eL))
        if (i + 1) % 25 == 0:
            print(f"    embedded {i+1}/{len(trips)}", flush=True)

    def _acc_at_layer(trips_L, l):
        ok = sum(1 for R, P, Q in trips_L
                 if np.linalg.norm(R[l] - P[l]) < np.linalg.norm(R[l] - Q[l]))
        return ok / len(trips_L) if trips_L else 0.0

    def best_layer_acc(train_L, test_L):
        """Pick the layer that maximizes TRAIN ordering accuracy, report its TEST accuracy (honest —
        selection never sees test). Returns (test_acc, chosen_layer)."""
        if not train_L or not test_L:
            return 0.0, -1
        nL = train_L[0][0].shape[0]
        best_l = max(range(nL), key=lambda l: _acc_at_layer(train_L, l))
        return round(_acc_at_layer(test_L, best_l), 4), best_l

    ids = sorted({aid for aid, _ in rows})
    results = {"clap_raw": [], "mert_raw": [], "muq_raw": [], "mulan_raw": [],
               "mert_bestlayer": [], "muq_bestlayer": [], "mert_trained": [], "eng_raw": [],
               "gstat_ctrl": []}
    chosen_layers: dict = {"mert": [], "muq": []}
    split_seed = int(os.environ.get("KEYSTONE_SPLIT_SEED", "0"))
    rng = np.random.default_rng(split_seed)
    for sp in range(n_splits):
        order = list(ids)
        rng.shuffle(order)
        cut = max(1, int(round(0.7 * len(order))))
        train_ids, test_ids = set(order[:cut]), set(order[cut:])
        if not test_ids or not train_ids:
            continue
        tr = lambda enc: [r[1][enc] for r in rows if r[0] in train_ids]
        te = lambda enc: [r[1][enc] for r in rows if r[0] in test_ids]
        for k in ("clap", "mert", "muq", "mulan", "eng"):
            results[f"{k}_raw"].append(ordering_accuracy(te(k)))
        results["gstat_ctrl"].append(ordering_accuracy(te("gstat")))
        w = train_reward_head(tr("mert"))
        results["mert_trained"].append(ordering_accuracy(te("mert"), w))
        for lname in ("mert", "muq"):
            trL = [r[1][lname] for r in rowsL if r[0] in train_ids]
            teL = [r[1][lname] for r in rowsL if r[0] in test_ids]
            acc, lyr = best_layer_acc(trL, teL)
            results[f"{lname}_bestlayer"].append(acc)
            chosen_layers[lname].append(lyr)

    def stat(xs):
        return (round(float(np.mean(xs)), 4), round(float(np.min(xs)), 4), round(float(np.max(xs)), 4)) if xs else (0, 0, 0)

    def sign_test(a_key, b_key):
        """Paired per-split one-sided sign test: P(#splits where a>b is this high | coin flip).
        Splits are repeated random subsamples (correlated), so treat p as a lower bound on rigor —
        a non-significant p is decisive (margin within noise); a significant p is suggestive."""
        from math import comb
        diffs = [a - b for a, b in zip(results[a_key], results[b_key])]
        nz = [d for d in diffs if abs(d) > 1e-9]
        n = len(nz)
        k = sum(1 for d in nz if d > 0)
        p = (sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n)) if n else 1.0
        return k, n, round(p, 4)

    print(f"\n  ── §11 KEYSTONE [{mode}] — held-out-BY-SOURCE ordering accuracy ({n_splits} splits) ──")
    order_keys = ("clap_raw", "mulan_raw", "muq_raw", "mert_raw", "muq_bestlayer",
                  "mert_bestlayer", "mert_trained", "eng_raw", "gstat_ctrl")
    for k in order_keys:
        m, lo, hi = stat(results[k])
        extra = ""
        if k == "mert_bestlayer":
            extra = f"  (layers {chosen_layers['mert']})"
        elif k == "muq_bestlayer":
            extra = f"  (layers {chosen_layers['muq']})"
        elif k == "gstat_ctrl":
            extra = "  ← CONFOUND FLOOR (trivial global stats; ~0.5 ⇒ clean ablation)"
        print(f"    {k:16} mean {m:.4f}  [{lo:.4f}–{hi:.4f}]{extra}")

    clap = stat(results["clap_raw"])[0]
    muq = stat(results["muq_raw"])[0]
    gstat = stat(results["gstat_ctrl"])[0]
    # FAIR headline: raw-vs-raw (no per-encoder optimization). bestlayer is reported but NOT the
    # headline — it gets a train-time layer-selection DOF that CLAP has no equivalent of.
    delta = round(muq - clap, 4)
    k_pos, n_eff, p = sign_test("muq_raw", "clap_raw")
    print(f"\n  KEYSTONE [{mode}]: raw MuQ {muq:.4f}  vs  raw CLAP {clap:.4f}   Δ={delta:+.4f}")
    print(f"    paired sign test (muq>clap): {k_pos}/{n_eff} splits, p={p}")
    print(f"    confound floor gstat={gstat:.4f} → margin ABOVE confound: MuQ +{round(muq-gstat,4):+.4f}, "
          f"CLAP +{round(clap-gstat,4):+.4f}")
    verdict = "MuQ beats CLAP, p<0.05 ✓" if (delta > 0 and p < 0.05) else (
        "MuQ leads but NOT significant (within noise) ~" if delta > 0 else "raw CLAP still strongest ✗")
    confounded = " ⚠ CONFOUNDED (gstat≫0.5 — margin may be non-musical)" if gstat > 0.58 else ""
    print(f"  VERDICT: {verdict}{confounded} (report-only; do NOT auto-activate the pull)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

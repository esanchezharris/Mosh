#!/usr/bin/env python3
"""§11 fine-tune RUNG 1 — a learned PROJECTION head on FROZEN music-encoder features.

The keystone established: (a) the DIAGONAL reward head (train_sim) is inert; (b) no RAW encoder
significantly beats CLAP (timbre: CLAP at ceiling 0.97; timing: MuQ leads by ~0.06 but p≈0.38 on the
20-source corpus, with a residual global-stat confound). This is the next rung of train_sim's stated
"real plan": instead of re-weighting frozen dims (diagonal), learn a full nonlinear PROJECTION φ() of
the frozen encoder features under a triplet-margin loss so d(φ(ref),φ(near)) < d(φ(ref),φ(far)).

Why frozen-base first (not unfreezing the 95M encoder): the corpus ceiling is 20 source files (~14 train,
held out by source). Unfreezing 95M params on 14 sources WILL overfit. A small projection on frozen
features is the honest minimal test: if even a full learned transform of MuQ features can't beat CLAP
held-out-by-source, encoder-unfreezing won't either. Overfit shows as train↑/test-flat — reported, not hidden.

Protocol mirrors keystone EXACTLY: held out BY SOURCE; a val sub-split of TRAIN sources for early stopping
(never sees test); ordering accuracy on unseen-source triplets; head-to-head vs raw CLAP on the SAME test
triplets; paired per-split sign test. Power-limited by 20 sources — a non-significant result is decisive.

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/finetune_encoder.py \
        <anchor_store> [base=muq|mert|clap] [mode=timing|swap] [per_pair=2] [n_splits=10]
"""
from __future__ import annotations

import copy
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.anchors import AnchorStore  # noqa: E402
from teardown.flywheel.keystone import ClapEmb, _l2, build_triplets  # noqa: E402
from teardown.flywheel.project_anchors import SR, _Pools  # noqa: E402
from teardown.flywheel.reward_encoder import MertEncoder, MuQEncoder, _device  # noqa: E402
from teardown.flywheel.train_sim import ordering_accuracy  # noqa: E402


def _embed_rows(enc, trips):
    """(aid, (ref,near,far)) frozen, L2-normed embeddings; ref reused across an anchor's triplets."""
    cache: dict = {}

    def e(y):
        k = id(y)
        if k not in cache:
            cache[k] = _l2(enc.embed(y, SR))
        return cache[k]

    return [(aid, (e(r), e(p), e(q))) for (aid, r, p, q) in trips]


def _ordering_acc_proj(model, rows):
    """Test ordering accuracy under the learned projection φ (no grad)."""
    import torch
    if not rows:
        return 0.0
    model.eval()
    with torch.no_grad():
        R = torch.tensor(np.stack([r for _, (r, _, _) in rows]), dtype=torch.float32, device=_device())
        P = torch.tensor(np.stack([p for _, (_, p, _) in rows]), dtype=torch.float32, device=_device())
        Q = torch.tensor(np.stack([q for _, (_, _, q) in rows]), dtype=torch.float32, device=_device())
        pr, pp, pq = model(R), model(P), model(Q)
        dpos = ((pr - pp) ** 2).sum(-1)
        dneg = ((pr - pq) ** 2).sum(-1)
        ok = int((dpos < dneg).sum().item())
    return round(ok / len(rows), 4)


def _make_proj(d_in: int, d_hidden: int = 256, d_out: int = 128):
    import torch.nn as nn
    import torch.nn.functional as F

    class Proj(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(nn.Linear(d_in, d_hidden), nn.GELU(), nn.Linear(d_hidden, d_out))

        def forward(self, x):
            return F.normalize(self.net(x), dim=-1)

    return Proj().to(_device())


def train_proj(train_rows, val_rows, d_in, epochs=400, margin=0.2, lr=1e-3, wd=1e-3, seed=0):
    """Triplet-margin training of φ on frozen features; early-stop on the val-source ordering accuracy.
    Returns (model, best_val_acc, final_train_acc) so overfit (train≫test) is visible."""
    import torch
    torch.manual_seed(seed)
    model = _make_proj(d_in)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=wd)
    dev = _device()
    R = torch.tensor(np.stack([r for _, (r, _, _) in train_rows]), dtype=torch.float32, device=dev)
    P = torch.tensor(np.stack([p for _, (_, p, _) in train_rows]), dtype=torch.float32, device=dev)
    Q = torch.tensor(np.stack([q for _, (_, _, q) in train_rows]), dtype=torch.float32, device=dev)
    best_val, best_state = -1.0, None
    for ep in range(epochs):
        model.train()
        pr, pp, pq = model(R), model(P), model(Q)
        dpos = ((pr - pp) ** 2).sum(-1).clamp_min(1e-12).sqrt()
        dneg = ((pr - pq) ** 2).sum(-1).clamp_min(1e-12).sqrt()
        loss = torch.relu(margin + dpos - dneg).mean()
        opt.zero_grad()
        loss.backward()
        opt.step()
        if val_rows and (ep % 10 == 0 or ep == epochs - 1):
            acc = _ordering_acc_proj(model, val_rows)
            if acc > best_val:
                best_val, best_state = acc, copy.deepcopy(model.state_dict())
    if best_state is not None:
        model.load_state_dict(best_state)
    return model, best_val, _ordering_acc_proj(model, train_rows)


def _sign_test(diffs):
    from math import comb
    nz = [d for d in diffs if abs(d) > 1e-9]
    n = len(nz)
    k = sum(1 for d in nz if d > 0)
    p = (sum(comb(n, i) for i in range(k, n + 1)) / (2 ** n)) if n else 1.0
    return k, n, round(p, 4)


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("usage: finetune_encoder.py <anchor_store> [base=muq|mert|clap] [mode=timing|swap] "
              "[per_pair=2] [n_splits=10]", file=sys.stderr)
        return 2
    store_dir = argv[0]
    base = argv[1] if len(argv) > 1 else "muq"
    mode = argv[2] if len(argv) > 2 else "timing"
    per_pair = int(argv[3]) if len(argv) > 3 else 2
    n_splits = int(argv[4]) if len(argv) > 4 else 10

    anchors = AnchorStore(store_dir).gold()
    if len(anchors) < 4:
        print(f"  INSUFFICIENT anchors ({len(anchors)}) — need ≥4 source files.")
        return 1
    pools = _Pools()
    trips = build_triplets(anchors, pools, mode=mode, per_pair=per_pair)
    print(f"  base={base!r} mode={mode!r}: {len(trips)} triplets from {len(anchors)} anchors", flush=True)

    base_enc = {"muq": MuQEncoder, "mert": MertEncoder, "clap": ClapEmb}[base]()
    print(f"  embedding frozen {base} features…", flush=True)
    rows = _embed_rows(base_enc, trips)
    print("  embedding raw CLAP baseline…", flush=True)
    clap_rows = _embed_rows(ClapEmb(), trips) if base != "clap" else rows
    d_in = rows[0][1][0].shape[0]

    ids = sorted({aid for aid, _ in rows})
    res = {"base_raw": [], "base_proj": [], "clap_raw": [], "train_acc": [], "val_acc": []}
    split_seed = int(os.environ.get("KEYSTONE_SPLIT_SEED", "0"))
    rng = np.random.default_rng(split_seed)
    for sp in range(n_splits):
        order = list(ids)
        rng.shuffle(order)
        cut = max(1, int(round(0.7 * len(order))))
        train_ids, test_ids = order[:cut], set(order[cut:])
        # carve a val SUB-split from TRAIN sources for early stopping (never touches test)
        vcut = max(1, int(round(0.2 * len(train_ids))))
        val_ids, fit_ids = set(train_ids[:vcut]), set(train_ids[vcut:])
        if not test_ids or not fit_ids:
            continue
        fit_rows = [r for r in rows if r[0] in fit_ids]
        val_rows = [r for r in rows if r[0] in val_ids]
        test_rows = [r for r in rows if r[0] in test_ids]
        clap_test = [r for r in clap_rows if r[0] in test_ids]

        model, val_acc, train_acc = train_proj(fit_rows, val_rows, d_in, seed=sp)
        res["base_raw"].append(ordering_accuracy([e for _, e in test_rows]))
        res["base_proj"].append(_ordering_acc_proj(model, test_rows))
        res["clap_raw"].append(ordering_accuracy([e for _, e in clap_test]))
        res["train_acc"].append(train_acc)
        res["val_acc"].append(round(val_acc, 4))
        print(f"    split {sp}: {base}_raw {res['base_raw'][-1]:.3f} → {base}_proj "
              f"{res['base_proj'][-1]:.3f}  (train {train_acc:.3f}/val {val_acc:.3f})  "
              f"clap {res['clap_raw'][-1]:.3f}", flush=True)

    def m(k):
        return round(float(np.mean(res[k])), 4) if res[k] else 0.0

    print(f"\n  ── §11 FINE-TUNE RUNG 1 [{base} φ-projection, {mode}] — held-out-BY-SOURCE ({n_splits} splits) ──")
    for k in ("clap_raw", "base_raw", "base_proj", "val_acc", "train_acc"):
        print(f"    {k:10} mean {m(k):.4f}")
    proj_vs_clap = round(m("base_proj") - m("clap_raw"), 4)
    proj_vs_raw = round(m("base_proj") - m("base_raw"), 4)
    k1, n1, p1 = _sign_test([a - b for a, b in zip(res["base_proj"], res["clap_raw"])])
    k2, n2, p2 = _sign_test([a - b for a, b in zip(res["base_proj"], res["base_raw"])])
    print(f"\n  φ-proj vs raw CLAP: Δ={proj_vs_clap:+.4f}  (sign test {k1}/{n1}, p={p1})")
    print(f"  φ-proj vs raw {base}: Δ={proj_vs_raw:+.4f}  (sign test {k2}/{n2}, p={p2})   "
          f"[train {m('train_acc'):.3f} vs test {m('base_proj'):.3f} ⇒ "
          f"{'OVERFIT' if m('train_acc') - m('base_proj') > 0.15 else 'no severe overfit'}]")
    beats = proj_vs_clap > 0 and p1 < 0.05
    print(f"  VERDICT: {'φ-PROJ BEATS CLAP, p<0.05 ✓' if beats else 'does NOT significantly beat CLAP ✗'} "
          f"(report-only; do NOT auto-activate the pull)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

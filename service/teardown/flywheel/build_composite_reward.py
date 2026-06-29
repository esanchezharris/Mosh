#!/usr/bin/env python3
"""Build + PERSIST the §11 composite reward head — the validated [raw-MuQ timbre]+[learned timing] reward.

The keystone validation trained the timing head and threw it away; a LIVE §12 reward needs it persisted.
This trains the timing φ-projection on SYNTHETIC in-mix grooves (the ecological axis — projection hit
0.85–0.92 held-out-by-source there), computes EXEMPLAR embeddings from the REAL anchor mixes (the
"sounds like good music" references), and saves a self-contained `composite_reward.pt`:
  proj_state (torch) · ex_timbre (N×1024 raw-MuQ) · ex_timing (N×128 projected) · meta.

`CompositeRewardHead` (reward_encoder.py) loads it and exposes `.pull(audio,sr)→[0,1]` =
0.5·(timbre proximity to good exemplars in raw-MuQ space) + 0.5·(timing proximity in the learned space).

    source service/teardown/.teardown.env
    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/build_composite_reward.py \
        <synth_store> <real_store> [out=flywheel/composite_reward.pt] [timing_mode=timing]
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.anchors import AnchorStore  # noqa: E402
from teardown.flywheel.finetune_encoder import train_proj  # noqa: E402
from teardown.flywheel.keystone import _l2, build_triplets  # noqa: E402
from teardown.flywheel.project_anchors import SR, _Pools  # noqa: E402
from teardown.flywheel.reward_encoder import MuQEncoder  # noqa: E402

OUT_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "composite_reward.pt")


def _emb_rows(enc, trips):
    cache: dict = {}

    def e(y):
        k = id(y)
        if k not in cache:
            cache[k] = _l2(enc.embed(y, SR))
        return cache[k]

    return [(aid, (e(r), e(p), e(q))) for (aid, r, p, q) in trips]


def _anchor_mix(a) -> np.ndarray:
    """The full mix of a real anchor (all role stems summed, peak-normed) = a 'good music' reference."""
    import soundfile as sf
    stems = []
    for path in a.stems.values():
        y, _ = sf.read(path, dtype="float32", always_2d=True)
        stems.append(y.mean(axis=1))
    if not stems:
        return np.zeros(1, np.float32)
    n = max(len(s) for s in stems)
    m = np.zeros(n, np.float32)
    for s in stems:
        m[: len(s)] += s
    peak = float(np.max(np.abs(m))) or 1.0
    return (m / peak * 0.9).astype(np.float32)


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if len(argv) < 2:
        print("usage: build_composite_reward.py <synth_store> <real_store> [out.pt] [timing_mode=timing]",
              file=sys.stderr)
        return 2
    import torch
    from teardown.flywheel.reward_encoder import _device

    synth_dir, real_dir = argv[0], argv[1]
    out = argv[2] if len(argv) > 2 else OUT_DEFAULT
    mode = argv[3] if len(argv) > 3 else "timing"

    pools = _Pools()
    synth = AnchorStore(synth_dir).all()
    real = AnchorStore(real_dir).gold()
    if len(synth) < 10 or len(real) < 4:
        print(f"  INSUFFICIENT corpus (synth {len(synth)}, real {len(real)}).", file=sys.stderr)
        return 1
    muq = MuQEncoder()

    # ---- train the TIMING φ-projection on synthetic in-mix grooves (fit/val by source for early-stop)
    sids = sorted({a.anchor_id for a in synth})
    np.random.default_rng(0).shuffle(sids)
    vcut = max(1, int(round(0.15 * len(sids))))
    val_ids = set(sids[:vcut])
    fit = [a for a in synth if a.anchor_id not in val_ids]
    val = [a for a in synth if a.anchor_id in val_ids]
    print(f"  training timing projection on {len(fit)} synth (val {len(val)}), mode={mode!r}…", flush=True)
    fit_rows = _emb_rows(muq, build_triplets(fit, pools, mode=mode, per_pair=1))
    val_rows = _emb_rows(muq, build_triplets(val, pools, mode=mode, per_pair=1))
    d_in = fit_rows[0][1][0].shape[0]
    proj, proj_val, proj_train = train_proj(fit_rows, val_rows, d_in, seed=0)
    proj.eval()
    print(f"  projection trained: val {proj_val:.4f} / train {proj_train:.4f} (d_in={d_in})", flush=True)

    # ---- exemplars: embed each REAL anchor's full mix (good-music references), both spaces
    print(f"  embedding {len(real)} real-anchor mixes as exemplars…", flush=True)
    ex_timbre = []
    for a in real:
        v = _l2(muq.embed(_anchor_mix(a), SR))            # (1024,) raw MuQ timbre space
        ex_timbre.append(v)
    ex_timbre = np.stack(ex_timbre).astype(np.float32)
    with torch.no_grad():
        t = torch.tensor(ex_timbre, dtype=torch.float32, device=_device())
        ex_timing = proj(t).cpu().numpy().astype(np.float32)  # (N,128) learned timing space (already L2)

    meta = {"encoder": muq.version, "in_dim": int(d_in), "out_dim": int(ex_timing.shape[1]),
            "alpha": 0.5, "n_exemplars": int(ex_timbre.shape[0]), "timing_mode": mode,
            "proj_val": float(proj_val), "schema": "composite_reward_v1"}
    torch.save({"proj_state": proj.state_dict(),
                "ex_timbre": torch.tensor(ex_timbre),
                "ex_timing": torch.tensor(ex_timing),
                "meta": meta}, out)
    print(f"\n  SAVED composite reward → {out}")
    print(f"  meta: {meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

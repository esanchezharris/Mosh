#!/usr/bin/env python3
"""Synthetic groove corpus — the TRAIN-set augmentation for the §11 fine-tune.

The keystone fine-tune overfits on 20 real source files. KEY insight that makes synthetic
augmentation honest here: real anchors (`project_anchors.py`) and synthetic anchors are rendered
the SAME way — role-matched §1 LIBRARY samples placed at onsets — so the ONLY domain gap between
train (synthetic) and test (real) is the GROOVE STRUCTURE itself, not timbre. Diverse, realistic
synthetic grooves therefore teach the encoder "order timing/timbre ablations of library-rendered
drum grooves"; the held-out REAL sources check it generalizes to real grooves. Zero leakage by
construction (synthetic and real are disjoint sources; synthetic carries `reconstruction_class
="synthetic"`, which `AnchorStore.gold()` EXCLUDES so it never pollutes the real test set).

Templates come from `groove-template-design` (genre-expert agents → 16th-grid step patterns).
We expand each pattern across random tempos, library samples, swing and human jitter.

    PYTHONPATH=service "$TEARDOWN_PY" service/teardown/flywheel/synth_grooves.py \
        <templates.json> <store_dir> [n_per_pattern=12] [seed=0]
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from teardown.flywheel.anchors import Anchor, AnchorStore  # noqa: E402
from teardown.flywheel.project_anchors import SR, _Pools, _load_sample, render_stem  # noqa: E402

# template role → §1 sample-pool role (the index only knows these families)
ROLE_POOL = {"kick": "kick", "snare": "snare", "clap": "clap", "hat": "hat",
             "openhat": "hat", "808": "808", "perc": "perc"}
MIN_ROLES = 3
MIN_HITS = 2


def _steps_to_onsets(steps, bpm: float, bars: int, swing_pct: float, jitter_ms: float,
                     rng: np.random.Generator) -> list[float]:
    """16th-grid step indices → onset seconds. Applies MPC-style 16th swing (delay odd 16ths) and
    gaussian human jitter. Onsets are clamped into the window so render_stem never truncates oddly."""
    sixteenth = (60.0 / bpm) / 4.0
    window = bars * 4 * (60.0 / bpm)
    out = []
    for s in steps:
        t = s * sixteenth
        if s % 2 == 1:                                   # the off-16th gets swung late
            t += sixteenth * (swing_pct / 100.0)
        t += float(rng.normal(0.0, jitter_ms / 1000.0))  # human feel
        t = min(max(0.0, t), max(0.0, window - 0.05))
        out.append(round(t, 4))
    return sorted(out)


def _maybe_fill(steps: list[int], bars: int, role: str, rng: np.random.Generator) -> list[int]:
    """Light, tasteful variation: ~20% chance of a last-bar snare/hat fill or a dropped hat — keeps
    the groove musical while adding diversity beyond tempo/sample alone."""
    steps = list(steps)
    if bars >= 2 and role in ("snare", "hat") and rng.random() < 0.2:
        last_bar = (bars - 1) * 16
        steps += [last_bar + k for k in (10, 12, 14) if (last_bar + k) not in steps]
    if role == "hat" and len(steps) > 6 and rng.random() < 0.2:
        drop = set(rng.choice(steps, size=max(1, len(steps) // 8), replace=False).tolist())
        steps = [s for s in steps if s not in drop]
    return sorted(set(steps))


def build_synthetic(templates, store_dir, n_per_pattern: int = 12, seed: int = 0) -> int:
    import soundfile as sf
    pools = _Pools()
    if not pools.pools:
        print("  no §1 index pools — build /tmp/td-reward-index first", file=sys.stderr)
        return 0
    store = AnchorStore(store_dir)
    stem_dir = os.path.join(store_dir, "stems")
    os.makedirs(stem_dir, exist_ok=True)
    rng = np.random.default_rng(seed)
    added = 0
    for tpl in templates:
        genre = tpl.get("genre", "g")
        bpm_lo, bpm_hi = tpl.get("bpm_range", [90, 140])
        for pat in tpl.get("patterns", []):
            roles_raw = {r: v for r, v in (pat.get("roles") or {}).items()
                         if v and r in ROLE_POOL}
            if len(roles_raw) < MIN_ROLES:
                continue
            bars = int(pat.get("bars", 2)) or 2
            swing = float(pat.get("swing_pct", 0)) if pat.get("feel") != "straight" else 0.0
            pname = pat.get("name", "p")
            for k in range(n_per_pattern):
                bpm = float(rng.uniform(bpm_lo, bpm_hi))
                window_s = bars * 4 * (60.0 / bpm)
                n = int(window_s * SR)
                raw_id = f"synth_{genre}_{pname}_{k}".replace(" ", "_")
                aid = "".join(c if (c.isalnum() or c in "_-") else "_" for c in raw_id)[:48]
                stems, onsets_local = {}, {}
                for role, steps in roles_raw.items():
                    steps = _maybe_fill([int(s) for s in steps], bars, role, rng)
                    ons = _steps_to_onsets(steps, bpm, bars, swing, rng.uniform(4, 11), rng)
                    ons = [t for t in ons if len(ons) and t < window_s]
                    if len(ons) < MIN_HITS:
                        continue
                    pool_role = ROLE_POOL[role]
                    sp = pools.pick(pool_role, f"{aid}:{role}:{int(rng.integers(1 << 30))}")
                    if not sp:
                        continue
                    try:
                        samp = _load_sample(sp)
                    except Exception:
                        continue
                    path = os.path.join(stem_dir, f"{aid}__{role}.wav")
                    sf.write(path, render_stem(ons, samp, n), SR)
                    stems[role] = path
                    onsets_local[role] = ons
                if len(stems) < MIN_ROLES:
                    continue
                if store.add(Anchor(anchor_id=aid, source_audio="", reconstruction_audio="",
                                    stems=stems, reconstruction_class="synthetic", yield_overall=1.0,
                                    onsets=onsets_local, window_s=round(window_s, 4))):
                    added += 1
    return added


def main(argv=None) -> int:
    argv = argv or sys.argv[1:]
    if len(argv) < 2:
        print("usage: synth_grooves.py <templates.json> <store_dir> [n_per_pattern=12] [seed=0]",
              file=sys.stderr)
        return 2
    templates = json.load(open(argv[0]))
    if isinstance(templates, dict) and "result" in templates:
        templates = templates["result"]
    store_dir = argv[1]
    n_per = int(argv[2]) if len(argv) > 2 else 12
    seed = int(argv[3]) if len(argv) > 3 else 0
    added = build_synthetic(templates, store_dir, n_per, seed)
    store = AnchorStore(store_dir)
    n_src = len({a.anchor_id for a in store.all()})
    print(f"  synthetic anchors added {added}; store now has {len(store.all())} "
          f"({n_src} distinct ids) from {len(templates)} genres", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

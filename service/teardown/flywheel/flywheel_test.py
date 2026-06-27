#!/usr/bin/env python3
"""Hermetic test for §11 flywheel + §12 reward bridge.

    python3 service/teardown/flywheel/flywheel_test.py

Anchor store keeps only `deterministic` as gold; the ablation engine applies graded edits;
the keystone — a trained head PRESERVES the known triplet ordering better than the raw
encoder (on stand-in embeddings; real uses MuQ/MERT + real anchors); the reward floor gates
broken audio to 0 and the pull score rides through; PromptFeed serves renderable prompts.
"""
import os
import sys
import tempfile

import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.flywheel import (Anchor, AblationEngine, AnchorStore, PromptFeed, Reward,  # noqa: E402
                               ordering_accuracy, train_reward_head)

SR = 44100
fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── anchor store: only deterministic is gold ─────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    st = AnchorStore(td)
    check("add deterministic anchor", st.add(Anchor("a1", "src", "rec", reconstruction_class="deterministic", yield_overall=0.9)))
    check("add inferred anchor", st.add(Anchor("a2", "s2", "r2", reconstruction_class="inferred")))
    check("dedup add returns False", st.add(Anchor("a1", "x", "y")) is False)
    check("all() = 2", len(st.all()) == 2)
    check("gold() = only the deterministic one", [a.anchor_id for a in st.gold()] == ["a1"])
    check("persists across reopen", len(AnchorStore(td).all()) == 2)

# ── ablation engine: graded edits applied ────────────────────────────────────
t = np.arange(SR) / SR
stems = {
    "kick": (np.sin(2 * np.pi * 60 * t) * np.exp(-t * 12)).astype(np.float32),
    "bass": (np.sin(2 * np.pi * 110 * t) * 0.5).astype(np.float32),
    "hat": (np.sin(2 * np.pi * 8000 * t) * np.exp(-t * 80) * 0.3).astype(np.float32),
}
eng = AblationEngine(swap_fn=lambda s, role: (0.5 * s + 0.5 * np.roll(s, 137)).astype(np.float32))
tri = eng.make_triplet(stems, ["kick", "bass"])
check("triplet records the swapped roles", tri.swapped == ("kick", "bass"))
check("near differs from ref (1 swap applied)", not np.array_equal(tri.ref, tri.near))
check("far differs from near (2nd swap applied)", not np.array_equal(tri.near, tri.far))
check("all three mixes are non-empty", tri.ref.size and tri.near.size and tri.far.size)

# ── KEYSTONE: a trained head beats raw ordering (stand-in embeddings) ─────────
rng = np.random.default_rng(0)
triplets = []
for _ in range(120):
    r = rng.standard_normal(12)
    near = r.copy(); near[:4] += 0.15 * rng.standard_normal(4); near[4:] = rng.standard_normal(8) * 3.0
    far = r.copy(); far[:4] += 1.2 * rng.standard_normal(4); far[4:] = rng.standard_normal(8) * 3.0
    triplets.append((r, near, far))
raw_acc = ordering_accuracy(triplets)                       # w = ones (noise dims dominate)
w = train_reward_head(triplets, epochs=300, seed=0)
trained_acc = ordering_accuracy(triplets, w)
check("trained head beats raw ordering (the keystone)", trained_acc > raw_acc + 0.1,
      f"raw={raw_acc} trained={trained_acc}")
check("trained ordering is strong (>0.8)", trained_acc > 0.8, str(trained_acc))
check("training is deterministic x3", len({tuple(np.round(train_reward_head(triplets, epochs=50, seed=0), 4)) for _ in range(3)}) == 1)

# ── reward floor + pull + composite (§12 contract) ───────────────────────────
rw = Reward(pull=lambda y, sr: 0.8, version="reward-test")
tone = (np.sin(2 * np.pi * 220 * t) * 0.5).astype(np.float32)
sc = rw.score_audio(tone, SR)
check("score_audio carries the pull score", abs(sc.get("pull", 0) - 0.8) < 1e-9 and "pq" in sc)
check("silent audio → clean floor 0 (broken)", rw.score_audio(np.zeros(SR, np.float32), SR)["clean"] == 0.0)
check("composite > 0 for a valid, good score", rw.composite({"pq": 7.0, "clean": 1.0, "pull": 0.8}) > 0)
check("composite gates broken audio to 0", rw.composite({"pq": 5.0, "clean": 0.0, "pull": 0.9}) == 0.0)
check("reward is versioned", rw.version == "reward-test")

# ── PromptFeed ───────────────────────────────────────────────────────────────
pf = PromptFeed([{"cmd": i} for i in range(5)])
check("renderable_prompts(2) returns 2", len(pf.renderable_prompts(2)) == 2)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))

#!/usr/bin/env python3
"""Golden tests for the compiler oracle (L2) — hermetic, deterministic, no WAV files.

Synthesizes in-memory signals (a tone, a transformed tone, a no-op copy, silence) and
asserts the multi-objective reward behaves: quality discriminates broken vs clean, preserve
discriminates same vs different, intent-weighting shifts the reward, and the reward-hacking
SENTINEL floors silence + no-op renders (so "preserve = do nothing" can't be gamed).

Run:  python3 service/compiler/oracle_test.py     (exit 0 = all pass)
"""
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from compiler import oracle  # noqa: E402

fails = []
SR = 44100


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# Deterministic synthetic signals (no RNG → reproducible).
t = np.arange(int(0.5 * SR)) / SR
tone = 0.3 * np.sin(2 * np.pi * 220.0 * t)                          # the source "take"
transformed = np.tanh(2.5 * (0.3 * np.sin(2 * np.pi * 220.0 * t)    # gritted re-imagine:
                             + 0.15 * np.sin(2 * np.pi * 660.0 * t)))  # added harmonic + drive
noop = tone.copy()                                                 # did nothing
silent = np.zeros_like(tone)                                       # broken render

# ── 1. quality term: a clean tone beats silence ──────────────────────────────────
q_tone = oracle.quality_term(tone, SR)
q_silent = oracle.quality_term(silent, SR)
check(f"quality(tone) {q_tone:.3f} > quality(silent) {q_silent:.3f}", q_tone > q_silent)
check("quality is in [0,1]", 0.0 <= q_tone <= 1.0 and 0.0 <= q_silent <= 1.0)

# ── 2. preserve term: identical ≈ 1.0, transformed < identical ───────────────────
p_same = oracle.preserve_term(tone, tone, SR)
p_diff = oracle.preserve_term(transformed, tone, SR)
check(f"preserve(identical) {p_same:.3f} ≈ 1.0", p_same > 0.98)
check(f"preserve(transformed) {p_diff:.3f} < preserve(identical)", p_diff < p_same)
check("preserve is in [0,1]", 0.0 <= p_diff <= 1.0)

# ── 3. sentinel: no-op + silence are flagged ──────────────────────────────────────
check("no-op render is flagged", "noop" in oracle._sentinel(noop, tone, SR))
check("silent render is flagged", "silent" in oracle._sentinel(silent, tone, SR))
check("a genuine transform is NOT flagged", oracle._sentinel(transformed, tone, SR) == [])

# ── 4. reward: a real re-imagine beats a no-op (the preserve hack is floored) ─────
r_good = oracle.score_arrays(transformed, tone, SR, intent="reimagine")
r_noop = oracle.score_arrays(noop, tone, SR, intent="reimagine")
r_silent = oracle.score_arrays(silent, tone, SR, intent="reimagine")
check(f"reimagine: real transform {r_good['reward']:.3f} > no-op {r_noop['reward']:.3f}",
      r_good["reward"] > r_noop["reward"], f"{r_good['flags']} vs {r_noop['flags']}")
check("no-op reward is floored (<=0.10)", r_noop["reward"] <= 0.10)
check("silent reward is floored (<=0.02)", r_silent["reward"] <= 0.02)
check("reward is in [0,1]", 0.0 <= r_good["reward"] <= 1.0)

# ── 5. the no-op (preserve=1) is ALSO floored under a preserve-heavy transform intent ─
r_noop_tx = oracle.score_arrays(noop, tone, SR, intent="transform")
check("transform no-op is floored despite high preserve (the hack is caught)",
      r_noop_tx["reward"] <= 0.10, str(r_noop_tx))

# ── 6. align term: when provided it shifts the reward; when None it renormalizes ──
r_noalign = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=None)
check("align=None ⇒ terms.align is None", r_noalign["terms"]["align"] is None)
r_align_hi = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=1.0)
r_align_lo = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=0.0)
check(f"reimagine: high align {r_align_hi['reward']:.3f} > low align {r_align_lo['reward']:.3f}",
      r_align_hi["reward"] > r_align_lo["reward"])
check("align reward stays in [0,1]", 0.0 <= r_align_hi["reward"] <= 1.0)

# ── 7. intent weighting differs (reimagine weights align/quality; transform weights preserve) ─
check("reimagine and transform weights differ",
      oracle.WEIGHTS["reimagine"] != oracle.WEIGHTS["transform"])

# ── 8. rewards.jsonl line carries the documented MOSH_RL_REWARD=audio fields ──────
line = oracle.rewards_jsonl_line("r-1", "make it gritty", "reimagine",
                                 {"mode": "reimagine", "colors": [{"name": "grit", "value": 72}]},
                                 r_good)
for key in ("id", "instruction", "intent", "envelope", "terms", "reward"):
    check(f"rewards.jsonl line has '{key}'", key in line)

# ── 9. determinism: identical inputs ⇒ identical reward, 3x ───────────────────────
a = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=0.7)
b = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=0.7)
c = oracle.score_arrays(transformed, tone, SR, intent="reimagine", align=0.7)
check("score is deterministic (a == b == c)", a == b == c, str(a["reward"]))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))

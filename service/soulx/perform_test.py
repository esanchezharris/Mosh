#!/usr/bin/env python3
"""Golden tests for performance transfer (soulx.perform).

The SoulX target score carries words/phonemes/pitch/timing but NO dynamics — the
model invents its own volume/attack/decay, so a render never wears the take's
delivery. `transfer_envelope` fixes that deterministically: measure the take's
energy envelope, gain-match the render frame by frame (silence-gated so the
take's rests force silence, boost-capped so a missing render note can't amplify
noise, smoothed against zipper artifacts, with a strength dial). `env_corr` is
the honest fit metric (envelope correlation on take-active frames — the same
convention the ACE audit used).

Run:  python3 service/soulx/perform_test.py     (exit 0 = all pass)
"""
import hashlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from soulx import perform  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


SR = 8000


def tone(hz, dur_s, amp_fn):
    n = int(dur_s * SR)
    return [amp_fn(i / n) * math.sin(2 * math.pi * hz * i / SR) for i in range(n)]


def silence(dur_s):
    return [0.0] * int(dur_s * SR)


def span(t0, t1):
    return int(t0 * SR), int(t1 * SR)


# ── fixtures ──────────────────────────────────────────────────────────────────────────
# TAKE: punchy attack + exponential decay (0.2–0.7), rest, steady note (1.2–1.5).
take = (silence(0.2)
        + tone(220, 0.5, lambda x: 0.9 * math.exp(-3.0 * x))
        + silence(0.5)
        + tone(330, 0.3, lambda x: 0.6)
        + silence(0.3))

# RENDER: same phrase spans but FLAT dynamics, plus low-level hiss in the take's rest
#         (model breath/noise).
hiss = 0.02
render = (silence(0.2)
          + tone(220, 0.5, lambda x: 0.5)
          + [hiss * math.sin(2 * math.pi * 50 * i / SR) for i in range(int(0.5 * SR))]
          + tone(330, 0.3, lambda x: 0.5)
          + silence(0.3))

out = perform.transfer_envelope(take, render, SR)

# ── 1. the transferred render wears the take's envelope ───────────────────────────────
corr_before = perform.env_corr(take, render, SR)
corr_after = perform.env_corr(take, out, SR)
check("output length == render length", len(out) == len(render))
check("baseline envelope corr is poor (flat render vs decaying take)",
      corr_before < 0.85, f"before={corr_before:.3f}")
check("transferred envelope corr is high", corr_after > 0.95, f"after={corr_after:.3f}")
check("transfer improves the corr", corr_after > corr_before + 0.1,
      f"{corr_before:.3f} -> {corr_after:.3f}")

# decay actually transferred: early in phrase 1 the output is much louder than late
a0, a1 = span(0.23, 0.28)
b0, b1 = span(0.62, 0.67)
early = max(abs(v) for v in out[a0:a1])
late = max(abs(v) for v in out[b0:b1])
check("attack/decay shape transferred (early >> late in the decaying phrase)",
      early > 2.5 * late, f"early={early:.3f} late={late:.3f}")

# ── 2. the take's rests force silence (kills model breath/hiss) ───────────────────────
r0, r1 = span(0.80, 1.10)
check("render hiss in the take's rest is silenced",
      max(abs(v) for v in out[r0:r1]) < 1e-3,
      f"max={max(abs(v) for v in out[r0:r1]):.5f}")

# ── 3. asymmetric boost: lift only where the render is actually VOICING ───────────────
# (own fixtures — a genuinely missed phrase SHOULD also tank env_corr, so they can't
#  live inside the corr fixture above)
# 3a. breath/hiss where the take sings: never amplified (gain <= 1 on non-voicing
#     frames). The render must SING elsewhere — voicing is judged relative to the
#     render's own singing level, so an all-hiss fixture would be degenerate.
take2 = (silence(0.2) + tone(220, 0.3, lambda x: 0.6) + silence(0.3)
         + tone(262, 0.3, lambda x: 0.7) + silence(0.2))
render2 = (silence(0.2) + tone(220, 0.3, lambda x: 0.5) + silence(0.3)
           + [hiss * math.sin(2 * math.pi * 50 * i / SR) for i in range(int(0.3 * SR))]
           + silence(0.2))
out2 = perform.transfer_envelope(take2, render2, SR, max_boost=12.0)
m0, m1 = span(0.82, 1.08)
check("render breath under a take note is NOT amplified (even at a high cap)",
      max(abs(v) for v in out2[m0:m1]) <= hiss * 1.05,
      f"max={max(abs(v) for v in out2[m0:m1]):.4f} vs hiss={hiss}")

# 3b. a quiet-but-VOICED render syllable IS lifted to the take's level
take3 = silence(0.2) + tone(262, 0.4, lambda x: 0.6) + silence(0.2)
render3 = silence(0.2) + tone(262, 0.4, lambda x: 0.1) + silence(0.2)
out3 = perform.transfer_envelope(take3, render3, SR, max_boost=12.0)
v0, v1 = span(0.3, 0.5)
lifted = max(abs(v) for v in out3[v0:v1])
check("quiet voiced render syllable lifted to the take's level",
      0.45 <= lifted <= 0.75, f"peak={lifted:.3f} (take sings at 0.6)")

# ── 4. strength dial: 0 = identity ────────────────────────────────────────────────────
ident = perform.transfer_envelope(take, render, SR, strength=0.0)
check("strength=0 returns the render unchanged",
      max(abs(a - b) for a, b in zip(ident, render)) < 1e-9)

# ── 4b. SLOT-LEVEL SNAP (strict round): each word lands on its slot's exact start ─────
# Phrase snap fixes phrase STARTS only; SoulX places syllables inside a phrase freely.
# snap_to_events measures each word-event's local lag vs the take (envelope
# cross-correlation in the window bounded by the neighboring events) and shifts that
# segment onto the slot start. Audio between events (legato continuations) rides along.
# take: three syllables attacking at 0.20 / 0.50 / 0.80 exactly (the slot starts)
take_s = (silence(0.20) + tone(220, 0.22, lambda x: 0.6) + silence(0.08)
          + tone(277, 0.22, lambda x: 0.6) + silence(0.08)
          + tone(330, 0.22, lambda x: 0.6) + silence(0.20))
# render: same syllables but #2 lands +80ms late and #3 +40ms late (independent lags —
# each event must be corrected by ITS OWN measured shift, not a shared phrase lag)
rend_s = (silence(0.20) + tone(220, 0.22, lambda x: 0.6) + silence(0.16)
          + tone(277, 0.22, lambda x: 0.6) + silence(0.04)
          + tone(330, 0.22, lambda x: 0.6) + silence(0.16))
EVENTS = [(0.20, 0.42), (0.50, 0.72), (0.80, 1.02)]

snapped = perform.snap_to_events(take_s, rend_s, SR, EVENTS)
check("snap output length covers the take", len(snapped) >= len(take_s) - SR // 100)


def _attack(sig, t0, t1):
    """First time the local envelope crosses half its window max — the audible attack."""
    import math as _m
    a, b = int(t0 * SR), int(t1 * SR)
    seg = sig[a:b]
    win = max(1, SR // 100)
    env = [sum(abs(x) for x in seg[i:i + win]) / win for i in range(0, len(seg) - win, win)]
    if not env or max(env) <= 0:
        return None
    th = 0.5 * max(env)
    for i, e in enumerate(env):
        if e >= th:
            return t0 + i * win / SR
    return None


for i, (s, e) in enumerate(EVENTS):
    # scan starts just before the slot (after the previous syllable's take-side end),
    # or the neighbor's sustain reads as a false early attack
    at = _attack(snapped, s - 0.05, s + 0.17)
    check(f"syllable {i + 1} attacks within 20ms of its slot start",
          at is not None and abs(at - s) <= 0.02, f"attack={at}")
check("slot snap is deterministic (3x)",
      len({hashlib.sha256(",".join(f"{v:.9f}" for v in perform.snap_to_events(take_s, rend_s, SR, EVENTS)).encode()).hexdigest()
           for _ in range(3)}) == 1)
lags = perform.event_lags(take_s, rend_s, SR, EVENTS)
check("event_lags reports each word's measured lag (0/+80/+40ms here)",
      len(lags) == 3 and abs(lags[0]) <= 0.015 and abs(lags[1] - 0.08) <= 0.015
      and abs(lags[2] - 0.04) <= 0.015, str([round(x * 1000) for x in lags]))

# ── 5. metric sanity + determinism ────────────────────────────────────────────────────
check("env_corr(x, x) ~= 1", perform.env_corr(take, take, SR) > 0.999)


def digest():
    o = perform.transfer_envelope(take, render, SR)
    return hashlib.sha256(",".join(f"{v:.9f}" for v in o).encode()).hexdigest()


d = {digest() for _ in range(3)}
check("transfer_envelope deterministic (3x)", len(d) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)

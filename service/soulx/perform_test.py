#!/usr/bin/env python3
"""Golden tests for the performance lock (soulx.perform).

The SoulX target score places syllables within a phrase freely, so a render lands
close to — but not exactly on — the take's clock. `snap_to_events` / `event_lags`
measure each word-event's local lag against the take (envelope cross-correlation)
and shift that segment onto the slot's exact start — the timing snap that feeds the
NSF re-vocode (which now supplies the natural dynamics). `env_corr` is the honest
fit metric (envelope correlation on take-active frames — the same convention the
ACE audit used).

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

# ── 5. metric sanity ──────────────────────────────────────────────────────────────────
check("env_corr(x, x) ~= 1", perform.env_corr(take, take, SR) > 0.999)

# ── 6. snap_render_to_take: the product single-clip snap (PHRASE alignment ONLY) ──────
# Mechanism-verify V3 (2026-07-17): the per-word snap_to_events stage ranked WORST in
# both blind passages (while raising env_corr) — it is REMOVED from the product chain.
# The pin is equality with the pure phrase-only construction: windows from the clip,
# phrase_shifts measured, apply_shifts applied — and NOTHING word-level after it.
CLIP = {"duration": "0.20 0.22 0.08 0.22 0.08 0.22 0.20", "note_type": "1 2 1 2 1 2 1"}
from soulx.score import phrase_windows as _pw  # noqa: E402
_windows = _pw(CLIP)
_env_t = perform.energy_envelope(take_s, SR, hop_ms=perform.HOP_S * 1000.0)
_env_r = perform.energy_envelope(rend_s, SR, hop_ms=perform.HOP_S * 1000.0)
_expected = perform.apply_shifts(rend_s, SR, _windows, perform.phrase_shifts(_env_t, _env_r, _windows),
                                 total_s=len(take_s) / SR)
snapped2 = perform.snap_render_to_take(take_s, rend_s, SR, CLIP)
check("snap_render_to_take == phrase-only alignment (no word-level stage)",
      snapped2 == _expected, f"len {len(snapped2)} vs {len(_expected)}")
resid = perform.event_lags(take_s, snapped2, SR, EVENTS)
check("per-word residual lags are MEASURED, not enforced (word snap is gone)",
      len(resid) == 3, str([round(x * 1000) for x in resid]))
resid_id = perform.event_lags(take_s, perform.snap_render_to_take(take_s, take_s, SR, CLIP), SR, EVENTS)
check("snap_render_to_take on an already-aligned render keeps events on-grid",
      all(abs(x) <= 0.02 for x in resid_id), str([round(x * 1000) for x in resid_id]))
check("snap_render_to_take deterministic (3x)",
      len({hashlib.sha256(",".join(f"{v:.9f}" for v in perform.snap_render_to_take(take_s, rend_s, SR, CLIP)).encode()).hexdigest()
           for _ in range(3)}) == 1)
# empty clip (no events/windows) -> identity-safe, never raises
_id = perform.snap_render_to_take(take_s, rend_s, SR, {"duration": "", "note_type": ""})
check("snap_render_to_take on an empty clip returns the render unchanged (no-op safe)",
      _id == list(rend_s), f"len {len(_id)} vs {len(rend_s)}")

# ── 7. resample_linear: rate conversion so take/render envelopes meet ─────────────────
check("resample_linear doubles length 4->8 rate", len(perform.resample_linear([0.0, 1.0, 0.0, -1.0], 4, 8)) == 8)
check("resample_linear is a no-op at equal rate", perform.resample_linear([1.0, 2.0], 8, 8) == [1.0, 2.0])
check("resample_linear empty -> empty", perform.resample_linear([], 24000, 44100) == [])

# ── 7b. resample_hq: band-limited, no HF imaging (the "squeak" fix) ────────────────────
check("resample_hq no-op at equal rate", perform.resample_hq([1.0, 2.0, 3.0], 8, 8) == [1.0, 2.0, 3.0])
check("resample_hq empty -> empty", perform.resample_hq([], 24000, 44100) == [])
_hq = perform.resample_hq([0.0, 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0], 24000, 44100)
check("resample_hq ~doubles length near the rate ratio",
      abs(len(_hq) - round(8 * 44100 / 24000)) <= 2, f"len {len(_hq)}")
check("resample_hq deterministic",
      perform.resample_hq([0.1, -0.2, 0.3, -0.4, 0.5], 24000, 44100)
      == perform.resample_hq([0.1, -0.2, 0.3, -0.4, 0.5], 24000, 44100))
try:
    import math as _m

    import numpy as _np
    from scipy.signal import resample_poly as _rp  # noqa: F401
    # a 24k signal whose energy sits near its 12k Nyquist; upsample to 44.1k two ways and
    # compare spurious energy in the 12-20k band (real content there is ~0).
    _t = _np.arange(24000) / 24000.0
    _sig = (0.6 * _np.sin(2 * _np.pi * 10500 * _t) + 0.4 * _np.sin(2 * _np.pi * 11500 * _t)).tolist()

    def _hf(y, sr, lo=12000, hi=20000):
        Y = _np.abs(_np.fft.rfft(_np.asarray(y))) ** 2
        f = _np.fft.rfftfreq(len(y), 1.0 / sr)
        return float(Y[(f >= lo) & (f < hi)].sum() / max(Y.sum(), 1e-12))

    _lin_hf = _hf(perform.resample_linear(_sig, 24000, 44100), 44100)
    _hq_hf = _hf(perform.resample_hq(_sig, 24000, 44100), 44100)
    check("resample_hq leaves far less 12-20k imaging than linear (>=5x)",
          _hq_hf * 5 < _lin_hf, f"hq {_hq_hf:.5f} vs linear {_lin_hf:.5f}")
except ImportError:
    print("[skip] numpy/scipy absent — resample_hq falls back to linear (quality check skipped)")

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}")
sys.exit(1 if fails else 0)

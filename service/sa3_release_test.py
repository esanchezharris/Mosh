"""Golden for sa3_release + memprobe — when to hand back the render model's 9.2 GB.

The thresholds here are the whole feature, and both directions of getting them
wrong are expensive in ways that do not announce themselves:

  * too eager  -> every audition pays a measured +1.1 s reload for nothing
  * too lazy   -> the trainer and the render model together cross the memory
                  wall, macOS grows the swapfile instead of failing, and an
                  hour-long run silently drops from ~1.1 s/step to ~65 s/step

So the cases below are pinned against the ACTUAL measurements, and the two
calibration points (88% free while healthy, 19% while thrashing) appear
explicitly — if someone re-tunes the numbers, these tests should be re-derived
from new measurements, not nudged until they pass.

Run:  python3 service/sa3_release_test.py
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import memprobe      # noqa: E402
import sa3_release   # noqa: E402

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def main() -> None:
    R = sa3_release

    # ── the two measured states, both directions ────────────────────────────
    # 88% free is the observed HEALTHY state: hold the model, keep takes fast.
    check(not R.should_release(0.88, training_active=True),
          "released at 88% free during training — that is the healthy state, and "
          "releasing there costs ~1.1s per take for nothing")
    check(not R.should_release(0.88, training_active=False),
          "released at 88% free while idle")

    # 19% free is the observed THRASHING state: release in both modes.
    check(R.should_release(0.19, training_active=True),
          "did NOT release at 19% free during training — the measured thrash state")
    check(R.should_release(0.19, training_active=False),
          "did NOT release at 19% free while idle")

    # ── the asymmetry is real, and points the right way ─────────────────────
    # Training active means acting EARLIER, because the downside is minutes-to-
    # hours in one direction and ~1 second in the other. A test that only
    # checked "releases when low" would pass with both thresholds equal, so the
    # gap itself is asserted, and with a value that lands BETWEEN them.
    check(R.RELEASE_BELOW_TRAINING > R.RELEASE_BELOW_IDLE,
          f"training threshold ({R.RELEASE_BELOW_TRAINING}) must be HIGHER than idle "
          f"({R.RELEASE_BELOW_IDLE}) — the whole point is acting sooner when a run is at stake")
    between = (R.RELEASE_BELOW_IDLE + R.RELEASE_BELOW_TRAINING) / 2
    check(R.should_release(between, training_active=True),
          f"{between:.0%} free during training should release (limit {R.RELEASE_BELOW_TRAINING:.0%})")
    check(not R.should_release(between, training_active=False),
          f"{between:.0%} free while idle should HOLD (limit {R.RELEASE_BELOW_IDLE:.0%}) — "
          "if this fails the two modes are behaving identically")

    # Both thresholds must sit at or below the measured 70%-used wall (30% free),
    # or the guard fires only after the damage.
    check(R.RELEASE_BELOW_TRAINING <= 0.50 and R.RELEASE_BELOW_IDLE <= 0.30,
          f"thresholds drifted implausibly high: {R.RELEASE_BELOW_TRAINING}/{R.RELEASE_BELOW_IDLE}")

    # ── exact boundaries: strictly below, not at ────────────────────────────
    check(not R.should_release(R.RELEASE_BELOW_IDLE, False), "idle boundary should be exclusive")
    check(R.should_release(R.RELEASE_BELOW_IDLE - 0.001, False), "just under idle limit should release")
    check(not R.should_release(R.RELEASE_BELOW_TRAINING, True), "training boundary should be exclusive")
    check(R.should_release(R.RELEASE_BELOW_TRAINING - 0.001, True), "just under training limit should release")

    # ── an unreadable probe is resolved by what is at stake ─────────────────
    # Not by a blanket default. With a run going, pay ~1.1s rather than gamble an
    # hour; with nothing running, there is nothing to protect.
    check(R.should_release(None, training_active=True),
          "unknown memory + training should release (asymmetric downside)")
    check(not R.should_release(None, training_active=False),
          "unknown memory while idle should NOT release — nothing is at stake")

    # Finder owner policy is carried per render as well as through the service's
    # startup environment, so reconnecting to an older service still unloads.
    check(R.should_release_with_idle_override(0.88, False, 0.99),
          "owner 99% idle override should release at the measured healthy 88% state")
    check(not R.should_release_with_idle_override(0.88, False, 0.80),
          "idle override boundary must still point the right way")
    check(not R.should_release_with_idle_override(0.88, True, 0.99),
          "idle override must not replace the separate active-training policy")

    # ── explain() says which way and why (the only trace of the reload cost) ──
    for avail, active, want in ((0.19, True, "release"), (0.88, True, "keep"),
                                (None, True, "release"), (None, False, "keep")):
        text = R.explain(avail, active)
        check(want in text, f"explain({avail}, {active}) should say {want!r}: {text!r}")
        check(("training active" if active else "idle") in text,
              f"explain should name the mode: {text!r}")

    # ── the probe itself ───────────────────────────────────────────────────
    v = memprobe.available_fraction(force=True)
    check(v is None or (0.0 <= v <= 1.0), f"available_fraction out of range: {v}")
    if v is None:
        print("  note: memory probe unavailable here (not macOS?) — decisions fall back "
              "to the training_active branch, which is asserted above")
    else:
        # Cheap enough to sit on the render path: measured ~4 ms.
        import time
        t0 = time.time()
        for _ in range(5):
            memprobe.available_fraction(force=True)
        per = (time.time() - t0) / 5
        check(per < 0.25, f"probe too slow for the render path: {per*1000:.0f} ms/call")
        # The 1s cache must actually cache, or a burst of takes re-probes each time.
        t0 = time.time()
        for _ in range(50):
            memprobe.available_fraction()
        check((time.time() - t0) < 0.05, "cached reads are not cached")

    print(f"sa3_release_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()

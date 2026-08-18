"""Tests for the training recipe defaults.

Script-style (`python3 service/training/recipe_test.py`) to match the gate's
`run_py_tests`, which executes each `*_test.py` directly rather than under
pytest — a pytest-style file of bare functions would run NOTHING here and
report success.

The numbers asserted are MEASURED (see recipe.py's docstring), so a failure
means the code drifted or the measurements were re-taken — never "adjust the
test until it goes green".
"""

from __future__ import annotations

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/training/
import recipe  # noqa: E402


def test_epoch_curve_hits_the_measured_anchors() -> None:
    # The three corpora actually trained in the 2026-08 round.
    assert recipe.epochs_for(33) == 145.0
    assert recipe.epochs_for(189) == 44.0
    assert recipe.epochs_for(424) == 11.0


def test_epoch_curve_is_monotonically_decreasing() -> None:
    # More clips -> fewer epochs. A non-monotonic curve would recommend MORE
    # training for a bigger corpus: backwards, and hours wasted.
    prev = float("inf")
    for n in range(1, 600, 7):
        e = recipe.epochs_for(n)
        assert e <= prev + 1e-9, f"epochs rose at clip_count={n}: {prev} -> {e}"
        prev = e


def test_epoch_curve_clamps_outside_the_measured_range() -> None:
    # Outside the anchors there is no evidence, so hold the endpoint rather than
    # extrapolating into a number nobody measured.
    assert recipe.epochs_for(1) == 145.0
    assert recipe.epochs_for(10) == 145.0
    assert recipe.epochs_for(5000) == 11.0


def test_footprint_matches_the_four_measured_points() -> None:
    # phys_footprint at batch 1/2/3/4 on the reference 64GB M1 Max. Measured via
    # `footprint -p <pid>`: MLX memory is invisible to RSS (ps reports ~1.2GB for
    # a run using 22GB), so any re-measurement must use footprint too.
    for batch, measured in [(1, 22.0), (2, 31.0), (3, 40.0), (4, 49.0)]:
        assert abs(recipe.footprint_gb(batch) - measured) <= 0.5, batch


def test_batch_plan_avoids_the_measured_thrash_case() -> None:
    # batch=4 is 49GB = 76.6% of 64GB and THRASHED: 12.65 s/step vs ~1.1 healthy,
    # i.e. worse per sample than batch=1.
    batch, accum = recipe.batch_plan(ram_gb=64.0)
    assert batch * accum == 4, "effective batch must stay 4"
    assert recipe.footprint_gb(batch) <= 64.0 * 0.70
    assert batch != 4, "batch=4 on 64GB is the measured thrash case"


def test_batch_plan_scales_to_a_bigger_machine() -> None:
    # 128GB has room for the literal batch 4 (49GB = 38%).
    assert recipe.batch_plan(ram_gb=128.0) == (4, 1)


def test_batch_plan_falls_back_safely_on_an_unknown_machine() -> None:
    assert recipe.batch_plan(ram_gb=0.0) == (2, 2)


def test_steps_round_trip_the_epoch_definition() -> None:
    # steps * effective_batch >= epochs * clips, and minimally so.
    for clips, epochs, batch, accum in [(33, 145, 2, 2), (189, 44, 2, 2), (424, 11, 3, 1)]:
        steps = recipe.steps_for(clips, epochs, batch, accum)
        assert steps * batch * accum >= epochs * clips
        assert (steps - 1) * batch * accum < epochs * clips, "not the minimal step count"


def test_recommend_recipe_reproduces_the_real_runs() -> None:
    r = recipe.recommend_recipe(33, ram_gb=64.0)
    assert r["epochs"] == 145.0
    assert r["effectiveBatch"] == 4
    assert r["steps"] == math.ceil(145 * 33 / 4) == 1197
    assert r["footprintGb"] <= 64.0 * 0.70
    assert r["estMinutes"] > 0
    # The honesty note must survive: it is the round's central finding.
    assert "ear" in r["note"]


def main() -> None:
    fails = []
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
            except Exception as exc:  # noqa: BLE001
                fails.append(f"{name}: {exc}")
    for f in fails:
        print("FAIL", f)
    if fails:
        sys.exit(1)
    print("recipe_test: OK (epoch curve, footprint model, batch plan, steps round-trip)")


if __name__ == "__main__":
    main()

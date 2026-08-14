"""Tests for the Phase-1 pilot phrase freeze.

Deliberately reads no fixture ground truth: every case is synthetic. The real
fixtures carry lyrics and word-truth files that must never enter a log.
"""
import sys

from freeze_fixtures import SPAN_CAP_S, select_phrases, span_seconds


def _phrase(pid, cls="supported", start=0.0, end=5.0):
    return {"id": pid, "fixture": "stage10", "start_s": start, "end_s": end, "class": cls}


def test_span_cap_is_fifteen_seconds():
    assert SPAN_CAP_S == 15.0


def test_rejects_span_over_cap():
    try:
        span_seconds(_phrase("a", end=15.01))
    except ValueError as e:
        assert "15" in str(e)
    else:
        raise AssertionError("expected ValueError for a 15.01s span")


def test_accepts_span_at_cap():
    assert span_seconds(_phrase("a", end=15.0)) == 15.0


def test_rejects_non_positive_span():
    try:
        span_seconds(_phrase("a", start=3.0, end=3.0))
    except ValueError as e:
        assert "non-positive" in str(e)
    else:
        raise AssertionError("expected ValueError for a zero-length span")


def test_selects_exactly_twelve_supported():
    manifest = [_phrase(f"p{i:02d}", "supported" if i < 20 else "challenge") for i in range(24)]
    out = select_phrases(manifest, 12)
    assert len(out) == 12
    assert all(p["class"] == "supported" for p in out)


def test_challenge_cases_never_enter_denominator():
    manifest = [_phrase("c0", "challenge")]
    try:
        select_phrases(manifest, 1)
    except ValueError as e:
        assert "supported" in str(e)
    else:
        raise AssertionError("expected ValueError when no supported phrases exist")


def test_rejects_an_oversized_span_even_when_enough_phrases_exist():
    manifest = [_phrase(f"p{i:02d}") for i in range(20)]
    manifest[3]["end_s"] = 20.0
    try:
        select_phrases(manifest, 12)
    except ValueError as e:
        assert "exceeds" in str(e)
    else:
        raise AssertionError("an oversized span must fail the whole freeze, not be silently dropped")


def test_selection_is_deterministic():
    manifest = [_phrase(f"p{i:02d}") for i in range(20)]
    first = [p["id"] for p in select_phrases(manifest, 12)]
    second = [p["id"] for p in select_phrases(manifest, 12)]
    assert first == second


if __name__ == "__main__":
    import traceback

    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except Exception:
                failures += 1
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"\n{failures} failure(s)")
    sys.exit(1 if failures else 0)

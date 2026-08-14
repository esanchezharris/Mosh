"""Tests for the fail-closed render guards.

These cover the two silent-corruption modes the existing killshot tooling does
not enforce: a render that drifts in length, and a render that alters the
instrumental outside the vocal span. The scope lock forbids the latter outright
-- "the instrumental is never regenerated or altered" -- so both must fail
closed rather than degrade a score.
"""
import pathlib
import struct
import sys
import tempfile
import wave

from score_render import ScoreError, assert_exact_samples, assert_instrumental_null


def _wav(path, frames, rate=44100):
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"".join(struct.pack("<h", v) for v in frames))


def test_exact_samples_accepts_identical_length():
    with tempfile.TemporaryDirectory() as d:
        a, b = pathlib.Path(d) / "a.wav", pathlib.Path(d) / "b.wav"
        _wav(a, [0] * 1000)
        _wav(b, [1] * 1000)
        assert_exact_samples(a, b)


def test_exact_samples_rejects_one_sample_drift():
    with tempfile.TemporaryDirectory() as d:
        a, b = pathlib.Path(d) / "a.wav", pathlib.Path(d) / "b.wav"
        _wav(a, [0] * 1000)
        _wav(b, [0] * 1001)
        try:
            assert_exact_samples(a, b)
        except ScoreError as e:
            assert "1000" in str(e) and "1001" in str(e)
        else:
            raise AssertionError("a one-sample drift must fail closed")


def test_instrumental_null_rejects_change_after_the_span():
    before = [0] * 1000
    after = list(before)
    after[900] = 500
    try:
        assert_instrumental_null(before, after, (0, 800))
    except ScoreError as e:
        assert "outside" in str(e).lower()
    else:
        raise AssertionError("instrumental change after the vocal span must fail closed")


def test_instrumental_null_rejects_change_before_the_span():
    before = [0] * 1000
    after = list(before)
    after[10] = 500
    try:
        assert_instrumental_null(before, after, (100, 800))
    except ScoreError as e:
        assert "outside" in str(e).lower()
    else:
        raise AssertionError("instrumental change before the vocal span must fail closed")


def test_instrumental_null_rejects_a_single_lsb_change():
    before = [0] * 1000
    after = list(before)
    after[950] = 1
    try:
        assert_instrumental_null(before, after, (0, 800))
    except ScoreError:
        pass
    else:
        raise AssertionError("even a one-LSB change outside the span must fail closed")


def test_instrumental_null_allows_change_inside_the_span():
    before = [0] * 1000
    after = list(before)
    after[400] = 500
    assert_instrumental_null(before, after, (0, 800))


def test_instrumental_null_rejects_length_drift():
    try:
        assert_instrumental_null([0] * 1000, [0] * 999, (0, 800))
    except ScoreError as e:
        assert "length" in str(e).lower()
    else:
        raise AssertionError("length drift must fail closed")


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

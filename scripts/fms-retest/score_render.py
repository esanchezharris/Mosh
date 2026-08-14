"""Fail-closed guards for Phase-1 renders.

The existing `scripts/fms-killshot/` analysis tooling compares waveforms and
energy but enforces neither an exact sample count nor an instrumental null.
Those are the two ways a render can look good while being wrong:

  * length drift -- the render no longer lines up with the original vocal, so
    every downstream alignment metric is measuring the wrong thing;
  * instrumental change -- the scope lock says "the instrumental is never
    regenerated or altered", so any sample changed outside the vocal span is a
    contract violation, not a quality deduction.

Both raise `ScoreError`. A violation is a FAILED RENDER that stays in the
denominator; it is never a retry.
"""
import wave


class ScoreError(RuntimeError):
    """A render violated a frozen contract. Not recoverable by re-rendering."""


def _frames(path):
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes()


def assert_exact_samples(a_path, b_path):
    """Raise unless both files hold exactly the same number of sample frames."""
    a, b = _frames(a_path), _frames(b_path)
    if a != b:
        raise ScoreError(f"sample-count drift: {a_path} has {a}, {b_path} has {b}")


def assert_instrumental_null(before, after, vocal_span):
    """Raise if any sample outside `vocal_span` changed.

    `vocal_span` is a half-open (lo, hi) sample range. Comparison is exact --
    a one-LSB change outside the span still fails, because there is no
    legitimate reason for the instrumental to move at all.
    """
    lo, hi = vocal_span
    if len(before) != len(after):
        raise ScoreError(f"length drift: {len(before)} vs {len(after)}")
    for i, (x, y) in enumerate(zip(before, after)):
        if (i < lo or i >= hi) and x != y:
            raise ScoreError(
                f"instrumental altered outside the vocal span at sample {i}: {x} != {y}"
            )


def _main(argv):
    import argparse
    import json
    import pathlib

    parser = argparse.ArgumentParser(description="Apply the frozen render guards.")
    parser.add_argument("--frozen", required=True, help="path to frozen.json")
    parser.add_argument("--renders", required=True, help="directory of Phase-1 renders")
    ns = parser.parse_args(argv)

    frozen = json.loads(pathlib.Path(ns.frozen).read_text())
    renders = pathlib.Path(ns.renders)
    checked = 0
    for phrase in frozen["supported"]:
        reference = renders / f"{phrase['id']}.reference.wav"
        if not reference.exists():
            raise ScoreError(f"missing reference {reference}")
        for variant in ("first", "alternate"):
            candidate = renders / f"{phrase['id']}.{variant}.wav"
            if not candidate.exists():
                raise ScoreError(f"missing render {candidate}")
            assert_exact_samples(reference, candidate)
            checked += 1
    print(f"OK: {checked} renders passed the exact-sample guard")
    return 0


if __name__ == "__main__":
    import sys

    try:
        sys.exit(_main(sys.argv[1:]))
    except ScoreError as exc:
        print(f"ScoreError: {exc}", file=sys.stderr)
        sys.exit(1)

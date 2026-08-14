"""Freeze the Phase-1 pilot phrase set for the Finish My Song retest.

Reads only durations, window metadata and audio bytes. It never opens a
`*.lyrics*.txt`, `*.words*.json`, `voicebox.db` or blind `*-KEY.json` file --
those carry ground truth, and leaking them into a log or a prompt invalidates
the run.

The frozen gate is the owner's recorded decision and is not adjustable here:
12 supported phrases, >=9 usable on first result, >=11 usable with one
alternate. Challenge cases (wet/doubled vocals, closed-mouth hums) are recorded
separately and never enter that denominator.
"""
import hashlib
import json
import pathlib

SPAN_CAP_S = 15.0
FIXTURES = ("stage9orsum", "stage10", "LookinBack")
SUPPORTED_COUNT = 12
GATE = {"first_result_min": 9, "with_alternate_min": 11, "denominator": SUPPORTED_COUNT}


def span_seconds(phrase):
    """Return the phrase span, rejecting anything outside the frozen bounds."""
    span = float(phrase["end_s"]) - float(phrase["start_s"])
    if span <= 0:
        raise ValueError(f"non-positive span for {phrase['id']}: {span}")
    if span > SPAN_CAP_S:
        raise ValueError(
            f"span {span}s exceeds the frozen {SPAN_CAP_S}s cap for {phrase['id']}"
        )
    return span


def select_phrases(manifest, n=SUPPORTED_COUNT):
    """Pick exactly n supported phrases, deterministically.

    Every supported phrase is validated before selection, so an oversized span
    fails the whole freeze rather than being silently dropped from the pool --
    a silent drop would shrink the denominator, which the frozen gate forbids.
    """
    supported = [p for p in manifest if p["class"] == "supported"]
    if len(supported) < n:
        raise ValueError(
            f"need {n} supported phrases, manifest has {len(supported)}"
        )
    for phrase in supported:
        span_seconds(phrase)
    return sorted(supported, key=lambda p: p["id"])[:n]


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def freeze(manifest_path, out_path, root):
    """Write frozen.json: the immutable Phase-1 pilot definition."""
    manifest = json.loads(pathlib.Path(manifest_path).read_text())
    chosen = select_phrases(manifest, SUPPORTED_COUNT)
    challenge = [p for p in manifest if p["class"] == "challenge"]
    root = pathlib.Path(root).expanduser()
    audio = {name: sha256_file(root / f"{name}.mumble.wav") for name in FIXTURES}
    payload = {
        "schema": "fms-retest-frozen-v1",
        "span_cap_s": SPAN_CAP_S,
        "gate": GATE,
        "supported": chosen,
        "challenge": challenge,
        "audio_sha256": audio,
    }
    out = pathlib.Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return chosen


def _main(argv):
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--root", default="~/mosh-fms-ksb/bench/datasets/own-pairs")
    ns = parser.parse_args(argv)
    chosen = freeze(ns.manifest, ns.out, ns.root)
    print(f"froze {len(chosen)} supported phrases -> {ns.out}")
    return 0


if __name__ == "__main__":
    import sys

    sys.exit(_main(sys.argv[1:]))

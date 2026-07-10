from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_ace_cover_test import _request  # noqa: E402
from asserted_proof_ace_probe import PROBE_SEED, build_probe_request, probe_slug  # noqa: E402


def test_probe_slug_is_filesystem_safe() -> None:
    assert probe_slug("B major", 138) == "b-major-138"
    assert probe_slug("F# minor", 140) == "f-sharp-minor-140"
    assert probe_slug("D major", None) == "d-major"


def test_probe_request_overrides_key_and_bpm_only() -> None:
    main_request = _request()  # pinned "B minor", no bpm
    probe = build_probe_request(main_request, keyscale="D major", bpm=138)
    assert probe["params"]["keyscale"] == "D major"
    assert probe["params"]["bpm"] == 138
    assert probe["seeds"] == [PROBE_SEED]
    assert probe["variant"] == "probe-d-major-138"
    assert probe["variantOf"] == main_request["requestSha256"]
    # Everything else inherits the lane config.
    assert probe["lyrics"] == main_request["lyrics"]
    assert probe["params"]["shift"] == main_request["params"]["shift"]
    assert probe["postProcess"] == main_request["postProcess"]


def test_probe_request_hashes_differ_per_key_and_bpm() -> None:
    main_request = _request()
    b_major = build_probe_request(main_request, keyscale="B major", bpm=138)
    d_major = build_probe_request(main_request, keyscale="D major", bpm=138)
    b_major_slow = build_probe_request(main_request, keyscale="B major", bpm=120)
    assert len({b_major["requestSha256"], d_major["requestSha256"], b_major_slow["requestSha256"]}) == 3
    assert build_probe_request(main_request, keyscale="B major", bpm=138)["requestSha256"] == b_major["requestSha256"]

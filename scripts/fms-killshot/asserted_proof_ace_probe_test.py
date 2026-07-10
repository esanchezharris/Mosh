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


def test_probe_slug_carries_param_overrides() -> None:
    assert probe_slug("B major", 138, overrides={"cover_noise_strength": 0.85}) == "b-major-138-cns85"
    assert probe_slug("B major", 138, overrides={"cover_noise_strength": 0.3}) == "b-major-138-cns30"
    assert probe_slug("B major", 138, overrides={"guidance_scale": 2.0}) == "b-major-138-guidance-scale-2-0"


def test_probe_request_param_overrides_are_hash_sensitive() -> None:
    main_request = _request()
    low = build_probe_request(main_request, keyscale="B major", bpm=138, param_overrides={"cover_noise_strength": 0.3})
    high = build_probe_request(main_request, keyscale="B major", bpm=138, param_overrides={"cover_noise_strength": 0.85})
    plain = build_probe_request(main_request, keyscale="B major", bpm=138)
    assert low["params"]["cover_noise_strength"] == 0.3
    assert high["params"]["cover_noise_strength"] == 0.85
    assert plain["params"]["cover_noise_strength"] == 0.0  # lane default untouched
    assert len({low["requestSha256"], high["requestSha256"], plain["requestSha256"]}) == 3
    assert low["variant"] == "probe-b-major-138-cns30"


def test_probe_request_can_pin_the_torch_dit_backend() -> None:
    # The MLX DiT silently ignores cover_noise_strength (zero occurrences in
    # acestep/models/mlx/) — strength probes must run the torch sampler and
    # record that honestly in the hash and slug.
    main_request = _request()
    torch_probe = build_probe_request(main_request, keyscale="B major", bpm=138, param_overrides={"cover_noise_strength": 0.5}, use_mlx_dit=False)
    mlx_probe = build_probe_request(main_request, keyscale="B major", bpm=138, param_overrides={"cover_noise_strength": 0.5})
    assert torch_probe["useMlxDit"] is False
    assert "useMlxDit" not in mlx_probe or mlx_probe.get("useMlxDit") is True
    assert torch_probe["requestSha256"] != mlx_probe["requestSha256"]
    assert torch_probe["variant"].endswith("-torch")


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

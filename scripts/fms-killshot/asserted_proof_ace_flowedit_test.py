from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_ace_cover import pinned_params  # noqa: E402
from asserted_proof_ace_flowedit import build_flow_edit_request, flow_edit_slug  # noqa: E402

SOURCE = "Yeah we used to fight like invincible But in the night we got hella close shit yeah"
TARGET = "[Verse]\nYeah we used to fight like invincible\nBut in the night we got hella close yeah"


def _main_request() -> dict:
    return {
        "version": 2,
        "params": pinned_params(src_audio_rel="asserted-proof/opening/ace-step-cover/source-padded-10s.wav", lyrics=TARGET),
        "requestSha256": "a" * 64,
    }


def _build(**overrides) -> dict:
    args = {"source_lyrics": SOURCE, "target_lyrics": TARGET, "keyscale": "B major", "bpm": 138, "n_min": 0.0, "n_max": 0.7}
    args.update(overrides)
    return build_flow_edit_request(_main_request(), **args)


def test_flow_edit_slug_is_deterministic_and_window_sensitive() -> None:
    a = flow_edit_slug("B major", 138, 0.0, 0.7)
    assert a == flow_edit_slug("B major", 138, 0.0, 0.7)
    assert a.startswith("flowedit-b-major-138")
    assert flow_edit_slug("B major", 138, 0.0, 0.7) != flow_edit_slug("B major", 138, 0.0, 0.5)
    assert flow_edit_slug("B major", 138, 0.3, 0.7) != flow_edit_slug("B major", 138, 0.0, 0.7)


def test_build_keeps_cover_task_and_enables_torch_morph() -> None:
    request = _build()
    # Flow-edit layers on the cover dispatch — the task type must NOT change.
    assert request["params"]["task_type"] == "cover"
    assert request["params"]["flow_edit_morph"] is True
    # The MLX DiT has no flow-edit implementation, so the torch sampler is mandatory.
    assert request["useMlxDit"] is False


def test_build_wires_source_and_target_branches() -> None:
    request = _build()
    params = request["params"]
    assert params["flow_edit_source_lyrics"] == SOURCE  # V_src condition (the take's words)
    assert params["lyrics"] == TARGET                    # V_tar condition (asserted words)
    # Identical captions isolate the edit to the lyric direction only.
    assert params["flow_edit_source_caption"] == params["caption"]
    assert params["flow_edit_n_min"] == 0.0 and params["flow_edit_n_max"] == 0.7


def test_build_overrides_key_bpm_and_pins_single_seed() -> None:
    request = _build(seed=4099)
    assert request["params"]["keyscale"] == "B major"
    assert request["params"]["bpm"] == 138
    assert request["seeds"] == [4099]


def test_build_hash_is_window_sensitive_and_records_provenance() -> None:
    base = _build(n_max=0.7)
    other = _build(n_max=0.5)
    assert base["requestSha256"] != other["requestSha256"]
    assert base["variantOf"] == "a" * 64
    assert base["variant"] == "probe-" + flow_edit_slug("B major", 138, 0.0, 0.7)
    # The recomputed hash must match a fresh computation over the request body.
    from asserted_proof_ace_cover import request_sha256

    assert base["requestSha256"] == request_sha256({k: v for k, v in base.items() if k != "requestSha256"})

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_ace_ab import (  # noqa: E402
    AB_SEED,
    ROUND1_RAW_TRANSCRIPT,
    build_ab_request,
    transcript_reproduction,
)
from asserted_proof_ace_cover_test import _request  # noqa: E402


def test_ab_request_is_round1_config_for_seed_4099_only() -> None:
    main_request = _request()  # pinned "B minor"
    ab_request = build_ab_request(main_request)
    assert ab_request["params"]["keyscale"] == ""  # round-1 config: no key hint
    assert ab_request["seeds"] == [AB_SEED] == [4099]
    assert ab_request["variantOf"] == main_request["requestSha256"]
    assert ab_request["variant"] == "round1-config"
    # Everything else inherits the current lane config verbatim.
    assert ab_request["lyrics"] == main_request["lyrics"]
    assert ab_request["params"]["src_audio"] == main_request["params"]["src_audio"]
    assert ab_request["params"]["shift"] == main_request["params"]["shift"]
    assert ab_request["postProcess"] == main_request["postProcess"]
    assert ab_request["checkpoint"] == main_request["checkpoint"]
    # And it hashes independently of the main request.
    assert ab_request["requestSha256"] != main_request["requestSha256"]


def test_ab_request_hash_is_stable() -> None:
    assert build_ab_request(_request())["requestSha256"] == build_ab_request(_request())["requestSha256"]


def test_transcript_reproduction_matches_the_round1_render() -> None:
    heard = ["Yeah,", "we", "used", "to", "fight", "like", "invincible", "But", "in", "the", "night", "we", "got", "hella", "close", "shit,", "yeah"]
    result = transcript_reproduction(heard)
    assert result["reproduced"] is True
    assert result["expected"] == list(ROUND1_RAW_TRANSCRIPT)
    drifted = transcript_reproduction(["yeah", "different", "words"])
    assert drifted["reproduced"] is False
    assert drifted["sequenceRatio"] < 0.5


def test_ab_verdict_binds_to_the_ab_manifest(tmp_path: Path) -> None:
    import hashlib

    from asserted_proof_verdict import save_ab_verdict, validate_ab_verdict

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"version": 1, "files": {}}))
    current = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    verdict = {"clip": "ace-cover-ab", "winner": "B", "notes": "round-1 words win", "createdAt": "2026-07-10T00:00:00Z", "manifestSha256": current}
    validate_ab_verdict(verdict, manifest_path)  # must not raise
    with pytest.raises(RuntimeError, match="winner"):
        validate_ab_verdict({**verdict, "winner": "C"}, manifest_path)
    with pytest.raises(RuntimeError, match="ace-cover-ab"):
        validate_ab_verdict({**verdict, "clip": "opening"}, manifest_path)
    with pytest.raises(RuntimeError, match="manifest"):
        validate_ab_verdict({**verdict, "manifestSha256": "0" * 64}, manifest_path)
    destination = tmp_path / "ab-verdict.json"
    save_ab_verdict(verdict, manifest_path, destination)
    assert json.loads(destination.read_text())["winner"] == "B"


def test_preview_server_routes_ab_verdict() -> None:
    from preview_server import is_ab_verdict_path

    assert is_ab_verdict_path("/used2/asserted-proof/api/verdict/ace-cover-ab") is True
    assert is_ab_verdict_path("/used2/asserted-proof/api/verdict/ace-cover-ab?x=1") is True
    assert is_ab_verdict_path("/used2/asserted-proof/api/verdict/ace-cover/42") is False
    assert is_ab_verdict_path("/used2/asserted-proof/api/verdict/opening") is False

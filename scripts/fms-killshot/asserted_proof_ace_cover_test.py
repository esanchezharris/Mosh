from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ace_cover_worker import validate_request  # noqa: E402
from asserted_proof_ace_cover import (  # noqa: E402
    GENERATED_SEEDS,
    OPENING_LYRICS,
    PINNED_SEEDS,
    build_ace_request,
    build_worker_request,
    candidate_summaries,
    declare_stop,
    plan_seed_work,
    regenerate_ace_manifest,
    request_sha256,
    seed_paths,
    validate_lyrics_against_plan,
    write_request_if_changed,
)
from asserted_proof_provenance import write_receipt  # noqa: E402


def _good_request(tmp_path: Path) -> dict:
    src = tmp_path / "source-padded-10s.wav"
    src.write_bytes(b"RIFF")
    return {
        "version": 1,
        "aceRoot": str(tmp_path),
        "expectedGitRev": "6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0",
        "configPath": "acestep-v15-turbo",
        "device": "auto",
        "saveDir": str(tmp_path / "worker-out"),
        "audioFormat": "wav",
        "seeds": [7, 73],
        "params": {
            "task_type": "cover",
            "instruction": "Generate audio semantic tokens based on the given conditions:",
            "src_audio": str(src),
            "reference_audio": None,
            "lyrics": "[Verse]\nYeah we used to fight like invincible\nBut in the night we got hella close yeah",
            "vocal_language": "en",
            "inference_steps": 8,
            "shift": 3.0,
            "guidance_scale": 1.0,
            "audio_cover_strength": 1.0,
            "cover_noise_strength": 0.0,
            "duration": -1.0,
            "thinking": False,
        },
    }


def test_worker_accepts_a_complete_cover_request(tmp_path: Path) -> None:
    assert validate_request(_good_request(tmp_path)) == []


def test_worker_rejects_missing_top_level_keys(tmp_path: Path) -> None:
    request = _good_request(tmp_path)
    del request["expectedGitRev"]
    del request["seeds"]
    problems = validate_request(request)
    assert any("expectedGitRev" in problem for problem in problems)
    assert any("seeds" in problem for problem in problems)


def test_worker_rejects_non_cover_task(tmp_path: Path) -> None:
    request = _good_request(tmp_path)
    request["params"]["task_type"] = "text2music"
    assert any("task_type" in problem for problem in validate_request(request))


def test_worker_rejects_reference_audio_voice_identity(tmp_path: Path) -> None:
    request = _good_request(tmp_path)
    request["params"]["reference_audio"] = str(tmp_path / "voice.wav")
    assert any("reference_audio" in problem for problem in validate_request(request))


def test_worker_rejects_missing_source_audio(tmp_path: Path) -> None:
    request = _good_request(tmp_path)
    request["params"]["src_audio"] = str(tmp_path / "missing.wav")
    assert any("src_audio" in problem for problem in validate_request(request))


def test_worker_rejects_bad_seed_lists(tmp_path: Path) -> None:
    request = _good_request(tmp_path)
    request["seeds"] = []
    assert any("seeds" in problem for problem in validate_request(request))
    request["seeds"] = [7, "42"]
    assert any("seeds" in problem for problem in validate_request(request))


# --- orchestration -----------------------------------------------------------

OPENING_WORDS = ["Yeah", "we", "used", "to", "fight", "like", "invincible", "But", "in", "the", "night", "we", "got", "hella", "close", "Yeah"]


def _render_plan() -> dict:
    words = [
        {"text": text, "normalized": text.lower(), "ownerId": f"src-{index}-0", "start": 0.4 + 0.45 * index, "end": 0.5 + 0.45 * index}
        for index, text in enumerate(OPENING_WORDS)
    ]
    return {"clip": {"start": 0.35, "end": 7.90}, "words": words}


def _source_hashes() -> dict:
    return {
        "rawSlice": {"path": "asserted-proof/opening/raw.wav", "bytes": 10, "sha256": "a" * 64},
        "renderPlan": {"path": "asserted-proof/opening/asserted-render-plan.json", "bytes": 20, "sha256": "b" * 64},
        "paddedSource": {"path": "asserted-proof/opening/ace-step-cover/source-padded-10s.wav", "bytes": 30, "sha256": "c" * 64},
    }


def _request() -> dict:
    return build_ace_request(
        plan=_render_plan(),
        lyrics_text=OPENING_LYRICS,
        source_hashes=_source_hashes(),
        ace_git_rev="6d467e4b5081ccb0abf1ec1bf4fdf9051a2d34b0",
        checkpoint={"name": "acestep-v15-turbo", "model": {"bytes": 1, "sha256": "d" * 64}, "config": {"bytes": 2, "sha256": "e" * 64}, "vae": {"bytes": 3, "sha256": "f" * 64}},
        seeds=list(PINNED_SEEDS),
        keyscale="B minor",
    )


def test_pinned_seed_registry_shape() -> None:
    assert PINNED_SEEDS == (7, 42, 73, 271, 509, 911, 2027, 4099)
    assert GENERATED_SEEDS == (7, 73, 271, 509, 911, 2027, 4099)  # 42 is imported, never regenerated


def test_request_hash_is_stable_and_param_sensitive() -> None:
    first, second = _request(), _request()
    assert request_sha256(first) == request_sha256(second)
    shifted = _request()
    shifted["params"]["shift"] = 1.0
    assert request_sha256(shifted) != request_sha256(first)
    reseeded = _request()
    reseeded["seeds"] = [7]
    assert request_sha256(reseeded) != request_sha256(first)
    relyriced = _request()
    relyriced["lyrics"] = relyriced["lyrics"].replace("hella", "really")
    assert request_sha256(relyriced) != request_sha256(first)
    rekeyed = _request()
    rekeyed["params"]["keyscale"] = "F# minor"
    assert request_sha256(rekeyed) != request_sha256(first)
    regated = _request()
    regated["postProcess"]["silenceEnforcement"]["prePadS"] = 0.2
    assert request_sha256(regated) != request_sha256(first)
    # Volatile fields never affect the hash.
    stamped = _request()
    stamped["createdAt"], stamped["updatedAt"], stamped["requestSha256"] = "2026-07-09T00:00:00Z", "2026-07-10T00:00:00Z", "x" * 64
    assert request_sha256(stamped) == request_sha256(first)


def test_request_records_root_relative_paths_only() -> None:
    serialized = json.dumps(_request())
    assert "/Users/" not in serialized
    assert _request()["params"]["src_audio"] == "asserted-proof/opening/ace-step-cover/source-padded-10s.wav"


def test_request_pins_the_verified_cover_params() -> None:
    params = _request()["params"]
    assert params["task_type"] == "cover"
    assert params["instruction"] == "Generate audio semantic tokens based on the given conditions:"
    assert params["reference_audio"] is None
    assert params["shift"] == 3.0
    assert params["inference_steps"] == 8
    assert params["guidance_scale"] == 1.0
    assert params["audio_cover_strength"] == 1.0
    assert params["cover_noise_strength"] == 0.0
    assert params["thinking"] is False
    assert params["vocal_language"] == "en"
    assert params["keyscale"] == "B minor"
    enforcement = _request()["postProcess"]["silenceEnforcement"]
    assert enforcement["source"] == "plan-word-spans"
    assert enforcement["prePadS"] == 0.06
    assert enforcement["postPadS"] == 0.12
    assert enforcement["fadeS"] == 0.01


def test_worker_request_absolutizes_src_audio(tmp_path: Path) -> None:
    request = _request()
    worker_request = build_worker_request(request, root=tmp_path, seeds=[7, 73], save_dir=tmp_path / "worker-out")
    assert worker_request["params"]["src_audio"] == str(tmp_path / "asserted-proof/opening/ace-step-cover/source-padded-10s.wav")
    assert worker_request["seeds"] == [7, 73]
    assert worker_request["expectedGitRev"] == request["aceRuntime"]["gitRev"]
    # Everything else in params is untouched.
    assert worker_request["params"]["shift"] == request["params"]["shift"]


def test_lyrics_gate_requires_exact_asserted_words() -> None:
    plan = _render_plan()
    validate_lyrics_against_plan(OPENING_LYRICS, plan)  # must not raise; [Verse] and case ignored
    with pytest.raises(RuntimeError, match="lyrics"):
        validate_lyrics_against_plan(OPENING_LYRICS.replace("hella", "really"), plan)
    with pytest.raises(RuntimeError, match="lyrics"):
        validate_lyrics_against_plan(OPENING_LYRICS + " extra", plan)


def test_write_request_if_changed_is_byte_stable(tmp_path: Path) -> None:
    target = tmp_path / "request.json"
    first, changed = write_request_if_changed(target, _request(), now_iso="2026-07-09T21:00:00Z")
    assert changed is True
    original_bytes = target.read_bytes()
    second, changed = write_request_if_changed(target, _request(), now_iso="2026-07-10T09:00:00Z")
    assert changed is False
    assert target.read_bytes() == original_bytes  # untouched => receipts stay current
    assert second["createdAt"] == first["createdAt"]
    modified = _request()
    modified["seeds"] = [7]
    third, changed = write_request_if_changed(target, modified, now_iso="2026-07-10T10:00:00Z")
    assert changed is True
    assert third["createdAt"] == first["createdAt"]  # creation time preserved
    assert third["updatedAt"] == "2026-07-10T10:00:00Z"


def _seed_lane(ace_dir: Path, seed: int, request_path: Path, raw_slice: Path, raw_f0: Path, *, imported: bool = False) -> None:
    files = seed_paths(ace_dir, seed)
    lane = {
        "request": request_path,
        "rawSlice": raw_slice,
        "rawClipF0": raw_f0,
        "output": files["opening"],
        "rawTrim": files["rawTrim"],
        "asr": files["asr"],
        "align": files["align"],
        "renderedF0": files["f0"],
        "eval": files["eval"],
    }
    for key in ("opening", "rawTrim", "asr", "align", "f0", "eval"):
        files[key].write_text(f"seed-{seed}-{key}")
    if imported:
        imported_source = ace_dir / "imported-seed-42-source.wav"
        imported_source.write_text("legacy")
        lane["importedSource"] = imported_source
    else:
        files["full"].write_text(f"seed-{seed}-full")
        lane["full"] = files["full"]
        lane["paddedSource"] = ace_dir / "source-padded-10s.wav"
    write_receipt(files["receipt"], lane)


def _spike_dirs(tmp_path: Path) -> tuple[Path, Path, Path]:
    root = tmp_path / "used2"
    opening = root / "asserted-proof/opening"
    ace_dir = opening / "ace-step-cover"
    ace_dir.mkdir(parents=True)
    (opening / "raw.wav").write_text("raw")
    (opening / "asserted-render-plan.json").write_text(json.dumps(_render_plan()))
    (ace_dir / "request.json").write_text(json.dumps(_request()))
    (ace_dir / "lyrics.txt").write_text(OPENING_LYRICS)
    (ace_dir / "source-padded-10s.wav").write_text("padded")
    (ace_dir / "raw-clip-f0.json").write_text("[]")
    return root, opening, ace_dir


def test_seed_work_skips_current_and_regenerates_stale(tmp_path: Path) -> None:
    root, opening, ace_dir = _spike_dirs(tmp_path)
    current_hash = request_sha256(_request())
    _seed_lane(ace_dir, 7, ace_dir / "request.json", opening / "raw.wav", ace_dir / "raw-clip-f0.json")
    ledger = {"requestSha256": current_hash, "candidates": [{"seed": 7, "provenance": "pinned-config", "requestSha256": current_hash}]}
    work = plan_seed_work(ledger, current_hash, ace_dir)
    assert 7 not in work
    assert work == [seed for seed in GENERATED_SEEDS if seed != 7]

    # A mutated artifact byte regenerates the seed.
    seed_paths(ace_dir, 7)["opening"].write_text("tampered")
    assert 7 in plan_seed_work(ledger, current_hash, ace_dir)

    # A stale ledger request hash regenerates even with a current receipt.
    _seed_lane(ace_dir, 7, ace_dir / "request.json", opening / "raw.wav", ace_dir / "raw-clip-f0.json")
    stale_ledger = {"requestSha256": current_hash, "candidates": [{"seed": 7, "provenance": "pinned-config", "requestSha256": "0" * 64}]}
    assert 7 in plan_seed_work(stale_ledger, current_hash, ace_dir)


def test_ace_manifest_does_not_rebless_audio_from_a_changed_request(tmp_path: Path) -> None:
    root, opening, ace_dir = _spike_dirs(tmp_path)
    _seed_lane(ace_dir, 7, ace_dir / "request.json", opening / "raw.wav", ace_dir / "raw-clip-f0.json")
    manifest = regenerate_ace_manifest(ace_dir, opening, path_root=root)
    assert "seed7Opening" in manifest["files"]
    assert "seed7Eval" in manifest["files"]
    assert "ledger" not in manifest["files"]  # mutable files stay out (no hash circularity)
    assert all("/Users/" not in entry["path"] for entry in manifest["files"].values())

    (ace_dir / "request.json").write_text(json.dumps({"changed": True}))
    manifest = regenerate_ace_manifest(ace_dir, opening, path_root=root)
    assert "seed7Opening" not in manifest["files"]  # stale receipt drops the lane


def _evaluation(candidate_id: str, *, misses: int = 0, status: str = "shortlisted") -> dict:
    return {
        "version": 1,
        "candidateId": candidate_id,
        "lane": "ace-step-cover",
        "durationS": 7.55,
        "lexical": {"hits": 16 - misses, "nearMisses": 0, "substitutions": 0, "misses": misses, "insertions": 0, "lexicalScore": (16 - misses) / 16, "sequenceRatio": (16 - misses) / 16, "perWord": []},
        "attack": {"usableWords": 16, "totalWords": 16, "medianAttackErrorMs": 30.0, "p95AttackErrorMs": 60.0, "words": []},
        "contour": {"voicedOverlap": 0.9, "voicedRatioCand": 0.8, "contourCorrelation": 0.9, "registerOffsetSemitones": 0.2, "medianAbsPitchErrorSemitones": 0.5, "p95AbsPitchErrorSemitones": 1.0, "medianAbsPitchErrorAfterOffsetSemitones": 0.3, "longestOctaveErrorMs": 0.0, "voicedIntersectionFrames": 300, "frames": 378, "hopS": 0.02},
        "audioMetrics": {"envelopeCorrelation": 0.7, "rmsRatio": 1.0, "silenceBleedMs": 30.0},
        "gates": {},
        "shortlistFailures": [] if status == "shortlisted" else ["medianAttack"],
        "invalidReasons": [] if status != "invalid" else ["duration 10.0 outside 7.55±0.25s"],
        "autoStatus": status,
    }


def test_candidate_summaries_rank_and_overlay_verdicts() -> None:
    current = "c" * 64
    evaluations = [
        _evaluation("seed-73", misses=2, status="diagnostic"),
        _evaluation("seed-7"),
        _evaluation("seed-271", status="invalid"),
    ]
    verdicts = {
        "seed-7": {"clip": "ace-cover", "seed": 7, "verdict": "fail", "classification": "timing", "manifestSha256": current},
        "seed-73": {"clip": "ace-cover", "seed": 73, "verdict": "pass", "classification": "", "manifestSha256": "0" * 64},  # stale: ignored
    }
    summaries = candidate_summaries(evaluations, verdicts, current)
    assert [entry["candidateId"] for entry in summaries] == ["seed-7", "seed-73", "seed-271"]
    assert summaries[0]["rank"] == 1
    assert summaries[0]["status"] == "owner_fail"
    assert summaries[1]["status"] == "diagnostic"  # stale pass ignored
    assert summaries[2]["rank"] is None
    assert summaries[2]["status"] == "invalid"


def _stop_fixture(tmp_path: Path, verdicts: list[dict], *, lexical_floor: bool = True) -> Path:
    root, opening, ace_dir = _spike_dirs(tmp_path)
    manifest = regenerate_ace_manifest(ace_dir, opening, path_root=root)
    import hashlib

    manifest_hash = hashlib.sha256((ace_dir / "manifest.json").read_bytes()).hexdigest()
    candidates = []
    verdict_dir = ace_dir / "verdicts"
    verdict_dir.mkdir()
    for verdict in verdicts:
        seed = verdict["seed"]
        verdict = {**verdict, "clip": "ace-cover", "manifestSha256": manifest_hash, "createdAt": "2026-07-10T00:00:00Z", "notes": ""}
        (verdict_dir / f"seed-{seed}-verdict.json").write_text(json.dumps(verdict))
        candidates.append(
            {
                "seed": seed,
                "candidateId": f"seed-{seed}",
                "status": "diagnostic",
                "gates": {"lexicalFloor": lexical_floor},
                "verdict": verdict,
            }
        )
    (ace_dir / "ledger.json").write_text(json.dumps({"version": 1, "requestSha256": request_sha256(_request()), "candidates": candidates, "legacy": {}}))
    return ace_dir


def test_declare_stop_lexical_requires_all_word_failures(tmp_path: Path) -> None:
    ace_dir = _stop_fixture(tmp_path, [{"seed": 7, "verdict": "fail", "classification": "words"}, {"seed": 73, "verdict": "fail", "classification": "words"}])
    status_path = declare_stop(ace_dir, "lexical", "none intelligible by owner ear")
    payload = json.loads(status_path.read_text())
    assert payload["status"] == "ace_cover_lexical_blocked"
    assert payload["manifestSha256"]


def test_declare_stop_lexical_rejects_without_verdicts(tmp_path: Path) -> None:
    ace_dir = _stop_fixture(tmp_path, [])
    with pytest.raises(RuntimeError, match="verdict"):
        declare_stop(ace_dir, "lexical", "no evidence yet")


def test_declare_stop_lexical_rejects_when_a_pass_exists(tmp_path: Path) -> None:
    ace_dir = _stop_fixture(tmp_path, [{"seed": 7, "verdict": "pass", "classification": ""}])
    with pytest.raises(RuntimeError, match="pass"):
        declare_stop(ace_dir, "lexical", "should not stop")


def test_ace_cover_verdict_binds_to_manifest_and_seed(tmp_path: Path) -> None:
    import hashlib

    from asserted_proof_verdict import save_ace_cover_verdict, validate_ace_cover_verdict

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"version": 1, "files": {}}))
    current = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    verdict = {"clip": "ace-cover", "seed": 73, "verdict": "fail", "classification": "words", "notes": "mushy", "createdAt": "2026-07-10T00:00:00Z", "manifestSha256": current}
    validate_ace_cover_verdict(verdict, manifest_path, 73)  # must not raise

    with pytest.raises(RuntimeError, match="manifest"):
        validate_ace_cover_verdict({**verdict, "manifestSha256": "0" * 64}, manifest_path, 73)
    with pytest.raises(RuntimeError, match="seed"):
        validate_ace_cover_verdict(verdict, manifest_path, 7)
    with pytest.raises(RuntimeError, match="ace-cover"):
        validate_ace_cover_verdict({**verdict, "clip": "opening"}, manifest_path, 73)
    with pytest.raises(RuntimeError, match="verdict"):
        validate_ace_cover_verdict({**verdict, "verdict": "meh"}, manifest_path, 73)

    destination = tmp_path / "verdicts/seed-73-verdict.json"
    saved = save_ace_cover_verdict(verdict, manifest_path, 73, destination)
    assert saved == verdict
    assert json.loads(destination.read_text()) == verdict
    # A stale save is rejected and does not clobber the good verdict.
    manifest_path.write_text(json.dumps({"version": 2, "files": {}}))
    with pytest.raises(RuntimeError, match="manifest"):
        save_ace_cover_verdict(verdict, manifest_path, 73, destination)
    assert json.loads(destination.read_text()) == verdict


def test_stale_candidate_verdicts_are_filtered(tmp_path: Path) -> None:
    from asserted_proof_ace_cover import load_current_candidate_verdicts

    ace_dir = tmp_path
    verdict_dir = ace_dir / "verdicts"
    verdict_dir.mkdir()
    (verdict_dir / "seed-7-verdict.json").write_text(json.dumps({"seed": 7, "verdict": "pass", "manifestSha256": "a" * 64}))
    (verdict_dir / "seed-73-verdict.json").write_text(json.dumps({"seed": 73, "verdict": "fail", "manifestSha256": "b" * 64}))
    verdicts = load_current_candidate_verdicts(ace_dir, "a" * 64)
    assert set(verdicts) == {"seed-7"}


def test_preview_server_routes_ace_cover_verdicts() -> None:
    from preview_server import ace_verdict_seed

    assert ace_verdict_seed("/used2/asserted-proof/api/verdict/ace-cover/73") == 73
    assert ace_verdict_seed("/used2/asserted-proof/api/verdict/ace-cover/73?x=1") == 73
    assert ace_verdict_seed("/used2/asserted-proof/api/verdict/opening") is None
    assert ace_verdict_seed("/used2/asserted-proof/api/verdict/ace-cover/") is None
    assert ace_verdict_seed("/used2/asserted-proof/api/verdict/ace-cover/not-a-seed") is None


def test_page_section_is_empty_before_the_spike_runs(tmp_path: Path) -> None:
    from asserted_proof_page import _ace_cover_section

    root, opening, ace_dir = _spike_dirs(tmp_path)
    (ace_dir / "ledger.json").unlink(missing_ok=True)
    assert _ace_cover_section(root / "asserted-proof") == ""


def test_page_section_renders_top_ranked_current_candidates(tmp_path: Path) -> None:
    from asserted_proof_ace_cover import regenerate_ace_manifest as regen
    from asserted_proof_page import _ace_cover_section

    root, opening, ace_dir = _spike_dirs(tmp_path)
    _seed_lane(ace_dir, 7, ace_dir / "request.json", opening / "raw.wav", ace_dir / "raw-clip-f0.json")
    # Give seed 7 a real eval payload so the card can show lexical chips.
    evaluation = _evaluation("seed-7")
    evaluation["seed"] = 7
    evaluation["lexical"]["perWord"] = [{"index": 0, "text": "yeah", "cls": "hit", "heard": "yeah", "similarity": 1.0, "mismatchKind": None}]
    seed_paths(ace_dir, 7)["eval"].write_text(json.dumps(evaluation))
    (ace_dir / f"seed-7-asr.json").write_text(json.dumps({"ok": True, "words": [{"word": "yeah"}]}))
    # Receipt was written before the eval/asr contents changed — refresh it.
    files = seed_paths(ace_dir, 7)
    write_receipt(files["receipt"], {
        "request": ace_dir / "request.json", "rawSlice": opening / "raw.wav", "rawClipF0": ace_dir / "raw-clip-f0.json",
        "output": files["opening"], "rawTrim": files["rawTrim"], "asr": files["asr"], "align": files["align"], "renderedF0": files["f0"], "eval": files["eval"],
        "full": files["full"], "paddedSource": ace_dir / "source-padded-10s.wav",
    })
    manifest = regen(ace_dir, opening, path_root=root)
    import hashlib

    manifest_hash = hashlib.sha256((ace_dir / "manifest.json").read_bytes()).hexdigest()
    ledger = {
        "version": 1,
        "requestSha256": request_sha256(_request()),
        "manifestSha256": manifest_hash,
        "candidates": [
            {"candidateId": "seed-7", "seed": 7, "rank": 1, "status": "shortlisted", "autoStatus": "shortlisted", "gates": {}, "shortlistFailures": [], "invalidReasons": [],
             "lexical": {"hits": 16, "nearMisses": 0, "substitutions": 0, "misses": 0}, "metrics": {"medianAttackErrorMs": 30.0, "silenceBleedMs": 20.0, "medianAbsPitchErrorSemitones": 0.5, "registerOffsetSemitones": 0.1, "voicedOverlap": 0.9, "contourCorrelation": 0.9, "longestOctaveErrorMs": 0.0, "p95AttackErrorMs": 50.0, "envelopeCorrelation": 0.8}, "verdict": None},
            {"candidateId": "seed-271", "seed": 271, "rank": None, "status": "invalid", "autoStatus": "invalid", "gates": {}, "shortlistFailures": [], "invalidReasons": ["generation failed: boom"], "lexical": {}, "metrics": {}, "verdict": None},
        ],
        "legacy": {},
    }
    (ace_dir / "ledger.json").write_text(json.dumps(ledger))
    section = _ace_cover_section(root / "asserted-proof")
    assert "Local model spike" in section or "Local Model Spike" in section
    assert "seed-7-opening.wav" in section  # playable candidate
    assert "seed 7" in section.lower()
    assert "/api/verdict/ace-cover/7" in section
    assert manifest_hash in section  # verdict binding embeds the spike manifest hash
    assert "seed-271" not in section  # invalid candidates get no card
    assert "yeah" in section  # lexical chip content


def test_declare_stop_prosody_requires_lexical_floor_met(tmp_path: Path) -> None:
    ace_dir = _stop_fixture(tmp_path, [{"seed": 7, "verdict": "fail", "classification": "timing"}], lexical_floor=False)
    with pytest.raises(RuntimeError, match="lexical"):
        declare_stop(ace_dir, "prosody", "timing failed but words never passed")
    ace_dir = _stop_fixture(tmp_path / "ok", [{"seed": 7, "verdict": "fail", "classification": "timing"}], lexical_floor=True)
    payload = json.loads(declare_stop(ace_dir, "prosody", "words fine, contour not").read_text())
    assert payload["status"] == "ace_cover_prosody_blocked"

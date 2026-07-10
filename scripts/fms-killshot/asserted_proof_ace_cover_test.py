from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ace_cover_worker import validate_request  # noqa: E402


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

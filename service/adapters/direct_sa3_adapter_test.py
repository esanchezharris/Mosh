"""Adapter boundary fixtures; no MLX import, weights, inference or musical evidence.

Run: python3 -m pytest -q service/adapters/direct_sa3_adapter_test.py
"""
from __future__ import annotations

import shutil
import sys
import wave
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters import stable_audio3_adapter as adapter  # noqa: E402
from sa3 import engine, init_cache, qa  # noqa: E402


class FixtureEngine:
    """Boundary fixture writes the source verbatim; it never calls a model."""
    SECONDS = 4.0
    STEPS = 8

    def __init__(self, source: Path) -> None:
        self.source = source

    def apply_loras(self, selection: list, key: str) -> None:
        assert not selection

    def set_seconds(self, seconds: float) -> float:
        self.SECONDS = seconds
        return seconds

    def reimagine(self, prompt: str, seed: int, init_lat, init_noise_level: float,
                  steers: list, out_wav: str) -> None:
        shutil.copyfile(self.source, out_wav)


@pytest.mark.parametrize("explicit", [True, False])
def test_direct_requests_skip_judging_while_legacy_requests_retain_it(tmp_path: Path,
                                                                   monkeypatch: pytest.MonkeyPatch,
                                                                   explicit: bool) -> None:
    # Given a deterministic engine boundary and a recording judge boundary.
    source, output = tmp_path / "source.wav", tmp_path / "fixture.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setparams((2, 2, 8000, 32000, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00\x02\x00" * 32000)
    monkeypatch.setattr(engine, "engine_available", lambda: True)
    monkeypatch.setattr(engine, "get_engine", lambda: FixtureEngine(source))
    monkeypatch.setattr(init_cache, "get_or_encode", lambda *_: (None, "fixture"))
    judged: list[str] = []
    monkeypatch.setattr(qa, "augment_manifest", lambda manifest, output_wav, **_: judged.append(output_wav))
    monkeypatch.setenv("MOSH_LORA_DIR", str(tmp_path / "empty-lora-fixture"))
    params = {"seed": 0, "nl": 0.4, "prompt": "fixture", "duration_s": 4,
              "lab": False, "colors": [], "loras": []}
    if explicit:
        params.update(decision_policy="explicit", request_id="fixture-request-1", source_sha256="a" * 64)
    # When the actual adapter runs against those boundaries.
    result = adapter.render(str(source), str(output), params)
    # Then explicit requests avoid evaluation, legacy behavior survives, and raw audio survives.
    assert bool(judged) is not explicit
    assert output.read_bytes() == source.read_bytes()
    if explicit:
        assert result["backend"] == "mlx" and result["model_variant"] == "sa3-medium"
        assert result["request_id"] == "fixture-request-1"
        assert result["source_sha256"] == "a" * 64
        assert result["settings"]["steps"] == 8
        assert result["settings"]["nl"] == 0.4
        assert result["evaluation"] == "disabled"


@pytest.mark.parametrize("duration", [0.5, 500.0, 3.0])
def test_unsupported_or_mismatched_length_fails_before_loading_model(tmp_path: Path,
                                                                  monkeypatch: pytest.MonkeyPatch,
                                                                  duration: float) -> None:
    # Given a four-second source with a request requiring clamping or a changed span.
    source = tmp_path / "source.wav"
    with wave.open(str(source), "wb") as audio:
        audio.setparams((2, 2, 8000, 32000, "NONE", "not compressed"))
        audio.writeframes(b"\x01\x00\x02\x00" * 32000)
    monkeypatch.setattr(engine, "engine_available", lambda: True)
    loaded: list[bool] = []
    monkeypatch.setattr(engine, "get_engine", lambda: loaded.append(True))
    # When the direct adapter sees that unsupported request.
    with pytest.raises(ValueError):
        adapter.render(str(source), str(tmp_path / "out.wav"),
                       {"decision_policy": "explicit", "nl": 0.4, "duration_s": duration})
    # Then it cannot load a model, stitch or silently change the requested source span.
    assert not loaded

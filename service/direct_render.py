"""Validation and provenance for the explicit audio-clip render contract."""
from __future__ import annotations

import hashlib
import math
import os
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import TypeAlias

Json: TypeAlias = str | int | float | bool | None | list["Json"] | dict[str, "Json"]
JsonMap: TypeAlias = dict[str, Json]


class DirectRenderError(ValueError):
    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


def fixture_enabled(adapter: str) -> bool:
    return adapter == "fake" and os.environ.get("MOSH_DIRECT_RENDER_TEST_FIXTURE") == "1"


@dataclass(frozen=True, slots=True)
class DirectRequest:
    request_id: str
    source_sha256: str
    input_wav: str
    output_wav: str
    manifest_path: str
    fixture: bool

    @classmethod
    def parse(cls, data: JsonMap) -> DirectRequest | None:
        params = data.get("params", {})
        if not isinstance(params, dict):
            raise DirectRenderError("params must be an object")
        if params.get("decision_policy") != "explicit":
            return None
        adapter = data.get("adapter", "fake")
        fixture = isinstance(adapter, str) and fixture_enabled(adapter)
        if adapter != "stable_audio3" and not fixture:
            raise DirectRenderError("direct Re-Imagine requires stable_audio3")
        request_id, source_sha = params.get("request_id"), params.get("source_sha256")
        if not isinstance(request_id, str) or not request_id.strip():
            raise DirectRenderError("request_id must identify the frozen direct request")
        if (not isinstance(source_sha, str) or len(source_sha) != 64
                or any(char not in "0123456789abcdef" for char in source_sha)):
            raise DirectRenderError("source_sha256 must be the staged source SHA-256")
        if not isinstance(params.get("prompt"), str):
            raise DirectRenderError("prompt must be text")
        if type(params.get("seed")) is not int:
            raise DirectRenderError("seed must be an integer")
        nl, duration = params.get("nl"), params.get("duration_s")
        if type(nl) not in (int, float) or not math.isfinite(nl) or not 0.01 <= nl <= 0.5:
            raise DirectRenderError("generation strength must be within 0.01–0.5")
        if type(duration) not in (int, float) or not math.isfinite(duration) or duration <= 0:
            raise DirectRenderError("duration_s must be a finite positive length")
        if params.get("lab", False) is not False:
            raise DirectRenderError("direct Re-Imagine uses normal mode")
        if params.get("mode", "reimagine") != "reimagine" or params.get("coverage", "single") not in ("single", "auto", "stitch"):
            raise DirectRenderError("direct Re-Imagine requires one non-looping source clip")
        if not isinstance(params.get("colors", []), list) or not isinstance(params.get("loras", []), list):
            raise DirectRenderError("colors and loras must be selections")
        source, output = data.get("inputWav"), data.get("outputWav")
        if not isinstance(source, str) or not source or not Path(source).is_file():
            raise DirectRenderError("inputWav must be a readable staged source")
        if not isinstance(output, str) or not output:
            raise DirectRenderError("outputWav is required")
        manifest = data.get("manifest", output + ".manifest.json")
        if not isinstance(manifest, str) or not manifest:
            raise DirectRenderError("manifest path is required")
        if len({Path(path).resolve() for path in (source, output, manifest)}) != 3:
            raise DirectRenderError("source, output and manifest must use distinct paths")
        if Path(output).exists() or Path(manifest).exists():
            raise DirectRenderError("direct render requires fresh artifact paths")
        return cls(request_id, source_sha, source, output, manifest, fixture)

    def verify_source(self) -> None:
        digest = hashlib.sha256()
        with Path(self.input_wav).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != self.source_sha256:
            raise DirectRenderError("staged source changed after direct request was frozen")
        if Path(self.output_wav).exists() or Path(self.manifest_path).exists():
            raise DirectRenderError("direct render artifact path is already occupied")

    def complete(self, manifest: JsonMap) -> None:
        expected_adapter = "fake" if self.fixture else "stable_audio3"
        if manifest.get("ok") is not True or manifest.get("adapter") != expected_adapter:
            raise DirectRenderError("adapter returned an invalid direct render manifest")
        if self.fixture:
            manifest.update(backend="fixture", model_variant="fixture", test_fixture=True)
        elif manifest.get("backend") != "mlx" or manifest.get("model_variant") != "sa3-medium":
            raise DirectRenderError("direct Re-Imagine requires an MLX SA3 Medium result")
        with wave.open(self.output_wav, "rb") as audio:
            if audio.getnframes() <= 0 or audio.getframerate() <= 0:
                raise DirectRenderError("adapter returned empty audio")
            expected = audio.getnframes() * audio.getnchannels() * audio.getsampwidth()
            received = 0
            while chunk := audio.readframes(4096):
                received += len(chunk)
            if received != expected:
                raise DirectRenderError("adapter returned truncated audio")
        manifest.update(request_id=self.request_id, source_sha256=self.source_sha256,
                        decision_policy="explicit", evaluation="disabled")

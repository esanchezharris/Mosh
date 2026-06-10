"""Extraction ingest (phase0 §7.1): acquisition → transcript (+ keyframes).

Operating rules (spec §12): API-compliant acquisition where possible; source
media retained LOCALLY for processing only — never redistributed, never in
the corpus; provenance fields mandatory on every trajectory.

Real path (all optional, degrade with a clear message):
  yt-dlp        — acquisition (audio only is enough for ASR)
  mlx-whisper   — ASR with word timestamps, local on Apple Silicon
  ffmpeg        — keyframe stills on UI-change (scene filter)

Fixture path (deterministic, what the smoke gate uses):
  ingest(fixture=<dir>) reads transcript.json + claims.json from the fixture
  directory — the rest of the pipeline cannot tell the difference.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import time
from pathlib import Path


def ingest(url: str | None = None, media: Path | None = None,
           fixture: Path | None = None, workdir: Path | None = None) -> dict:
    """Returns {transcript: [{start, end, text}], provenance: {...},
    frames_dir?: path, claims_path?: path}."""
    provenance = {
        "tutorial_url": url,
        "accessed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "acquisition": "fixture" if fixture else ("api" if url else "manual"),
        "license_notes": "no source media stored; samples from owned/licensed/generated",
    }

    if fixture is not None:
        transcript = json.loads((fixture / "transcript.json").read_text())
        out = {"transcript": transcript, "provenance": provenance}
        if (fixture / "claims.json").is_file():
            out["claims_path"] = fixture / "claims.json"
        if (fixture / "meta.json").is_file():
            provenance.update(json.loads((fixture / "meta.json").read_text()))
        return out

    workdir = workdir or Path("extract-work")
    workdir.mkdir(parents=True, exist_ok=True)

    if media is None:
        if url is None:
            raise SystemExit("ingest needs a url, a media file, or a fixture")
        if shutil.which("yt-dlp") is None:
            raise SystemExit("yt-dlp not installed (brew install yt-dlp) — or pass --media")
        media = workdir / "source.m4a"
        subprocess.run(["yt-dlp", "-x", "--audio-format", "m4a",
                        "-o", str(media), url], check=True)

    transcript = _whisper(media, workdir)
    return {"transcript": transcript, "provenance": provenance}


def _whisper(media: Path, workdir: Path) -> list[dict]:
    try:
        import mlx_whisper  # type: ignore
    except ModuleNotFoundError:
        raise SystemExit(
            "mlx-whisper not installed (pip install mlx-whisper) — ASR runs "
            "locally on Apple Silicon; or use --fixture for testing") from None
    result = mlx_whisper.transcribe(str(media), word_timestamps=True)
    out = [{"start": s["start"], "end": s["end"], "text": s["text"].strip()}
           for s in result["segments"]]
    (workdir / "transcript.json").write_text(json.dumps(out, indent=1))
    return out

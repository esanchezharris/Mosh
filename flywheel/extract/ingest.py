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
import os
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
        media = workdir / "source.mp4"
        if not media.exists():    # downloads cache across reruns of one tutorial
            subprocess.run(["yt-dlp", "-f", "bv*[height<=720]+ba/b[height<=720]/b",
                            "--merge-output-format", "mp4",
                            "-o", str(media), url], check=True)

    transcript = _whisper(media, workdir)
    out = {"transcript": transcript, "provenance": provenance, "media": media}
    frames = _keyframes(media, workdir)
    if frames:
        out["frames_dir"] = workdir / "frames"
        out["frame_index"] = frames
    return out


def _whisper(media: Path, workdir: Path) -> list[dict]:
    cache = workdir / "transcript.json"
    if cache.is_file():
        return json.loads(cache.read_text())
    try:
        import mlx_whisper  # type: ignore
    except ModuleNotFoundError:
        raise SystemExit(
            "mlx-whisper not installed (pip install mlx-whisper) — ASR runs "
            "locally on Apple Silicon; or use --fixture for testing") from None
    model = os.environ.get("MOSH_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
    result = mlx_whisper.transcribe(str(media), path_or_hf_repo=model,
                                    word_timestamps=True)
    out = [{"start": round(float(s["start"]), 2), "end": round(float(s["end"]), 2),
            "text": s["text"].strip()}
           for s in result["segments"]]
    cache.write_text(json.dumps(out, indent=1))
    return out


def _keyframes(media: Path, workdir: Path, max_frames: int = 120) -> list[dict]:
    """Scene-change keyframes (phase0 §7.1: most of a tutorial is a static
    screen with talking — keyframes cut VLM cost 5–10×). Returns
    [{ts, file}] and writes frames/<n>.jpg + frames/index.json."""
    frames_dir = workdir / "frames"
    index_path = frames_dir / "index.json"
    if index_path.is_file():
        cached = json.loads(index_path.read_text())
        if cached:                       # an empty cache means a failed pass — retry
            return cached
    if shutil.which("ffmpeg") is None:
        return []
    frames_dir.mkdir(exist_ok=True)
    # DAW tutorials are NEAR-STATIC screens: pure scene-change detection finds
    # nothing (rung-1 lesson: 0 frames at 0.18). Select on scene-change OR
    # elapsed time, so static stretches still get periodic coverage.
    # showinfo on stderr carries pts_time for every SELECTED frame, in order —
    # that is the index that binds frame files to video timestamps.
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(media),
         "-vf", ("select='isnan(prev_selected_t)+gt(scene,0.04)"
                 "+gte(t-prev_selected_t,20)',showinfo,scale=960:-2"),
         "-vsync", "vfr", "-frames:v", str(max_frames), "-q:v", "4",
         str(frames_dir / "%05d.jpg")],
        capture_output=True, text=True)
    times = []
    for line in proc.stderr.splitlines():
        if "pts_time:" in line:
            try:
                times.append(round(float(line.split("pts_time:")[1].split()[0]), 2))
            except (ValueError, IndexError):
                pass
    files = sorted(frames_dir.glob("*.jpg"))
    index = [{"ts": times[i] if i < len(times) else None,
              "file": str(f)} for i, f in enumerate(files)]
    index_path.write_text(json.dumps(index, indent=1))
    return index

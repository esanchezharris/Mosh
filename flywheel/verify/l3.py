"""L3 — audio embedding similarity, rank-calibrated (phase0 §8).

Embeddings via LAION-CLAP in the judges venv (the checkpoint Emilio already
has on disk); calibration is RANK-based per genre on the gold (mosh render,
tutorial segment) pairs the replication ladder produces — accept-if >= the
p25 of the gold distribution, NEVER an absolute threshold (their samples
differ from ours; absolute cosine is meaningless). Recalibrate when the
sample library or latent model version changes.

Until a genre has >= MIN_PAIRS gold pairs, verdicts report
status=uncalibrated and the accept policy's documented L4 relaxation holds.
Only embeddings/cosines are stored — never tutorial audio (§12).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).parent / "clap_worker.py"
MARKER = "@@MOSH@@"
CALIBRATION = REPO_ROOT / "runs/l3-calibration.json"
MIN_PAIRS = 8


def judges_python() -> str | None:
    p = os.environ.get("MOSH_JUDGES_PY",
                       os.path.expanduser("~/AI/judges_venv/bin/python"))
    return p if Path(p).is_file() else None


def clap_cosines(pairs: list[tuple[str, str]]) -> list[float] | None:
    """Batch cosine similarity; None when the worker is unavailable."""
    py = judges_python()
    if py is None or not pairs:
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump([[str(a), str(b)] for a, b in pairs], f)
        pairs_path = f.name
    try:
        proc = subprocess.run([py, str(WORKER), "cos", pairs_path],
                              capture_output=True, text=True, timeout=600)
        for line in proc.stdout.splitlines():
            if line.startswith(MARKER):
                out = json.loads(line[len(MARKER):])
                return out["cosines"] if out.get("ok") else None
        return None
    finally:
        os.unlink(pairs_path)


def extract_segment(media: Path, start_s: float, end_s: float, out_wav: Path) -> bool:
    """Tutorial reference segment → mono 48k wav (processing-only, never stored)."""
    if shutil.which("ffmpeg") is None:
        return False
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-y", "-ss", str(start_s), "-to", str(end_s),
         "-i", str(media), "-ac", "1", "-ar", "48000", str(out_wav)],
        capture_output=True)
    return proc.returncode == 0 and out_wav.exists()


def record_gold_pair(genre: str, cosine: float) -> None:
    """A verified-gold (render, segment) cosine joins the calibration set."""
    CALIBRATION.parent.mkdir(parents=True, exist_ok=True)
    table = json.loads(CALIBRATION.read_text()) if CALIBRATION.is_file() else {}
    table.setdefault(genre, []).append(round(cosine, 4))
    CALIBRATION.write_text(json.dumps(table, indent=1))


def verdict(cosine: float, genre: str) -> dict:
    table = json.loads(CALIBRATION.read_text()) if CALIBRATION.is_file() else {}
    golds = sorted(table.get(genre, []))
    if len(golds) < MIN_PAIRS:
        return {"status": "uncalibrated", "cosine": cosine,
                "gold_pairs": len(golds),
                "note": f"needs >= {MIN_PAIRS} gold pairs for genre '{genre}' "
                        "(rank calibration, spec s8); L4 relaxation applies"}
    p25 = golds[max(0, len(golds) // 4 - 1)]
    return {"status": "pass" if cosine >= p25 else "fail",
            "cosine": cosine, "p25": p25, "gold_pairs": len(golds)}

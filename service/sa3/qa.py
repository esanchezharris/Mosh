"""Judge-panel QA (05 §7) — attach a production-quality readout to a render's
manifest. Audiobox `PQ` for the output (`pq`) and the source (`pq_base`), via a
subprocess to the judges venv. Best-effort + timeout-guarded: a missing venv, a
timeout, or a crash NEVER fails the render — it just sets `flags=["qa_unavailable"]`.
"""
from __future__ import annotations

import json
import os
import subprocess

JUDGES_PY = os.environ.get(
    "MOSH_JUDGES_PY", os.path.expanduser("~/AI/judges_venv/bin/python"))
PQ_WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_pq_worker.py")
QA_TIMEOUT_S = float(os.environ.get("MOSH_QA_TIMEOUT", "90"))


def _pq(paths):
    paths = [p for p in paths if p and os.path.exists(p)]
    if not paths or not os.path.exists(JUDGES_PY):
        return None
    try:
        r = subprocess.run([JUDGES_PY, PQ_WORKER, *paths],
                           capture_output=True, text=True, timeout=QA_TIMEOUT_S)
        if r.returncode != 0 or not r.stdout.strip():
            return None
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (subprocess.TimeoutExpired, ValueError, json.JSONDecodeError, OSError):
        return None


def augment_manifest(manifest: dict, output_wav: str, source_wav=None) -> None:
    if os.environ.get("MOSH_SA3_QA", "1") != "1":          # QA opt-out (fast renders)
        manifest.setdefault("flags", []).append("qa_disabled")
        return
    scores = _pq([output_wav, source_wav] if source_wav else [output_wav])
    if not scores:
        manifest.setdefault("flags", []).append("qa_unavailable")
        return
    if output_wav in scores:
        manifest["pq"] = round(scores[output_wav], 3)
    if source_wav and source_wav in scores:
        manifest["pq_base"] = round(scores[source_wav], 3)
        if manifest.get("pq") is not None and manifest["pq_base"] - manifest["pq"] > 0.5:
            manifest.setdefault("flags", []).append("quality_degraded")

#!/usr/bin/env python3
"""Naturalness scores for a generated vocal (human-likeness, NOT distance-to-reference).

pq      — Audiobox Production Quality, reused from service/sa3/qa.py (None if judges venv absent).
singmos — SingMOS-Pro singing MOS via service/singmos/singmos_cli.py (None if venv absent).

Both are best-effort: any failure returns None so a benchmark row never dies on naturalness
(the real→fake / graceful-degrade posture). Back-ends are injectable for hermetic tests.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))


def pq_score(wav):
    """Audiobox PQ for one wav, or None if the judges venv (MOSH_JUDGES_PY) is absent."""
    try:
        sys.path.insert(0, os.path.join(REPO, "service"))
        from sa3 import qa
        scores = qa._pq([wav]) or {}
        return qa._pq_of(scores.get(wav))
    except Exception:
        return None


def _singmos_py():
    envf = os.path.join(REPO, "service/singmos/.singmos.env")
    if os.path.isfile(envf):
        for line in open(envf):
            if line.startswith("SINGMOS_PY="):
                return line.split("=", 1)[1].strip()
    cand = os.path.expanduser("~/Library/Mosh/venvs/singmos/bin/python3")
    return cand if os.path.isfile(cand) else None


def singmos_score(wav):
    """SingMOS-Pro singing MOS for one wav, or None if the singmos venv is absent."""
    py = _singmos_py()
    cli = os.path.join(REPO, "service/singmos/singmos_cli.py")
    if not py or not os.path.isfile(cli):
        return None
    try:
        out = subprocess.run([py, cli, wav], capture_output=True, text=True, timeout=120)
        res = json.loads(out.stdout or "{}")
        return float(res["mos"]) if res.get("ok") else None
    except Exception:
        return None


def naturalness(wav, *, pq_fn=None, singmos_fn=None):
    """{"pq": float|None, "singmos": float|None} — best-effort, never raises."""
    pq_fn = pq_fn or pq_score
    singmos_fn = singmos_fn or singmos_score

    def _safe(fn):
        try:
            v = fn(wav)
            return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        except Exception:
            return None

    return {"pq": _safe(pq_fn), "singmos": _safe(singmos_fn)}

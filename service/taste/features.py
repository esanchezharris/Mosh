"""Feature-family row builders for the taste probe (charter Q1).

Every family emits the same probe-row shape: {"ts", "y", "x"} — y is 1 for accept,
0 for reject; x is the family's feature vector for that render. Families:

- audiobox : the four Audiobox-aesthetics axes (CE/CU/PC/PQ) ALREADY computed per
             render by service/sa3/qa.py and sitting in output_manifest.json — the
             charter's "3/4 unread" free family. Zero model cost.
- fake     : deterministic bytes-hash pseudo-embedding. Proves the batch->probe->table
             pipeline hermetically; carries no musical information by construction.
- clap/mert/tunejury : real embeddings via taste_cli.py under the eval venv
             (subprocess — the heavy deps never load in the service process).

INTERNAL EVAL ONLY — see __init__.py (CC-BY-NC backends must never ship in-product).
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess

AXES_ORDER = ("CE", "CU", "PC", "PQ")

_DEFAULT_PY = os.path.expanduser("~/AI/judges_venv/bin/python")


def eval_python(family=None):
    """The interpreter that carries torch/laion_clap/transformers. Reuses the judges
    venv (the Audiobox sidecar's home) by default — no new multi-GB venv for week 1.
    tunejury pip-installs a package with its own pins, so it gets an ISOLATED venv
    (setup-taste.sh --tunejury) — never installed into the judges venv."""
    if family == "tunejury":
        tj = (os.environ.get("MOSH_TUNEJURY_PY")
              or os.path.expanduser("~/Library/Mosh/venvs/tunejury/bin/python"))
        if os.path.exists(tj):
            return tj
    return (os.environ.get("MOSH_TASTE_PY")
            or os.environ.get("MOSH_JUDGES_PY")
            or _DEFAULT_PY)


def _y(row):
    return 1 if row.get("verdict") == "accept" else 0


def audiobox_rows(labels):
    rows = []
    for r in labels:
        axes = r.get("axes")
        if not axes or any(a not in axes for a in AXES_ORDER):
            continue
        rows.append({"ts": r["ts"], "y": _y(r), "x": [float(axes[a]) for a in AXES_ORDER]})
    return rows


def fake_rows(labels, dim=8):
    rows = []
    for r in labels:
        wav = r.get("wav")
        if not wav or not os.path.exists(wav):
            continue
        h = hashlib.sha256(open(wav, "rb").read()).digest()
        need = dim * 2
        while len(h) < need:
            h += hashlib.sha256(h).digest()
        x = [int.from_bytes(h[2 * j:2 * j + 2], "big") / 65535.0 for j in range(dim)]
        rows.append({"ts": r["ts"], "y": _y(r), "x": x})
    return rows


def embed_rows(labels, embeddings):
    """Join a {wav_path: vector} map (taste_cli output) back onto label rows."""
    rows = []
    for r in labels:
        wav = r.get("wav")
        vec = embeddings.get(wav) if wav else None
        if vec is None:
            continue
        rows.append({"ts": r["ts"], "y": _y(r), "x": [float(v) for v in vec]})
    return rows


def cli_embed(family, wav_paths, timeout_s=1800):
    """Run taste_cli.py <family> under the eval venv. Returns {path: vector}.
    Raises RuntimeError with a one-line reason when the family is unavailable —
    build_table turns that into an honest per-family status, never a crash."""
    py = eval_python(family)
    if not os.path.exists(py):
        raise RuntimeError(f"eval venv missing ({py}) — run service/taste/setup-taste.sh")
    cli = os.path.join(os.path.dirname(os.path.abspath(__file__)), "taste_cli.py")
    proc = subprocess.run(
        [py, cli, family, *wav_paths],
        capture_output=True, text=True, timeout=timeout_s)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise RuntimeError(tail[-1] if tail else f"{family} embed failed")
    # Belt: parse the LAST stdout line — torch/laion libraries are chatty and a
    # stray print upstream of the CLI's stdout shield must not kill the family.
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"{family} embed produced no output")
    out = json.loads(lines[-1])
    if not out.get("ok"):
        raise RuntimeError(str(out.get("error") or f"{family} embed failed"))
    return {k: v for k, v in out["embeddings"].items()}

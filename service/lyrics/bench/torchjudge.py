"""Torch-backed judges: embedding similarity + MLM pseudo-perplexity
(FMS lyrics-bench I2).

The heavy half runs in a SUBPROCESS (`_worker.py`) under an interpreter that has
torch + transformers; this module is stdlib-only so the gate can run its tests
under system python3. Two honesty rules the tests pin:

  * **Absent torch → `unavailable`, scores None.** A missing judge must never
    contribute a fabricated 0.0 that calibration would read as data.
  * **Provenance is recorded.** A similarity score is meaningless without the
    weights that produced it, so the interpreter and model id land in the run
    manifest next to the numbers.

Both judges score COMPLETED LINES (truth-filled vs candidate-filled), never bare
fills — a word out of its bar cannot be judged for flow.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
from typing import Callable, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
_WORKER = os.path.join(HERE, "_torch_worker.py")

# Interpreters that may already carry torch+transformers on a dev Mac. The bench
# venv comes first (the convention); the rest keep this usable without a second
# 1.5GB torch install. Whichever wins is recorded in the manifest.
_CANDIDATE_VENVS = ("lyrics-bench", "tunejury", "sft", "transform", "nsf")

EMB_MODEL = os.environ.get("LYRICS_BENCH_EMB_MODEL",
                           "sentence-transformers/all-MiniLM-L6-v2")
PPL_MODEL = os.environ.get("LYRICS_BENCH_PPL_MODEL", "roberta-base")


def _probe(python: str) -> bool:
    if not (python and os.path.exists(python) and os.access(python, os.X_OK)):
        return False
    try:
        r = subprocess.run(
            [python, "-c", "import importlib.util as u,sys;"
                           "sys.exit(0 if u.find_spec('torch') and "
                           "u.find_spec('transformers') else 1)"],
            capture_output=True, timeout=60)
        return r.returncode == 0
    except Exception:  # noqa: BLE001 — a broken interpreter is just "not it"
        return False


def resolve_python() -> Optional[str]:
    """First interpreter that can actually import torch+transformers, or None."""
    override = os.environ.get("LYRICS_BENCH_TORCH_PY")
    if override and _probe(override):
        return override
    root = os.environ.get("MOSH_VENVS_DIR") or os.path.expanduser(
        "~/Library/Mosh/venvs")
    for name in _CANDIDATE_VENVS:
        cand = os.path.join(root, name, "bin", "python")
        if _probe(cand):
            return cand
    return None


def _completed(item: dict, fill: str) -> str:
    if item["granularity"] == "line":
        return fill
    from lyrics.bench.metrics import apply_fill
    return apply_fill(item, fill)


def _pair_key(item: dict, fill: str, kind: str) -> str:
    model = EMB_MODEL if kind == "emb" else PPL_MODEL
    blob = json.dumps({"kind": kind, "model": model, "itemId": item["itemId"],
                       "truth": _completed(item, item["target"]["text"]),
                       "candidate": _completed(item, fill)}, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def run_backend(python: str, script: str, payload: dict) -> dict:
    """Default backend runner: the worker reads JSON on stdin, writes JSON out."""
    try:
        r = subprocess.run([python, script], input=json.dumps(payload),
                           capture_output=True, text=True, timeout=1800)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"backend launch failed: {e}"}
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "").strip()[-400:]
                or f"backend exit {r.returncode}"}
    try:
        return json.loads(r.stdout)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"backend output unparseable: {e}"}


def score_pairs(pairs: Sequence[Tuple[dict, str]], *, kind: str, cache=None,
                run_backend: Callable = run_backend,
                python: Optional[str] = None) -> dict:
    """Score (item, candidate_fill) pairs.

    kind="emb" → cosine similarity of the completed lines (higher = closer to
    what the human wrote). kind="ppl" → NLL(candidate line) − NLL(truth line)
    under a masked LM, pseudo-log-likelihood style (lower = reads more like real
    text; 0 means as fluent as the truth). Neither is trusted until calibration.
    """
    if kind not in ("emb", "ppl"):
        raise ValueError(f"unknown kind {kind!r}")

    scores: List[Optional[float]] = [None] * len(pairs)
    todo: List[int] = []
    # Provenance travels WITH the cached score: a replayed number that cannot
    # name its weights is not reproducible, it is just a number.
    hit_backends: List[str] = []
    keys = [_pair_key(item, fill, kind) for item, fill in pairs]
    if cache is not None:
        for i, key in enumerate(keys):
            hit = cache.get(key)
            if hit is not None and hit.get("score") is not None:
                scores[i] = hit["score"]
                cache.stats["hits"] += 1
                if hit.get("backend"):
                    hit_backends.append(json.dumps(hit["backend"], sort_keys=True))
            else:
                todo.append(i)
    else:
        todo = list(range(len(pairs)))

    if not todo:
        distinct = sorted(set(hit_backends))
        recovered = (json.loads(distinct[0]) if len(distinct) == 1
                     else {"mixed": [json.loads(b) for b in distinct]})
        return {"status": "ok", "scores": scores, "backend": recovered,
                "error": None}

    py = python or resolve_python()
    if not py:
        return {"status": "unavailable", "scores": [None] * len(pairs),
                "backend": None,
                "error": "no interpreter with torch+transformers found "
                         "(set LYRICS_BENCH_TORCH_PY or run setup-lyrics-bench.sh --torch)"}

    payload = {
        "kind": kind,
        "model": EMB_MODEL if kind == "emb" else PPL_MODEL,
        "pairs": [{"truth": _completed(pairs[i][0], pairs[i][0]["target"]["text"]),
                   "candidate": _completed(pairs[i][0], pairs[i][1])} for i in todo],
    }
    out = run_backend(py, _WORKER, payload)
    if not out.get("ok"):
        return {"status": "unavailable", "scores": [None] * len(pairs),
                "backend": None, "error": out.get("error") or "backend failed"}

    fresh = out.get("scores") or []
    if len(fresh) != len(todo):
        return {"status": "unavailable", "scores": [None] * len(pairs),
                "backend": out.get("backend"),
                "error": f"backend returned {len(fresh)} scores for {len(todo)} pairs"}
    for slot, value in zip(todo, fresh):
        scores[slot] = value
        if cache is not None:
            cache.stats["misses"] += 1
            cache.put(keys[slot], {"score": value, "backend": out.get("backend")})
    return {"status": "ok", "scores": scores, "backend": out.get("backend"),
            "error": None}

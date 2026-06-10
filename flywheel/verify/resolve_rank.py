#!/usr/bin/env python3
"""CLAP-ranked sample resolution ("clap similarity"): descriptor text →
best-matching audio in a crate. Token prefilter (cheap, path-aware) then
CLAP text→audio rerank in the judges venv.

  python3 -m flywheel.verify.resolve_rank "punchy rnb clap" \
      --library ~/Splice/sounds --top 5 [--one-shots]

Used by the replication ladder's correction pass today; the same worker call
is the service-side resolver upgrade later (the C++ lowering keeps its
deterministic token scan as the always-available fallback).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from flywheel.verify import l3  # noqa: E402

MARKER = "@@MOSH@@"


def token_prefilter(query: str, library: Path, limit: int = 24,
                    one_shots: bool = False) -> list[Path]:
    tokens = [t for t in query.lower().replace("-", " ").split() if len(t) > 1]
    scored = []
    for f in sorted(library.rglob("*.wav")):
        rel = str(f.relative_to(library)).lower().replace("_", " ").replace("-", " ")
        name = f.name.lower().replace("_", " ").replace("-", " ")
        if one_shots and ("loop" in rel or f.stat().st_size > 4_000_000):
            continue
        score = sum(2 if t in name else (1 if t in rel else 0) for t in tokens)
        if score > 0:
            scored.append((score, f))
    scored.sort(key=lambda x: (-x[0], str(x[1])))
    return [f for _, f in scored[:limit]]


def clap_rank(query: str, candidates: list[Path]) -> list[dict] | None:
    py = l3.judges_python()
    if py is None or not candidates:
        return None
    spec = {"query": query, "files": [str(f) for f in candidates]}
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(spec, f)
        spec_path = f.name
    try:
        proc = subprocess.run([py, str(l3.WORKER), "rank", spec_path],
                              capture_output=True, text=True, timeout=600)
        for line in proc.stdout.splitlines():
            if line.startswith(MARKER):
                out = json.loads(line[len(MARKER):])
                return out["ranked"] if out.get("ok") else None
        return None
    finally:
        os.unlink(spec_path)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--library", type=Path,
                    default=Path(os.environ.get("MOSH_SAMPLE_LIBRARY", ".")))
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--one-shots", action="store_true")
    a = ap.parse_args()

    candidates = token_prefilter(a.query, a.library, one_shots=a.one_shots)
    if not candidates:
        print(json.dumps({"ok": False, "error": "no token matches"}))
        return
    ranked = clap_rank(a.query, candidates)
    if ranked is None:   # CLAP unavailable → token order stands
        ranked = [{"sim": None, "file": str(f)} for f in candidates]
    print(json.dumps({"ok": True, "query": a.query, "ranked": ranked[: a.top]}, indent=1))


if __name__ == "__main__":
    main()

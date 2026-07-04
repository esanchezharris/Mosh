#!/usr/bin/env python3
"""Hermetic goldens for embed_store's corpus pass (no judges venv needed —
exercises the walk, provenance, alias flow, manifest and idempotency; the
model-embedding path is covered by the live backfill/corpus runs).

    python3 scripts/verify-hardware/corpus_test.py   (3× deterministic)
"""
from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import embed_store as ES  # noqa: E402

FAILS = []


def check(name: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"  [{detail}]" if not ok and detail else ""))
    if not ok:
        FAILS.append(name)


def write_wav(path: Path, seconds: float = 1.0, freq: float = 220.0):
    path.parent.mkdir(parents=True, exist_ok=True)
    sr = 8000
    n = int(sr * seconds)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        import math
        w.writeframes(b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / sr)))
            for i in range(n)))


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "taste"
        ES_STORE, ES_MANIFEST, ES_TASTE = ES.STORE, ES.CORPUS_MANIFEST, ES.TASTE
        ES.STORE = Path(td) / "labels" / "embeddings" / "index.jsonl"
        ES.CORPUS_MANIFEST = Path(td) / "labels" / "corpus.jsonl"
        ES.TASTE = root
        try:
            # walk: provenance by folder, extension filter, iCloud-dupe skip
            write_wav(root / "own" / "mybeat.wav")
            write_wav(root / "refs" / ".fetch" / "ref1.wav", freq=330)
            write_wav(root / "samples" / "loop1.wav", freq=440)
            (root / "own" / "notes.txt").write_text("not audio")
            write_wav(root / "own" / "mybeat 2.wav")  # iCloud dupe
            items = ES.corpus_items(root)
            check("walk finds 3 audio items with per-folder provenance",
                  sorted(s for _, s in items) == ["own", "ref", "sample"],
                  str(items))
            check("walk skips non-audio and iCloud ' 2' dupes",
                  not any("notes.txt" in p or " 2" in p for p, _ in items))

            # alias flow: content already in the store under another path → alias
            # rows + manifest rows, ZERO embedding needed (returns 0, no venv).
            own = str(root / "own" / "mybeat.wav")
            sha = ES.content_sha(own)
            ES.STORE.parent.mkdir(parents=True, exist_ok=True)
            for p, _s in items:
                ES._append_jsonl(ES.STORE, {"sha": ES.content_sha(p),
                                            "path": "/elsewhere/" + os.path.basename(p),
                                            "clap": [0.1, 0.2], "muq": [0.3]})
            rc = ES.run_corpus(root)
            check("run_corpus aliases known content without a venv (rc 0)", rc == 0)
            rows = ES.corpus_manifest_rows()
            check("manifest has one row per item with source",
                  len(rows) == 3 and {r["source"] for r in rows} == {"own", "ref", "sample"},
                  str(rows))
            store_paths = {json.loads(l)["path"] for l in ES.STORE.read_text().splitlines()}
            check("store gained alias rows keyed by the NEW paths",
                  own in store_paths)
            check("alias rows carry the original vectors by sha",
                  any(json.loads(l)["sha"] == sha and json.loads(l).get("clap") == [0.1, 0.2]
                      for l in ES.STORE.read_text().splitlines()
                      if json.loads(l)["path"] == own))

            # idempotency: second run = no new rows
            before = ES.CORPUS_MANIFEST.read_text()
            rc2 = ES.run_corpus(root)
            check("second run is a byte-identical no-op (idempotent)",
                  rc2 == 0 and ES.CORPUS_MANIFEST.read_text() == before)

            # sample cap is applied at the walk
            for i in range(5):
                write_wav(root / "samples" / f"x{i}.wav", freq=100 + i)
            old_cap = ES.SAMPLE_CAP
            ES.SAMPLE_CAP = 2
            try:
                capped = [p for p, s in ES.corpus_items(root) if s == "sample"]
                check("samples/ respects the cap (deterministic sorted prefix)",
                      len(capped) == 2, str(capped))
            finally:
                ES.SAMPLE_CAP = old_cap
        finally:
            ES.STORE, ES.CORPUS_MANIFEST, ES.TASTE = ES_STORE, ES_MANIFEST, ES_TASTE

    if FAILS:
        print(f"FAILURES: {', '.join(FAILS)}  ({len(FAILS)} failure(s))")
        return 1
    print("ALL PASS  (0 failure(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

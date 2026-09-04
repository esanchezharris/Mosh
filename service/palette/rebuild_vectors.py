#!/usr/bin/env python3
"""rebuild_vectors.py — R3.2 (produce lane, quality-pivot 2026-09): re-embed an EXISTING
curated palette (palette-v2) after its audio changed underneath it (here:
service/presets/retrim_onsets.py's onset re-trim), without disturbing anything about the
manifest's curated fields (role_guess, root_note, root_source, sub_energy_db, rms_db,
kind, path) that no re-embed can regenerate.

Why not `service/palette/build_palette.py` directly: that script's own source
enumeration is hardcoded to ~/Downloads/musica and the Splice pack library (`iter_sources`)
— it has no flag to point at an arbitrary already-curated directory, and its own item
shape (`src`, `char`, `kind: one_shot|loop`) doesn't match palette-v2's curated manifest
shape at all (palette-v2 items carry `kind: "oneshot"`, `root_source`, `sub_energy_db`
— fields a from-scratch scan would drop). This module reuses build_palette.py's exact
embedding + standardization + L2 pipeline (same `EngineeredEmbedder`, same
`drummatch.embed.load_audio`, same mean/std/L2 math) but sources files from the palette's
OWN manifest.json in ITEM ORDER, then merges the fresh vectors + the corpus mean/std/
version back into that same manifest — every other field on every item passes through
untouched (add/re-fingerprint, never drop-and-rebuild).

    service/teardown/.venv/bin/python service/palette/rebuild_vectors.py <palette-dir>

(a venv with librosa/soundfile/numpy — see docs/PALETTE-GENERATION-METHOD.md's landmine
note: never put service/ itself on sys.path, only service/teardown, or `service/coverage.py`
shadows the real `coverage` package and breaks numba/librosa's import).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "service/teardown"))  # drummatch package — NEVER insert service/ itself

import numpy as np  # noqa: E402

from drummatch.embed import EngineeredEmbedder, load_audio  # noqa: E402


def _l2(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    n[n < 1e-12] = 1.0
    return m / n


def _detect_json_style(text: str) -> tuple[Optional[int], bool]:
    trailing_newline = text.endswith("\n")
    indent = None
    for line in text.splitlines()[1:]:
        stripped = line.lstrip(" ")
        if stripped != line:
            indent = len(line) - len(stripped)
            break
        if stripped:
            break
    return indent, trailing_newline


def _write_preserving_style(path: Path, doc, original_text: str) -> None:
    indent, trailing_newline = _detect_json_style(original_text)
    text = json.dumps(doc, indent=indent if indent is not None else 2)
    if trailing_newline and not text.endswith("\n"):
        text += "\n"
    path.write_text(text, encoding="utf-8")


def rebuild(palette_dir: Path) -> dict:
    manifest_path = palette_dir / "manifest.json"
    original_text = manifest_path.read_text(encoding="utf-8")
    doc = json.loads(original_text)
    items = doc["items"] if isinstance(doc, dict) and "items" in doc else doc

    emb = EngineeredEmbedder()
    raws: list[np.ndarray] = []
    n_skip = 0
    skipped: list[tuple[str, str]] = []

    for item in items:
        path = item.get("path")
        if not path or not Path(path).is_file():
            n_skip += 1
            skipped.append((str(path), "missing file"))
            raws.append(None)
            continue
        try:
            la = load_audio(path)
            v = emb.embed(la.y, la.sr)
        except Exception as e:  # a bad file must not abort the whole rebuild
            n_skip += 1
            skipped.append((str(path), f"{type(e).__name__}: {e}"))
            raws.append(None)
            continue
        raws.append(np.asarray(v, dtype=np.float64))

    ok_raws = [r for r in raws if r is not None]
    if not ok_raws:
        raise RuntimeError("rebuild_vectors: no items embedded — nothing to write")

    dim = ok_raws[0].shape[0]
    X_full = np.zeros((len(raws), dim), dtype=np.float64)
    keep_mask = np.zeros(len(raws), dtype=bool)
    for i, r in enumerate(raws):
        if r is not None:
            X_full[i] = r
            keep_mask[i] = True

    X_ok = X_full[keep_mask]
    mean = X_ok.mean(axis=0)
    std = X_ok.std(axis=0)
    std[std < 1e-9] = 1.0
    vectors_ok = _l2((X_ok - mean) / std).astype(np.float32)

    # re-expand to the FULL item list, in original order — items that failed to embed
    # keep their manifest entry (never silently dropped) but are excluded from vectors.npy
    # and reported as skipped; a healthy palette-v2 run should skip zero.
    kept_items = [item for item, keep in zip(items, keep_mask) if keep]
    if len(kept_items) != len(items):
        print(f"rebuild_vectors: WARNING {len(items) - len(kept_items)} item(s) failed to embed "
              f"and are being DROPPED from vectors.npy/manifest — see skip list below", file=sys.stderr)
        for p, reason in skipped:
            print(f"  skip: {p} ({reason})", file=sys.stderr)
        items = kept_items

    np.save(palette_dir / "vectors.npy", vectors_ok)

    doc_out = dict(doc) if isinstance(doc, dict) else {"items": doc}
    doc_out["version"] = emb.version
    doc_out["count"] = len(items)
    doc_out["mean"] = mean.tolist()
    doc_out["std"] = std.tolist()
    doc_out["items"] = items
    _write_preserving_style(manifest_path, doc_out, original_text)

    return {"count": len(items), "dim": dim, "skipped": skipped, "version": emb.version}


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("palette_dir")
    args = p.parse_args(argv)

    palette_dir = Path(args.palette_dir)
    if not (palette_dir / "manifest.json").is_file():
        print(f"rebuild_vectors: manifest not found under {palette_dir}", file=sys.stderr)
        return 1

    result = rebuild(palette_dir)
    print(f"rebuild_vectors: {result['count']} item(s) embedded (dim={result['dim']}, "
          f"version={result['version']}, {len(result['skipped'])} skipped) -> {palette_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

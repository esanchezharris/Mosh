#!/usr/bin/env python3
"""Build the VECTOR SAMPLE PALETTE — the owner's drum/808/one-shot library, embedded.

This is BOTH (a) the generation palette the beat builder picks real sounds from, and
(b) the preference vector DB: every one-shot is embedded into a timbre vector so the
owner's A/B picks can later define a *region* of preference (#56 reuses the existing
triplet-margin head over these vectors), not a single file.

Reuses the proven pieces:
  • probe/kit.py `_resample`  — every sample copied to a 44.1k/PCM_16 asset (assign_sample
    does NO engine-side resample; non-44.1k stalls the headless render).
  • drummatch/embed.py `EngineeredEmbedder` + `load_audio` — deterministic, offline, built
    for short one-shots (no model download). Swap in MuQ-MuLan/CLAP later for text queries.
  • drummatch/index.py standardization (corpus mean/std → L2) so the vectors are cosine-NN
    ready and `SampleIndex.load()` can read the manifest directly.

Output (default service/palette/palette/): vectors.npy + manifest.json. Each manifest item:
  { path: <44.1k asset>, src: <original>, role_guess, kind, root_note, char[], content_hash }
role_guess/root_note come from the folder+filename (reliable for a curated library), NOT
from acoustics — provenance/labelling, never a taste judgement.

    service/teardown/.venv/bin/python service/palette/build_palette.py [--limit N] [--out DIR]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO / "service/teardown/probe"))     # kit._resample
sys.path.insert(0, str(REPO / "service/teardown"))           # drummatch package

import kit  # noqa: E402
from drummatch.embed import EngineeredEmbedder, load_audio   # noqa: E402

MUSICA = Path(os.path.expanduser("~/Downloads/musica"))
SPLICE = Path(os.path.expanduser(os.environ.get("MOSH_SAMPLE_LIBRARY", "~/Splice/sounds/packs")))
OUT_DEFAULT = HERE / "palette"

# Role from the lowercased relative PATH (folder + filename). Order matters: 808 before kick
# so "808 kick" stays a kick but a plain "808" is the melodic bass; loops/melodic handled by kind.
PITCH_CLASS = {"c": 0, "c#": 1, "db": 1, "d": 2, "d#": 3, "eb": 3, "e": 4, "f": 5,
               "f#": 6, "gb": 6, "g": 7, "g#": 8, "ab": 8, "a": 9, "a#": 10, "bb": 10, "b": 11}
KEY_RE = re.compile(r"(?<![a-z])([a-g](?:#|b)?)(?:\s*(?:min|maj|m)?)?(?=[^a-z]*\.wav$)", re.I)


def classify(rel_lower: str) -> str:
    has = lambda *ks: any(k in rel_lower for k in ks)
    if has("kick") and not has("808 kick", "kick 808"):
        return "kick"
    if "808 kick" in rel_lower or "kick 808" in rel_lower:
        return "kick"
    if has("808") or ("bass" in rel_lower and not has("bassline", "loop")):
        return "808"
    if has("snare"):
        return "snare"
    if has("clap"):
        return "clap"
    if has("hat", "hihat", "hi-hat", "hi hat"):
        return "hat"
    if has("rim", "tom", "shaker", "conga", "bongo", "tamb", "perc", "crash", "ride", "cymbal", "snap"):
        return "perc"
    if has("lead", "synth", "melod", "pluck", "key", "pad", "chord", "arp", "bell", "flute"):
        return "melodic"
    return "other"


def root_note(rel_lower: str, role: str) -> int | None:
    """Parse a key letter from the filename → a MIDI root in the sub octave (C2=36 anchor)
    for 808/melodic so repitch lands in-key. None when no key is named."""
    if role not in ("808", "melodic"):
        return None
    m = KEY_RE.search(rel_lower)
    if not m:
        return 36  # default: treat the sample's native pitch as C2 (de-risk showed ~C1 anyway)
    pc = PITCH_CLASS.get(m.group(1).lower())
    return None if pc is None else 24 + pc  # C1..B1 region; the engine repitches from here


CHAR_VOCAB = ["dark", "bright", "punchy", "hard", "soft", "deep", "sub", "distorted", "clean",
              "vintage", "lofi", "warm", "tape", "boom", "knock", "tight", "long", "short",
              "reverb", "wet", "dry", "trap", "drill", "vinyl", "analog", "gritty", "crisp"]


def char_tags(rel_lower: str) -> list[str]:
    return [w for w in CHAR_VOCAB if w in rel_lower]


def _l2(m: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    n[n < 1e-12] = 1.0
    return m / n


def iter_sources(limit: int | None):
    roots = [r for r in (MUSICA, SPLICE) if r.is_dir()]
    seen = 0
    for root in roots:
        for p in sorted(root.rglob("*.wav")):
            if not p.is_file():
                continue
            yield p
            seen += 1
            if limit and seen >= limit:
                return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--limit", type=int, default=0, help="cap sources scanned (0 = all)")
    ap.add_argument("--include-loops", action="store_true", help="also index >3s loops (default: one-shots only)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    emb = EngineeredEmbedder()
    raws: list[np.ndarray] = []
    items: list[dict] = []
    seen_hash: set[str] = set()
    n_scan = n_skip = 0
    role_counts: dict[str, int] = {}

    for src in iter_sources(a.limit or None):
        n_scan += 1
        rel = str(src).replace(str(MUSICA), "").replace(str(SPLICE), "")
        rel_lower = rel.lower()
        role = classify(rel_lower)
        asset = kit._resample(str(src))            # → 44.1k/PCM_16 cached asset (or None)
        if not asset:
            n_skip += 1
            continue
        try:
            la = load_audio(asset)                  # kind (one_shot/loop) + content_hash + decoded audio
        except Exception:
            n_skip += 1
            continue
        if la.kind == "loop" and not a.include_loops:
            n_skip += 1
            continue
        if la.content_hash in seen_hash:
            n_skip += 1
            continue
        try:
            v = emb.embed(la.y, la.sr)
        except Exception:
            n_skip += 1
            continue
        seen_hash.add(la.content_hash)
        raws.append(np.asarray(v, dtype=np.float64))
        items.append({"path": asset, "src": str(src), "role_guess": role, "kind": la.kind,
                      "root_note": root_note(rel_lower, role), "char": char_tags(rel_lower),
                      "content_hash": la.content_hash})
        role_counts[role] = role_counts.get(role, 0) + 1
        if len(items) % 200 == 0:
            print(f"  ...{len(items)} embedded ({n_scan} scanned)", flush=True)

    if not raws:
        print("no samples embedded — is ~/Downloads/musica populated?")
        return 1

    X = np.vstack(raws)
    mean = X.mean(axis=0)
    std = X.std(axis=0)
    std[std < 1e-9] = 1.0
    vectors = _l2((X - mean) / std).astype(np.float32)

    np.save(out / "vectors.npy", vectors)
    manifest = {
        "version": emb.version,
        "sr": 44100,
        "count": len(items),
        "mean": mean.tolist(),
        "std": std.tolist(),
        "role_counts": role_counts,
        "items": items,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"\nPALETTE: {len(items)} one-shots embedded ({n_scan} scanned, {n_skip} skipped) → {out}")
    print(f"  roles: {json.dumps(role_counts, sort_keys=True)}")
    print(f"  dims: {vectors.shape[1]} | vectors.npy + manifest.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())

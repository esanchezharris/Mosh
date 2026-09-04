#!/usr/bin/env python3
"""match_kit.py — R3.2 (produce lane, quality-pivot 2026-09): kit-matched picking. Embeds
each item of the owner's lab kit manifest (scripts/lab/make-lab-manifest.py's output —
his ACTUAL Live-set drum samples, e.g. ~/Library/Mosh/lab-manifests/15drtt-jerk-r0.json)
with the same `EngineeredEmbedder` the curated palette-v2 was embedded with, standardizes
against the palette's own corpus mean/std, and cosine-searches the palette's vectors
restricted to matching role — so the produce-lane picker (`ui/src/agent/loop/drumPalette.ts`,
out of scope here — TS-side consumption is a separate task) can prefer the palette-v2
sample that timbrally resembles what the owner actually reached for, lane by lane.

WHY not `drummatch.index.SampleIndex`/`DrumMatcher` (service/teardown/drummatch/index.py):
that module currently fails to import in this worktree —
`from .roles import ROLE_VALUES, classify_role` — because
`service/teardown/drummatch/roles.py` does not exist here (present in older ancestor
commits, dropped by the "vendor(teardown): cherry-pick service/teardown" cherry-pick;
confirmed via `git log --all -- service/teardown/drummatch/roles.py` vs
`git ls-files service/teardown/drummatch/`, a pre-existing repo gap unrelated to this
task). This module reuses the exact same algorithm SampleIndex implements
(standardize -> L2-normalize -> cosine via a dot product against pre-normalized palette
vectors, see index.py:108-141) directly against `EngineeredEmbedder` +
`drummatch.embed.load_audio`, which import cleanly on their own.

WHY hand-rolled sys.path insertion, not a bare `service/` addition: `service/coverage.py`
shadows the PyPI `coverage` package whenever the `service/` directory itself lands on
sys.path, breaking numba (and so librosa) — see
docs/PALETTE-GENERATION-METHOD.md's "Known repo landmine" and
service/presets/measure_sub.py's docstring. Only `service/teardown` (the `drummatch`
package's parent) is added, exactly as service/palette/build_palette.py already does.

Lane mapping (plan R3.2, verbatim): the lab manifest's role_guess only distinguishes
kick/snare/clap/hat/openhat/perc/fx/bass — snare and clap each cover more than one
produce-lane pad (ui/src/agent/loop/drumPalette.ts's 10-pad map: kick, snare, snare2,
clap, clap2, hat, openhat, perc, fx, roll), disambiguated by a filename fragment baked
into the lab kit's own file names:
  snares — "light" -> snare, "mem" -> roll, "omg" -> snare2
  claps  — "law"   -> clap,  "igdk" -> clap2
kick/hat/openhat/perc/fx map straight through (role_guess IS the lane name). bass/808
items are skipped entirely — R2.6's sub-energy rule (service/presets/measure_sub.py) owns
808 picking, not timbre-nearest-neighbour.

CLI: `match_kit.py <lab-manifest.json> <palette-manifest.json> --out <kitmatch.json>`
Palette vectors.npy must sit beside <palette-manifest.json> (same directory) and must
already reflect the current audio (service/palette/rebuild_vectors.py after any re-trim —
stale vectors silently mis-rank, so this tool asserts vectors.npy row count matches the
manifest's item count before searching).
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# Lane produce-map (ui/src/agent/loop/drumPalette.ts's 10 pad ids). role_guess values
# that map straight through to a same-named lane:
DIRECT_LANES = {"kick", "hat", "openhat", "perc", "fx"}

# Filename-fragment disambiguation for the two lab role_guess values that cover more than
# one produce-lane pad (see module docstring).
SNARE_FRAGMENT_TO_LANE = {"light": "snare", "mem": "roll", "omg": "snare2"}
CLAP_FRAGMENT_TO_LANE = {"law": "clap", "igdk": "clap2"}

EXCLUDED_ROLES = {"bass", "808"}  # the sub-energy rule owns these, not timbre-NN
TOP_K = 4  # 1 best pick + up to 3 alternates


def _try_import_embedder():
    """(EngineeredEmbedder class, load_audio fn) if service/teardown/drummatch/embed.py
    and its runtime deps (librosa, soundfile, numpy) import cleanly on this machine, else
    (None, None). NEVER put service/ itself on sys.path — see module docstring."""
    teardown_dir = str(REPO / "service" / "teardown")
    added = teardown_dir not in sys.path
    if added:
        sys.path.insert(0, teardown_dir)
    try:
        from drummatch.embed import EngineeredEmbedder, load_audio  # type: ignore

        import numpy  # noqa: F401 — probe eagerly, embed()/load_audio() need it lazily
        import soundfile  # noqa: F401
        import librosa  # noqa: F401

        return EngineeredEmbedder, load_audio
    except Exception:
        return None, None
    finally:
        if added and teardown_dir in sys.path:
            sys.path.remove(teardown_dir)


def determine_lane(role_guess: str, path: str) -> Optional[str]:
    """The produce-lane pad id a lab item belongs in, or None (bass/808, or an
    unrecognized role/filename this tool doesn't know how to place)."""
    role = (role_guess or "").strip().lower()
    if role in EXCLUDED_ROLES:
        return None
    if role in DIRECT_LANES:
        return role
    name_lower = Path(path).name.lower()
    if role == "snare":
        for fragment, lane in SNARE_FRAGMENT_TO_LANE.items():
            if fragment in name_lower:
                return lane
        return None
    if role == "clap":
        for fragment, lane in CLAP_FRAGMENT_TO_LANE.items():
            if fragment in name_lower:
                return lane
        return None
    return None


def standardize(vec, mean, std):
    """(vec - mean) / std, then L2-normalized — mirrors
    drummatch.index.SampleIndex._final_vec exactly (same math, reimplemented here because
    that module fails to import — see module docstring)."""
    import numpy as np

    z = (np.asarray(vec, dtype=np.float64) - np.asarray(mean, dtype=np.float64)) / np.asarray(std, dtype=np.float64)
    n = float(np.linalg.norm(z))
    return (z / (n if n > 1e-12 else 1.0)).astype(np.float32)


def cosine_rank(query_vec, palette_vectors, palette_roles, role: str, k: int = TOP_K):
    """[(palette_index, cosine_similarity), ...] sorted best-first, restricted to palette
    items whose role_guess == `role`. `palette_vectors` rows are assumed already
    standardized + L2-normalized (as vectors.npy is), so cosine similarity is a plain dot
    product."""
    import numpy as np

    sims = palette_vectors @ np.asarray(query_vec, dtype=np.float32)
    order = np.argsort(-sims, kind="stable")
    out = []
    for i in order:
        if palette_roles[i] != role:
            continue
        out.append((int(i), float(sims[i])))
        if len(out) >= k:
            break
    return out


def load_palette(palette_manifest_path: Path):
    import numpy as np

    doc = json.loads(palette_manifest_path.read_text(encoding="utf-8"))
    items = doc["items"]
    mean = doc["mean"]
    std = doc["std"]
    vectors = np.load(palette_manifest_path.parent / "vectors.npy")
    if vectors.shape[0] != len(items):
        raise ValueError(
            f"match_kit: vectors.npy row count ({vectors.shape[0]}) != manifest item count "
            f"({len(items)}) — rebuild with service/palette/rebuild_vectors.py first"
        )
    roles = [it.get("role_guess") for it in items]
    paths = [it.get("path") for it in items]
    return mean, std, vectors, roles, paths


def build_kitmatch(lab_manifest_path: Path, palette_manifest_path: Path) -> dict:
    EngineeredEmbedder, load_audio = _try_import_embedder()
    if EngineeredEmbedder is None:
        raise RuntimeError(
            "match_kit: EngineeredEmbedder unavailable on this interpreter "
            "(librosa/soundfile/numpy) — run under a venv that has them "
            "(e.g. ~/Library/Mosh/venvs/teardown/bin/python3)"
        )

    lab_doc = json.loads(lab_manifest_path.read_text(encoding="utf-8"))
    lab_items = lab_doc["items"] if isinstance(lab_doc, dict) and "items" in lab_doc else lab_doc

    mean, std, palette_vectors, palette_roles, palette_paths = load_palette(palette_manifest_path)

    emb = EngineeredEmbedder()
    lanes: dict[str, dict] = {}
    skipped: list[tuple[str, str]] = []

    for item in lab_items:
        role = (item.get("role_guess") or "").strip().lower()
        path = item.get("path")
        lane = determine_lane(role, path or "")
        if lane is None:
            if role not in EXCLUDED_ROLES:
                skipped.append((path or "<no path>", f"unrecognized role/filename ({role})"))
            continue
        if not path or not Path(path).is_file():
            skipped.append((path or "<no path>", "missing file"))
            continue

        try:
            la = load_audio(path)
            raw_vec = emb.embed(la.y, la.sr)
        except Exception as e:
            skipped.append((path, f"{type(e).__name__}: {e}"))
            continue

        query_vec = standardize(raw_vec, mean, std)
        ranked = cosine_rank(query_vec, palette_vectors, palette_roles, role, k=TOP_K)
        if not ranked:
            skipped.append((path, f"no palette items with role_guess={role!r}"))
            continue

        best_idx, best_cos = ranked[0]
        alternates = [
            {"paletteFile": palette_paths[i], "cosine": round(cos, 4)}
            for i, cos in ranked[1:]
        ]
        lanes[lane] = {
            "ownerFile": path,
            "role": role,
            "paletteFile": palette_paths[best_idx],
            "cosine": round(best_cos, 4),
            "alternates": alternates,
        }

    return {
        "version": "kitmatch-v1",
        "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "lab": str(lab_manifest_path),
        "palette": str(palette_manifest_path),
        "lanes": lanes,
        "skipped": [{"path": p, "reason": r} for p, r in skipped],
    }


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("lab_manifest")
    p.add_argument("palette_manifest")
    p.add_argument("--out", required=True)
    args = p.parse_args(argv)

    lab_path = Path(args.lab_manifest)
    palette_path = Path(args.palette_manifest)
    if not lab_path.is_file():
        print(f"match_kit: lab manifest not found: {lab_path}", file=sys.stderr)
        return 1
    if not palette_path.is_file():
        print(f"match_kit: palette manifest not found: {palette_path}", file=sys.stderr)
        return 1

    try:
        result = build_kitmatch(lab_path, palette_path)
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1
    except ValueError as e:
        print(str(e), file=sys.stderr)
        return 1

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    print(f"match_kit: {len(result['lanes'])} lane(s) matched, {len(result['skipped'])} skipped -> {out_path}")
    print(f"  {'lane':<8}  {'cosine':>7}  {'role':<8}  ownerFile -> paletteFile")
    for lane in sorted(result["lanes"]):
        row = result["lanes"][lane]
        print(f"  {lane:<8}  {row['cosine']:7.4f}  {row['role']:<8}  "
              f"{Path(row['ownerFile']).name} -> {Path(row['paletteFile']).name}")
    for path, reason in result["skipped"]:
        print(f"  skip: {path} ({reason})", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

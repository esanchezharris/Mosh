#!/usr/bin/env python3
"""Assemble Taste Pack 002: 12 new factory beats + 2 REPRISES of pack-001 keeps.

A reprise re-renders the EXACT pack-001 composition (regenerated with the OLD
generator code extracted from git — same request/seed/library/palette-roots ⇒
bit-identical recipe, asserted via the bound-sample fingerprint) through the NEW
mix pipeline (clip-guard fix, peak-normalize, audibility gates). That isolates the
mix delta: the owner pre-registered the hypothesis himself on beat 02 — "with a
good mix... could be five stars". Beat 01 is the audibility stress case; beat 11
is the fallback when a reprise can't pass the new gates (if mix alone can't save
it, the machine agreeing with his ear is the finding — we don't ship it).

    MOSH_BIN=... python3 scripts/verify-hardware/make_pack002.py \
        [--out ~/mosh-beats/pack-002] [--old-commit a746be64] [--skip-factory]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SERVICE = os.path.join(REPO, "service")
for p in (SERVICE, HERE):
    if p not in sys.path:
        sys.path.insert(0, p)

import beat_factory as BF  # noqa: E402

BEATS = os.path.expanduser("~/mosh-beats")
PACK1 = os.path.join(BEATS, "pack-001")
LIB_DIR = os.path.join(SERVICE, "recipes", "library")
# pack-001 pack_file prefixes to reprise, in priority order (02 = the owner's own
# mix hypothesis; 01 = audibility stress; 11 = fallback mix-complaint keep)
REPRISE_PRIORITY = ["02_", "01_", "11_"]
N_REPRISES = 2


REPRISE_MIN_RESIDUAL_DB = -40.0  # gain-aligned residual quieter than this = the new
# pipeline was a NO-OP for this beat — do NOT spend the owner's ears on it. Lesson from
# pack-002: both reprises measured −131/−127 dB residual (bit-identical beyond a flat
# −1 dB normalize) and the owner's note was "sounds identical? making me skeptical".


# moved to teardown.render.balance (the audio-metrics home) — reprises AND the fx
# delta gate both use it; thin re-export keeps existing imports working
from teardown.render.balance import gain_aligned_residual_db  # noqa: E402,F401


def load_old_generate(commit: str, scratch: str):
    """The generator as it was for pack-001 — composition identity needs the old code."""
    src = subprocess.run(["git", "-C", REPO, "show", f"{commit}:service/recipes/generate.py"],
                         capture_output=True, text=True, check=True).stdout
    path = os.path.join(scratch, "old_generate.py")
    with open(path, "w") as f:
        f.write(src)
    spec = importlib.util.spec_from_file_location("old_generate", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["old_generate"] = mod   # dataclass decorators resolve via sys.modules
    spec.loader.exec_module(mod)
    return mod


def make_reprises(out_dir: str, binp: str, old_commit: str, scratch: str,
                  start_index: int, n_reprises: int = N_REPRISES) -> list:
    old_G = load_old_generate(old_commit, scratch)
    pack1 = json.load(open(os.path.join(PACK1, "pack.json")))
    by_prefix = {e["pack_file"][:3]: e for e in pack1}
    old_dir = os.path.join(out_dir, "reprise-old")
    os.makedirs(old_dir, exist_ok=True)
    cand_dir = os.path.join(out_dir, "candidates")
    os.makedirs(cand_dir, exist_ok=True)
    library = old_G.load_library(LIB_DIR)
    palette = old_G.load_palette()

    entries = []
    for prefix in REPRISE_PRIORITY:
        if len(entries) >= n_reprises:
            break
        src_entry = by_prefix.get(prefix)
        if not src_entry:
            continue
        req, seed = src_entry["request"], src_entry["seed"]
        cid = f"reprise_p1_{prefix.rstrip('_')}"
        wav = os.path.join(cand_dir, cid + ".wav")
        rec, prov = old_G.generate(req, library_dir=LIB_DIR, seed=seed, palette=palette,
                                   library=library)
        got = {k: os.path.basename(v) for k, v in prov.samples.items()}
        identical = got == src_entry.get("samples")
        if not identical:
            print(f"  ⚠ {cid}: regenerated composition DRIFTED from pack-001 "
                  f"({got} vs {src_entry.get('samples')}) — labeling honestly",
                  file=sys.stderr)
        row = BF.process_candidate(rec, prov, req, seed, cid, wav,
                                   os.path.join(cand_dir, ".w" + cid), binp)
        row["repriseSource"] = {"pack": "pack-001", "file": src_entry["pack_file"],
                                "identicalComposition": identical}
        old_path = os.path.join(PACK1, src_entry["pack_file"])
        if os.path.isfile(old_path) and os.path.isfile(wav):
            row["repriseResidualDb"] = gain_aligned_residual_db(old_path, wav)
        with open(os.path.join(out_dir, "candidates.jsonl"), "a") as f:
            f.write(json.dumps(row) + "\n")
        if row["verdict"] != "pass":
            print(f"  reprise {cid}: {row['verdict']} — mix alone can't save it "
                  f"(the machine agrees with the ear); trying the next candidate",
                  file=sys.stderr)
            continue
        if row.get("repriseResidualDb", 0.0) < REPRISE_MIN_RESIDUAL_DB:
            print(f"  reprise {cid}: pipeline NO-OP for this beat (residual "
                  f"{row['repriseResidualDb']} dB = gain-only change) — not spending "
                  f"the owner's ears on an inaudible A/B; trying the next candidate",
                  file=sys.stderr)
            continue
        old_name = src_entry["pack_file"]
        shutil.copy2(os.path.join(PACK1, old_name), os.path.join(old_dir, old_name))
        idx = start_index + len(entries) + 1
        r = req
        row["pack_file"] = (f"{idx:02d}_reprise_{r['mood']}_{int(r['tempo'])}_"
                            f"{r['key'].replace(' ', '').replace('#', 's')}.wav")
        shutil.copy2(wav, os.path.join(out_dir, row["pack_file"]))
        note = ("same composition, new mix" if identical
                else "same recipe request, regenerated (composition drifted)")
        row["reprise"] = {"of": f"pack-001 #{prefix.rstrip('_')}",
                          "old_file": f"reprise-old/{old_name}", "note": note}
        entries.append(row)
        print(f"  reprise seated: {row['pack_file']} ← pack-001 {old_name} "
              f"(identical={identical}, gap808={row['audibility808']['gapDb']})")
    return entries


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(BEATS, "pack-002"))
    ap.add_argument("--old-commit", default="a746be64")
    ap.add_argument("--pack-size", type=int, default=12)
    ap.add_argument("--skip-factory", action="store_true",
                    help="reuse an existing pack.json from a prior factory run")
    ap.add_argument("--reprises", type=int, default=N_REPRISES,
                    help="reprise slots (0 = none). Reprises only make sense when the "
                         "MIX pipeline changed and the composition can be regenerated "
                         "identically — a generation/library change makes them drifted "
                         "new beats wearing a 'reprise' badge.")
    args = ap.parse_args(argv)
    out_dir = os.path.expanduser(args.out)
    binp = os.environ.get("MOSH_BIN", "").strip() or BF.DEFAULT_BIN
    scratch = os.environ.get("TMPDIR", "/tmp")

    if not args.skip_factory:
        rc = subprocess.run([sys.executable, os.path.join(HERE, "beat_factory.py"),
                             "--out", out_dir, "--pack-size", str(args.pack_size)]).returncode
        if rc != 0:
            print(f"factory failed rc={rc}")
            return rc
    picks = json.load(open(os.path.join(out_dir, "pack.json")))
    picks = [p for p in picks if not p.get("reprise")]  # idempotent re-run

    reprises = []
    if args.reprises > 0:
        reprises = make_reprises(out_dir, binp, args.old_commit, scratch, len(picks),
                                 n_reprises=args.reprises)
    picks += reprises
    with open(os.path.join(out_dir, "pack.json"), "w") as f:
        json.dump(picks, f, indent=1)
    page = BF.build_pack_page(out_dir, picks)
    print(f"pack-002: {len(picks)} beats ({len(reprises)} reprises) → {page}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(None))

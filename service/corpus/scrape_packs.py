#!/usr/bin/env python3
"""Acquire DAW project files (.flp / .als / .rpp) for the Moshi SFT corpus by shallow-
cloning public GitHub repositories into ~/mosh-corpus/<user>_<repo>/.

Idempotent: a repo whose target dir already exists is skipped. This reproduces the
project-file half of the corpus (the MIDI half is service/corpus/get_datasets.sh).
Provenance + licensing notes live in service/corpus/SOURCES.md. Research / non-commercial
use only; cloned files stay local and are never redistributed.

  service/corpus/scrape_packs.py                 # clone the curated set
  CORPUS=~/mosh-corpus service/corpus/scrape_packs.py
  service/corpus/scrape_packs.py --add user/repo  # also clone an extra repo

Note: most large 'free FLP pack' collections fail to parse — PyFLP 2.2.1 raises
NoModelsFound on many FL-Studio versions. The .rpp (Reaper) and .als (Ableton) repos
parse reliably (pure-TS parsers) and are the dependable mixer/structure signal.
"""
import argparse
import os
import subprocess
import sys

# Curated public repos that carry .flp/.als/.rpp (projects + parser test fixtures).
REPOS = [
    # Reaper (.rpp) — pure-TS parser, reliable
    "CharlesHolbrow/rppp", "GriffinSauce/reaper-project-parser", "Perlence/rpp",
    "danielmkarlsson/rpp", "andrewrk/PyDaw", "offlinemark/dawtool",
    # Ableton (.als) — pure-TS parser, reliable
    "danielbayley/Ableton-Live-tools", "kiddikai/ableton-parser",
    # FL Studio (.flp) — PyFLP; fixtures parse, many community packs do not
    "demberto/PyFLP", "YamatoRyou/chiptunes-flp",
    "clrke/flstudio-projects", "numberoneboybiggiefj/FL-Studio-Producer-pack",
    "pepsifx357/FL-Studio-Projects",
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def clone(slug, corpus):
    user, repo = slug.split("/", 1)
    dest = os.path.join(corpus, f"{user}_{repo}")
    if os.path.isdir(dest):
        log(f"  skip {slug} (already at {dest})")
        return True
    log(f"  clone {slug} → {dest}")
    r = subprocess.run(
        ["git", "clone", "--depth", "1", f"https://github.com/{slug}.git", dest],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    if r.returncode != 0:
        log(f"    ⚠ clone failed: {r.stderr.strip().splitlines()[-1] if r.stderr else r.returncode}")
        return False
    return True


def count(corpus):
    n = {"flp": 0, "als": 0, "rpp": 0}
    for root, _dirs, files in os.walk(corpus):
        if os.sep + "midi" in root + os.sep:
            continue
        for f in files:
            ext = f.lower().rsplit(".", 1)[-1] if "." in f else ""
            if ext in n:
                n[ext] += 1
    return n


def main():
    ap = argparse.ArgumentParser(description="Clone DAW-project repos into the Moshi corpus")
    ap.add_argument("--add", action="append", default=[], help="extra user/repo to clone")
    ap.add_argument("--corpus", default=os.environ.get("CORPUS", os.path.expanduser("~/mosh-corpus")))
    a = ap.parse_args()
    os.makedirs(a.corpus, exist_ok=True)
    log(f"— Mosh corpus: DAW project repos → {a.corpus} —")
    ok = 0
    for slug in REPOS + a.add:
        ok += clone(slug, a.corpus)
    n = count(a.corpus)
    log(f"\n✓ {ok}/{len(REPOS) + len(a.add)} repo(s) present. project files: "
        f".flp={n['flp']}  .als={n['als']}  .rpp={n['rpp']}")
    log("  next: cd ui && npm run build-sft -- --corpus ~/mosh-corpus --backtranslate ...")


if __name__ == "__main__":
    main()

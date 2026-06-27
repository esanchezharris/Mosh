#!/usr/bin/env bash
# Fetch the CC-BY MIDI datasets into ~/mosh-corpus/midi/. Idempotent: skips a dataset
# whose target dir already has files. These are the rights-clean volume backbone of the
# Moshi SFT corpus (note-population signal). See service/corpus/SOURCES.md for provenance.
#
#   service/corpus/get_datasets.sh            # both datasets
#   CORPUS=~/mosh-corpus service/corpus/get_datasets.sh
set -euo pipefail

CORPUS="${CORPUS:-$HOME/mosh-corpus}"
MIDI="$CORPUS/midi"
mkdir -p "$MIDI/lakh" "$MIDI/groove"

say() { printf '  %s\n' "$*"; }
have() { [ -n "$(find "$1" -type f -iname '*.mid' 2>/dev/null | head -1)" ]; }

printf '— Mosh corpus: MIDI datasets → %s —\n' "$MIDI"

# 1. Lakh MIDI (LMD-full, 176,581 files, CC-BY 4.0)
LAKH_URL="http://hog.ee.columbia.edu/craffel/lmd/lmd_full.tar.gz"
if have "$MIDI/lakh"; then
  say "Lakh: already present ($(find "$MIDI/lakh" -iname '*.mid' | wc -l | tr -d ' ') files) — skip"
else
  say "Lakh: downloading lmd_full.tar.gz (~1.6 GB) …"
  curl -fL --retry 3 -o "$MIDI/lmd_full.tar.gz" "$LAKH_URL"
  say "Lakh: extracting …"
  tar -xzf "$MIDI/lmd_full.tar.gz" -C "$MIDI/lakh" --strip-components=1
  rm -f "$MIDI/lmd_full.tar.gz"
  say "Lakh: $(find "$MIDI/lakh" -iname '*.mid' | wc -l | tr -d ' ') files"
fi

# 2. Groove MIDI (midi-only, CC-BY 4.0)
GROOVE_URL="https://storage.googleapis.com/magentadata/datasets/groove/groove-v1.0.0-midionly.zip"
if have "$MIDI/groove"; then
  say "Groove: already present — skip"
else
  say "Groove: downloading groove-v1.0.0-midionly.zip …"
  curl -fL --retry 3 -o "$MIDI/groove.zip" "$GROOVE_URL"
  unzip -q -o "$MIDI/groove.zip" -d "$MIDI/groove"
  rm -f "$MIDI/groove.zip"
  say "Groove: $(find "$MIDI/groove" -iname '*.mid' | wc -l | tr -d ' ') files"
fi

printf '\n✓ MIDI corpus ready under %s\n' "$MIDI"
printf '  next: service/corpus/scrape_packs.py   (DAW project files: .flp/.als/.rpp)\n'

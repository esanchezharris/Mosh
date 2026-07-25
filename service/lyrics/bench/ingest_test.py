#!/usr/bin/env python3
"""Golden tests for the PURE half of corpus ingestion (FMS lyrics-bench I1).

The network half (HF snapshot pull) is CLI-only and never runs here. row_to_song
is the filter/normalize seam every raw row passes through — genre/language gates,
line-count bounds, column-name tolerance (tag vs genre, lyrics vs text), and the
eval-only license tier for third-party rows.

Run:  python3 service/lyrics/bench/ingest_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import ingest  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


LYRICS_OK = "\n".join([f"[Verse]\ninvented fixture line number {i} for the ingest gate"
                       if i == 0 else f"invented fixture line number {i} for the ingest gate"
                       for i in range(10)])

ROW = {"id": 42, "title": "Fixture Cut", "artist": "Ingest Fixture", "tag": "rap",
       "language": "en", "views": 5150, "lyrics": LYRICS_OK}

song = ingest.row_to_song(ROW, source="genius-cleaned")
check("accepts a rap/en row", song is not None)
check("songId derived from source id", song["songId"] == "gd:42", song["songId"])
check("third-party rows are eval-only", song["licenseTier"] == "eval-only")
check("views + identity carried", song["views"] == 5150 and song["artist"] == "Ingest Fixture")
check("sections normalized via segment", song["sections"][0]["kind"] == "verse"
      and len(song["sections"][0]["lines"]) == 10)

check("genre synonyms accepted (hip-hop / Hip Hop)",
      ingest.row_to_song({**ROW, "tag": "Hip-Hop"}, source="genius-cleaned") is not None
      and ingest.row_to_song({**ROW, "tag": "hip hop"}, source="genius-cleaned") is not None)
check("non-rap genre rejected",
      ingest.row_to_song({**ROW, "tag": "country"}, source="genius-cleaned") is None)
check("non-English rejected",
      ingest.row_to_song({**ROW, "language": "fr"}, source="genius-cleaned") is None)
check("column tolerance: genre/lang/text aliases work",
      ingest.row_to_song({"id": 7, "title": "T", "artist": "A", "genre": "rap",
                          "lang": "en", "views": 1, "text": LYRICS_OK},
                         source="genius-5m") is not None)

short = "\n".join(["only three lines", "of fixture text", "too short to keep"])
check("too-short songs rejected",
      ingest.row_to_song({**ROW, "lyrics": short}, source="genius-cleaned") is None)
long_txt = "\n".join([f"line {i}" for i in range(300)])
check("too-long songs rejected",
      ingest.row_to_song({**ROW, "lyrics": long_txt}, source="genius-cleaned") is None)
check("missing lyric text rejected",
      ingest.row_to_song({**ROW, "lyrics": ""}, source="genius-cleaned") is None)

check("determinism: 3x identical",
      all(ingest.row_to_song(ROW, source="genius-cleaned") == song for _ in range(3)))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

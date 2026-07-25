"""Corpus ingestion (FMS lyrics-bench I1).

PURE half (tested, stdlib-only): row_to_song — the filter/normalize seam every raw
dataset row passes through. IMPURE half (CLI-only, runs under the lyrics-bench
venv): pull_genius downloads the HF dataset and streams rows through row_to_song
into shard files under the data root. The network half is never imported by tests.

Third-party rows are licenseTier "eval-only"; the owner's catalog and synthetic
verses are "train-ok" (personal-research posture recorded in the design spec —
corpus stays outside git, never ships).
"""
from __future__ import annotations

import json
import os
from typing import Dict, Iterable, Optional

from lyrics.bench import paths, segment

_RAP_TAGS = {"rap", "hip-hop", "hip hop", "hiphop", "rb", "trap", "drill", "grime"}
MIN_LINES, MAX_LINES = 8, 250

_ID_PREFIX = {"genius-cleaned": "gd", "genius-5m": "g5", "own": "own",
              "synthetic": "syn", "pd": "pd"}


def _first(row: Dict, *names, default=None):
    for n in names:
        if n in row and row[n] not in (None, ""):
            return row[n]
    return default


def row_to_song(row: Dict, *, source: str) -> Optional[dict]:
    genre = str(_first(row, "tag", "genre", default="")).strip().lower()
    if genre.replace("_", " ").replace("-", " ").replace("  ", " ") not in \
            {t.replace("-", " ") for t in _RAP_TAGS}:
        return None
    lang = str(_first(row, "language", "lang", default="")).strip().lower()
    if lang not in ("en", "english"):
        return None
    text = _first(row, "lyrics", "text", "lyric", default="")
    if not text or not str(text).strip():
        return None
    rid = _first(row, "id", "song_id", "songId", default=None)
    if rid is None:
        return None
    song = segment.make_song(
        song_id=f"{_ID_PREFIX.get(source, 'xx')}:{rid}",
        source=source,
        artist=str(_first(row, "artist", "artist_name", default="")),
        title=str(_first(row, "title", "song", default="")),
        genre="rap",
        views=int(_first(row, "views", "view_count", default=0) or 0),
        license_tier="eval-only",
        raw_text=str(text),
    )
    n_lines = sum(len(s["lines"]) for s in song["sections"])
    if not MIN_LINES <= n_lines <= MAX_LINES:
        return None
    return song


# ── impure CLI half (venv-only; never imported by tests) ─────────────────────────

def write_shards(songs: Iterable[dict], out_dir: str, prefix: str,
                 shard_size: int = 5000) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    counts = {"songs": 0, "shards": 0}
    buf = []

    def flush():
        if not buf:
            return
        path = os.path.join(out_dir, f"{prefix}-{counts['shards']:04d}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for s in buf:
                f.write(json.dumps(s, ensure_ascii=False, sort_keys=True) + "\n")
        counts["shards"] += 1
        buf.clear()

    for s in songs:
        buf.append(s)
        counts["songs"] += 1
        if len(buf) >= shard_size:
            flush()
    flush()
    return counts


def pull_genius(dataset: str = "cleaned", limit: int = 0) -> dict:
    """Download + filter the HF Genius dataset into corpus shards. Runs under the
    lyrics-bench venv (needs `datasets`). Column values are checked against the
    REAL data, with a census of what got filtered."""
    from datasets import load_dataset  # heavy import, venv-only

    repo = ("Dr3dre/Genius-song-lyrics-cleaned" if dataset == "cleaned"
            else "sebastiandizon/genius-song-lyrics")
    source = "genius-cleaned" if dataset == "cleaned" else "genius-5m"
    ds = load_dataset(repo, split="train", streaming=True)

    census = {"seen": 0, "kept": 0}
    tag_census: Dict[str, int] = {}

    def gen():
        for row in ds:
            census["seen"] += 1
            tag = str(_first(row, "tag", "genre", default="?")).lower()
            tag_census[tag] = tag_census.get(tag, 0) + 1
            song = row_to_song(dict(row), source=source)
            if song is not None:
                census["kept"] += 1
                yield song
            if limit and census["kept"] >= limit:
                return

    out_dir = paths.subdir("corpus", "genius")
    counts = write_shards(gen(), out_dir, source)
    report = {**counts, **census,
              "tagCensus": dict(sorted(tag_census.items(), key=lambda kv: -kv[1])[:15]),
              "repo": repo, "outDir": out_dir}
    with open(os.path.join(out_dir, "ingest_report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=1, sort_keys=True)
    return report


def pull_own() -> dict:
    """The owner's catalog: style_corpus.jsonl lines grouped by source into
    pseudo-songs, plus whole songs dropped into <data>/inbox/*.txt."""
    songs = []
    corpus_dir = os.environ.get("MOSH_LYRIC_CORPUS_DIR") or os.path.expanduser(
        "~/Library/Mosh/lyrics")
    sc = os.path.join(corpus_dir, "style_corpus.jsonl")
    if os.path.exists(sc):
        by_source: Dict[str, list] = {}
        with open(sc, encoding="utf-8") as f:
            for ln in f:
                if not ln.strip():
                    continue
                rec = json.loads(ln)
                by_source.setdefault(rec.get("source") or "inline", []).append(
                    rec.get("text", ""))
        for src, lines in sorted(by_source.items()):
            raw = "\n".join(lines)
            song = segment.make_song(song_id=f"own:{src}", source="own",
                                     artist="Owner", title=src, genre="rap",
                                     views=0, license_tier="train-ok", raw_text=raw)
            if sum(len(s["lines"]) for s in song["sections"]) >= 4:
                songs.append(song)
    inbox = os.path.join(paths.data_root(), "inbox")
    if os.path.isdir(inbox):
        for name in sorted(os.listdir(inbox)):
            if not name.endswith(".txt"):
                continue
            with open(os.path.join(inbox, name), encoding="utf-8") as f:
                raw = f.read()
            stem = os.path.splitext(name)[0]
            songs.append(segment.make_song(song_id=f"own:{stem}", source="own",
                                           artist="Owner", title=stem, genre="rap",
                                           views=0, license_tier="train-ok",
                                           raw_text=raw))
    out_dir = paths.subdir("corpus", "own")
    counts = write_shards(songs, out_dir, "own")
    return {**counts, "outDir": out_dir}

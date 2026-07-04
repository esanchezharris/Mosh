#!/usr/bin/env python3
"""Reference-track fetcher — the embed-only lane for music the owner loves.

Reads ~/mosh-taste/refs/links.txt (one YouTube/playlist URL per line, `#`
comments), pulls audio locally with yt-dlp (the same tooling as the approved
FX-KB pilot), embeds it via embed_store's corpus pass, then DELETES the audio.
What persists: CLAP+MuQ vectors in the embed store + a corpus.jsonl manifest
row carrying the url/title with audioDeleted=true. Idempotent per URL.

    python3 scripts/verify-hardware/fetch_refs.py [--keep-audio]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import embed_store as ES  # noqa: E402

REFS = ES.TASTE / "refs"
LINKS = REFS / "links.txt"
FETCH = REFS / ".fetch"


def read_links() -> list:
    if not LINKS.is_file():
        return []
    out = []
    for line in LINKS.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out


def fetched_urls() -> set:
    return {r.get("url") for r in ES.corpus_manifest_rows() if r.get("url")}


def _rewrite_manifest(patch: dict) -> None:
    """patch: path → extra fields to merge into that path's manifest row."""
    rows = ES.corpus_manifest_rows()
    with open(ES.CORPUS_MANIFEST, "w") as f:
        for r in rows:
            extra = patch.get(r.get("path"))
            if extra:
                r = {**r, **extra}
            f.write(json.dumps(r) + "\n")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-audio", action="store_true",
                    help="keep the downloaded audio in refs/.fetch (default: delete)")
    args = ap.parse_args(argv)

    links = read_links()
    if not links:
        print(f"no links in {LINKS} — paste one URL per line")
        return 0
    done = fetched_urls()
    todo = [u for u in links if u not in done]
    if not todo:
        print(f"refs: all {len(links)} links already fetched (idempotent)")
        return 0

    FETCH.mkdir(parents=True, exist_ok=True)
    url_of: dict = {}    # downloaded file path → (url, title)
    for url in todo:
        print(f"fetching {url}")
        before = set(FETCH.glob("*.wav"))
        r = subprocess.run(
            ["yt-dlp", "-x", "--audio-format", "wav", "--restrict-filenames",
             "--no-overwrites", "-o", str(FETCH / "%(id)s__%(title)s.%(ext)s"), url],
            capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            print(f"  yt-dlp failed: {r.stderr.strip().splitlines()[-1] if r.stderr else '?'}",
                  file=sys.stderr)
            continue
        for p in sorted(set(FETCH.glob("*.wav")) - before):
            title = re.sub(r"^[^_]*__", "", p.stem).replace("_", " ")
            url_of[str(p)] = (url, title)
    if not url_of:
        print("nothing downloaded")
        return 1

    # embed (corpus pass walks refs/ incl. .fetch/, source=ref)
    rc = ES.run_corpus()
    if rc != 0:
        return rc

    patch = {p: {"url": u, "title": t, "audioDeleted": not args.keep_audio}
             for p, (u, t) in url_of.items()}
    _rewrite_manifest(patch)
    if not args.keep_audio:
        for p in url_of:
            try:
                os.remove(p)
            except OSError:
                pass
        print(f"refs: embedded {len(url_of)} track(s); audio deleted (embeddings kept)")
    else:
        print(f"refs: embedded {len(url_of)} track(s); audio kept in {FETCH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

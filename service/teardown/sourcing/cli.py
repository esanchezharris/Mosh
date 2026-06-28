#!/usr/bin/env python3
"""CLI: discover beat tutorials (yt-dlp search) → catalog → prescreen → ranked queue.

  discover  --db <path> [--query "<q>" ...] [--max N]   (defaults to a built-in template bank)
  prescreen --db <path> [--batch N]
  queue     --db <path> [--n N] [--min-overall F]
  counts    --db <path>

Emits JSON on stdout (yt-dlp chatter → stderr). Discovery + the real fetch need yt-dlp
installed (service/teardown/setup-teardown.sh --with-sourcing); absent → a clear error.
"""
import json
import os
import sys

_real_stdout = sys.stdout
sys.stdout = sys.stderr  # keep yt-dlp chatter off the JSON channel

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.sourcing import (  # noqa: E402
    Catalog, Scout, YouTubeDataApiSearcher, default_searcher,
)

DEFAULT_TEMPLATES = [
    "how to make a trap beat from scratch",
    "fl studio beat tutorial from scratch",
    "drill beat tutorial start to finish",
    "type beat tutorial fl studio",
    "making a beat from scratch ableton",
]


def _emit(obj, code=0):
    sys.stdout = _real_stdout
    print(json.dumps(obj))
    raise SystemExit(code)


def _add_warning(out: dict, searcher) -> None:
    """Surface a Data-API request error (exception type only — never the key-bearing URL) so an
    all-errored run reads as a warning, not a clean success. No-op when nothing errored / yt-dlp."""
    err = getattr(searcher, "last_error", "")
    if err:
        out["warning"] = (f"data-api request error ({err}) — some/all results may be missing; "
                          "check YOUTUBE_API_KEY validity and network")


def main(argv=None):
    import argparse

    ap = argparse.ArgumentParser(description="§3 sourcing CLI")
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover"); d.add_argument("--db", required=True)
    d.add_argument("--query", action="append", default=[]); d.add_argument("--max", type=int, default=10)
    d.add_argument("--all-licenses", action="store_true",
                   help="Data-API path only: discover ALL licenses (default: CC-only via "
                        "videoLicense=creativeCommon — the genuine server-side CC filter). Ignored "
                        "for the yt-dlp fallback (which is CC-blind on YouTube).")
    p = sub.add_parser("prescreen"); p.add_argument("--db", required=True); p.add_argument("--batch", type=int, default=200)
    p.add_argument("--fetch-license", action="store_true",
                   help="per-video full extract to populate the license for the CC rank-boost. "
                        "NOTE: yt-dlp returns NO license for YouTube (verified) → this is currently "
                        "wasted cost on YT; real CC-preference needs the YouTube Data API. Kept for "
                        "non-YT sources / a future Data-API searcher (the path is tested).")
    q = sub.add_parser("queue"); q.add_argument("--db", required=True); q.add_argument("--n", type=int, default=10)
    q.add_argument("--min-overall", type=float, default=0.0)
    c = sub.add_parser("counts"); c.add_argument("--db", required=True)
    ns = ap.parse_args(argv)

    try:
        cat = Catalog(ns.db)
        if ns.cmd == "discover":
            # Prefer the Data-API searcher when a key is set (genuine, server-side CC filtering);
            # else degrade to yt-dlp (CC-blind on YouTube). cc_filtered tells the caller which it got.
            searcher = default_searcher(cc_only=not ns.all_licenses)
            cc_filtered = isinstance(searcher, YouTubeDataApiSearcher) and searcher.cc_only
            backend = "youtube-data-api" if isinstance(searcher, YouTubeDataApiSearcher) else "yt-dlp"
            if not getattr(searcher, "available", False):
                _emit({"ok": False, "error": "sourcing_unavailable (set YOUTUBE_API_KEY for genuine "
                       "CC filtering, or pip install yt-dlp / run setup-teardown.sh --with-sourcing)"}, 1)
            templates = ns.query or DEFAULT_TEMPLATES
            added = Scout(cat, searcher).discover(templates, ns.max)
            out = {"ok": True, "added": added, "templates": templates, "backend": backend,
                   "cc_filtered": cc_filtered, "counts": cat.counts()}
            _add_warning(out, searcher)  # so an all-errored run isn't reported as a clean success
            _emit(out)
        elif ns.cmd == "prescreen":
            # license fetch is OPT-IN. yt-dlp returns no license for YouTube (verified live) → wasted
            # cost on the yt-dlp fallback; with a YOUTUBE_API_KEY set, default_searcher() returns the
            # Data-API searcher and the per-video fetch resolves the REAL license (videos.list?status).
            searcher = default_searcher()
            n = Scout(cat, searcher).prescreen(ns.batch, fetch_license=ns.fetch_license)
            out = {"ok": True, "screened": n, "counts": cat.counts()}
            _add_warning(out, searcher)
            _emit(out)
        elif ns.cmd == "queue":
            picked = cat.queue(ns.n, ns.min_overall)
            _emit({"ok": True, "queued": [
                {"video_id": v.video_id, "title": v.title, "url": v.url, "license": v.license,
                 "yield_overall": v.yield_overall} for v in picked]})
        elif ns.cmd == "counts":
            _emit({"ok": True, "counts": cat.counts()})
    except SystemExit:
        raise
    except Exception as e:  # never crash; surface as JSON
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()

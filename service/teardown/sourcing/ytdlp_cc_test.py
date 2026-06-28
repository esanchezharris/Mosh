#!/usr/bin/env python3
"""Hermetic test for the NO-KEY Creative-Commons path (§3 — YtDlpSearcher cc_only).

    python3 service/teardown/sourcing/ytdlp_cc_test.py   (exit 0 = all pass)

No network: the yt-dlp extract and the watch-page fetch are injected. Asserts that cc_only
(a) hits YouTube's OWN results page with the `&sp=` Creative-Commons filter (not `ytsearch:`),
(b) labels every returned row `creativeCommon` by construction (server-side filtered), and that
fetch_license scrapes the watch page for the CC marker — all degrading cleanly on failure.
"""
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.sourcing.discover import YtDlpSearcher, default_searcher, YouTubeDataApiSearcher  # noqa: E402

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# 11-char ids (the real YouTube id width the searcher filters on) + a non-video (channel) row.
ENTRIES = {
    "entries": [
        {"id": "abcdefghij1", "title": "How to make a lofi beat from scratch", "channel": "BeatLab",
         "duration": 600, "url": "https://www.youtube.com/watch?v=abcdefghij1"},
        {"id": "abcdefghij2", "title": "Boom bap tutorial", "channel": "BoomCo", "duration": 720},
        {"id": "UCchannelID0000000000", "title": "A Channel (should be dropped)"},  # not 11 chars
    ]
}


def make_extract():
    seen = {}
    def extract(target, max_results):
        seen["target"] = target
        seen["max"] = max_results
        return ENTRIES
    return extract, seen


# ── cc_only builds the &sp= results URL and labels every row CC ────────────────────────────────
extract, seen = make_extract()
s = YtDlpSearcher(cc_only=True, extract=extract)
res = s.search("lofi beat from scratch", 5)
check("cc_only hits YouTube's results page (not ytsearch:)", "results?search_query=" in seen["target"])
check("cc_only sends the Creative-Commons &sp= filter", "sp=" + YtDlpSearcher.CC_SP in seen["target"],
      seen["target"])
check("cc_only labels EVERY returned row creativeCommon (no per-row fetch)",
      res and all(m.license == "creativeCommon" for m in res), str([m.license for m in res]))
check("the non-video (channel) row is dropped (11-char id guard)",
      [m.video_id for m in res] == ["abcdefghij1", "abcdefghij2"], str([m.video_id for m in res]))
check("snippet fields carried", res[0].title.startswith("How to make") and res[0].channel == "BeatLab"
      and res[0].duration_s == 600.0)

# ── default (no cc_only) uses ytsearch: and does NOT force a license ───────────────────────────
extract2, seen2 = make_extract()
s2 = YtDlpSearcher(cc_only=False, extract=extract2)
res2 = s2.search("lofi beat", 5)
check("default mode uses ytsearchN:", seen2["target"].startswith("ytsearch5:"), seen2["target"])
check("default mode does NOT force creativeCommon (CC-blind on YouTube)",
      all(m.license != "creativeCommon" for m in res2), str([m.license for m in res2]))

# ── max_results is honoured ───────────────────────────────────────────────────────────────────
check("search caps to max_results", len(YtDlpSearcher(cc_only=True, extract=extract).search("q", 1)) == 1)

# ── search degrades to [] on extract error ────────────────────────────────────────────────────
def boom_extract(target, mr):
    raise RuntimeError("yt-dlp blew up")
check("search degrades to [] when yt-dlp raises",
      YtDlpSearcher(cc_only=True, extract=boom_extract).search("q", 5) == [])

# ── fetch_license: no-key watch-page scrape (the EXACT license-row marker, not a bare phrase) ──
# Faithful to real pages (verified live): the license ROW carries "...license (reuse allowed)";
# a normal page has no such row; a NON-CC video can still mention "Creative Commons Attribution" in
# its title/description (the spoof the review caught) — that must NOT read as CC.
CC_HTML = '<html>... metadataRowRenderer License: Creative Commons Attribution license (reuse allowed) ...</html>'
STD_HTML = '<html>... a normal watch page, no license row ...</html>'
SPOOF_HTML = ('<html><title>Creative Commons Attribution tutorial (NOT actually CC)</title>'
              '... description mentions Creative Commons Attribution ... no license row ...</html>')

def page(url):
    if "ccVid000000" in url:
        return CC_HTML
    if "spoofVid000" in url:
        return SPOOF_HTML
    return STD_HTML

fl = YtDlpSearcher(page=page)
check("fetch_license CC license-row page → creativeCommon",
      fl.fetch_license("https://www.youtube.com/watch?v=ccVid000000") == "creativeCommon")
check("fetch_license standard page → youtube",
      fl.fetch_license("https://www.youtube.com/watch?v=stdVid00000") == "youtube")
check("fetch_license does NOT trust a bare CC phrase in title/description (spoof → youtube)",
      fl.fetch_license("https://www.youtube.com/watch?v=spoofVid000") == "youtube")

def boom_page(url):
    raise RuntimeError("network down")
check("fetch_license degrades to unknown on fetch error",
      YtDlpSearcher(page=boom_page).fetch_license("https://youtu.be/x") == "unknown")
check("fetch_license empty page → unknown", YtDlpSearcher(page=lambda u: "").fetch_license("https://youtu.be/x") == "unknown")
# SSRF guard: a non-YouTube url yields no video id → no fetch (real _fetch_watch_page, no network).
check("fetch_license refuses a non-YouTube url (no id → no fetch → unknown)",
      YtDlpSearcher().fetch_license("http://169.254.169.254/latest/meta-data") == "unknown")

# ── availability + default_searcher wiring (no key → CC-capable yt-dlp) ────────────────────────
check("injected extract → available True", YtDlpSearcher(extract=extract).available is True)
_saved = {k: os.environ.get(k) for k in ("YOUTUBE_API_KEY", "GOOGLE_API_KEY")}
try:
    os.environ.pop("YOUTUBE_API_KEY", None)
    os.environ.pop("GOOGLE_API_KEY", None)
    ds = default_searcher(cc_only=True)
    check("no key → default_searcher returns a CC-capable yt-dlp searcher",
          isinstance(ds, YtDlpSearcher) and ds.cc_only is True)
    check("--all-licenses (cc_only=False) → yt-dlp without the CC filter",
          default_searcher(cc_only=False).cc_only is False)
    os.environ["YOUTUBE_API_KEY"] = "K"
    check("with key → Data API still preferred", isinstance(default_searcher(), YouTubeDataApiSearcher))
finally:
    for k, v in _saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ── determinism ────────────────────────────────────────────────────────────────────────────────
runs = {tuple((m.video_id, m.license) for m in YtDlpSearcher(cc_only=True, extract=make_extract()[0]).search("q", 5))
        for _ in range(3)}
check("cc search deterministic x3", len(runs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))

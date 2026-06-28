#!/usr/bin/env python3
"""Hermetic test for the YouTube Data API searcher (§3 — genuine CC filtering).

    python3 service/teardown/sourcing/dataapi_test.py   (exit 0 = all pass)

No network: the HTTP transport is injected (`http=`) with canned search.list / videos.list
responses, and every requested URL is captured so we can assert (a) the CC filter param is
actually sent, (b) only the fixed googleapis host is ever hit, (c) pagination + the
videos.list join populate real licenses/durations/captions, (d) search-relevance order
survives the join, and (e) every failure mode degrades (no key / HTTP error → [] / 'unknown').
"""
import os
import sys
from urllib.parse import parse_qs, urlparse

_HERE = os.path.dirname(os.path.abspath(__file__))
_SERVICE = os.path.dirname(os.path.dirname(_HERE))
if _SERVICE not in sys.path:
    sys.path.insert(0, _SERVICE)

from teardown.sourcing.discover import (  # noqa: E402
    YouTubeDataApiSearcher, YtDlpSearcher, default_searcher,
    _video_id_from_url, _iso8601_duration_to_s, _YT_API,
)

fails: list[str] = []


def check(name, cond, extra=""):
    if cond:
        print(f"  ok   {name}")
    else:
        fails.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


# ── canned API responses (the shapes the real Data API returns) ──────────────────────────────
# Search ids are deliberately NON-alphabetical (v2 before v1) so the order assertions can tell
# "preserve relevance order" apart from a "sort by video_id" bug.
SEARCH_PAGES = {
    "": {"items": [{"id": {"videoId": "v2"}}, {"id": {"videoId": "v1"}}], "nextPageToken": "p1"},
    "p1": {"items": [{"id": {"videoId": "v3"}}]},  # no nextPageToken → pagination stops
}
VIDEOS = {
    "v1": {"id": "v1", "snippet": {"title": "How to make a trap beat from scratch in FL Studio",
                                   "channelTitle": "BeatLab", "description": "fl studio serum 808",
                                   "tags": ["trap", "fl studio"]},
           "contentDetails": {"duration": "PT12M30S", "caption": "true"},
           "status": {"license": "creativeCommon"}},
    "v2": {"id": "v2", "snippet": {"title": "Drill tutorial", "channelTitle": "DrillCo"},
           "contentDetails": {"duration": "PT1H2M3S", "caption": "false"},
           "status": {"license": "youtube"}},
    "v3": {"id": "v3", "snippet": {"title": "Lofi beat from scratch", "channelTitle": "LofiLab"},
           "contentDetails": {"duration": "PT3M"}, "status": {"license": "creativeCommon"}},
}


def make_http(*, reverse_hydrate=False):
    """Fake transport over SEARCH_PAGES/VIDEOS; records every URL it is asked for."""
    calls: list[str] = []

    def http(url):
        calls.append(url)
        p = urlparse(url)
        q = parse_qs(p.query)
        if p.path.endswith("/search"):
            return SEARCH_PAGES[q.get("pageToken", [""])[0]]
        if p.path.endswith("/videos"):
            ids = q.get("id", [""])[0].split(",")
            items = [VIDEOS[i] for i in ids if i in VIDEOS]
            if reverse_hydrate:                       # prove search() re-imposes relevance order
                items = list(reversed(items))
            return {"items": items}
        raise AssertionError("unexpected endpoint " + url)

    return http, calls


# ── key gating ───────────────────────────────────────────────────────────────────────────────
check("no key → not available", YouTubeDataApiSearcher(api_key="", http=make_http()[0]).available is False)
check("explicit key → available", YouTubeDataApiSearcher(api_key="K", http=make_http()[0]).available is True)
check("unkeyed search returns [] (never raises)",
      YouTubeDataApiSearcher(api_key="", http=make_http()[0]).search("q", 5) == [])

# ── search + the videos.list join (real license / duration / captions) ─────────────────────────
http, calls = make_http()
s = YouTubeDataApiSearcher(api_key="K", http=http)
res = s.search("trap beat tutorial", 3)
check("search returns all 3 across pages, in search-relevance order (v2,v1,v3 — NOT sorted)",
      [m.video_id for m in res] == ["v2", "v1", "v3"], str([m.video_id for m in res]))
m1 = {m.video_id: m for m in res}
check("license read from videos.list (v1 CC, v2 youtube, v3 CC)",
      m1["v1"].license == "creativeCommon" and m1["v2"].license == "youtube"
      and m1["v3"].license == "creativeCommon",
      f"{m1['v1'].license}/{m1['v2'].license}/{m1['v3'].license}")
check("ISO-8601 durations parsed (750 / 3723 / 180s)",
      (m1["v1"].duration_s, m1["v2"].duration_s, m1["v3"].duration_s) == (750.0, 3723.0, 180.0),
      f"{m1['v1'].duration_s}/{m1['v2'].duration_s}/{m1['v3'].duration_s}")
check("captions flag parsed (v1 true, v2 false, v3 absent→false)",
      m1["v1"].has_captions is True and m1["v2"].has_captions is False and m1["v3"].has_captions is False)
check("snippet fields carried (title/channel/tags/description)",
      m1["v1"].channel == "BeatLab" and m1["v1"].tags == ["trap", "fl studio"]
      and "serum" in m1["v1"].description and m1["v1"].title.startswith("How to make"))
check("url synthesised from id", m1["v2"].url == "https://www.youtube.com/watch?v=v2")

# ── the genuine CC filter is actually sent, and only the API host is ever hit ───────────────────
search_urls = [u for u in calls if "/search?" in u]
check("cc_only sends videoLicense=creativeCommon on every search page",
      search_urls and all("videoLicense=creativeCommon" in u for u in search_urls), str(search_urls))
check("every request hits only the fixed googleapis host", all(u.startswith(_YT_API + "/") for u in calls))
check("api key travels as a query param", all("key=K" in u for u in calls))

# ── cc_only=False drops the filter ─────────────────────────────────────────────────────────────
http2, calls2 = make_http()
YouTubeDataApiSearcher(api_key="K", cc_only=False, http=http2).search("q", 3)
check("cc_only=False omits videoLicense", all("videoLicense" not in u for u in calls2 if "/search?" in u))

# ── search-relevance order survives an out-of-order videos.list join ────────────────────────────
# Non-sorted ids (v2,v1,v3) + a reversed hydrate: rules out BOTH "follow hydrate order" AND
# "sort by video_id" — only a genuine preserve-the-search-order impl yields [v2,v1,v3].
httpR, _ = make_http(reverse_hydrate=True)
resR = YouTubeDataApiSearcher(api_key="K", http=httpR).search("q", 3)
check("order follows search ids (v2,v1,v3) even when videos.list returns reversed",
      [m.video_id for m in resR] == ["v2", "v1", "v3"], str([m.video_id for m in resR]))

# ── fetch_license (the protocol fallback) ──────────────────────────────────────────────────────
fl = YouTubeDataApiSearcher(api_key="K", http=make_http()[0])
check("fetch_license CC video → creativeCommon",
      fl.fetch_license("https://www.youtube.com/watch?v=v1") == "creativeCommon")
check("fetch_license youtube video → youtube",
      fl.fetch_license("https://youtu.be/v2") == "youtube")
check("fetch_license empty url → unknown", fl.fetch_license("") == "unknown")
check("fetch_license without key → unknown",
      YouTubeDataApiSearcher(api_key="", http=make_http()[0]).fetch_license("https://youtu.be/v1") == "unknown")

# ── graceful HTTP failure ──────────────────────────────────────────────────────────────────────
def boom(url):
    raise RuntimeError("network down")

s_boom = YouTubeDataApiSearcher(api_key="K", http=boom)
check("search degrades to [] on HTTP error", s_boom.search("q", 5) == [])
check("HTTP error sets last_error (so a caller can tell error from empty)", bool(s_boom.last_error))
check("last_error stores only the exception TYPE, never the key-bearing url/message",
      s_boom.last_error == "RuntimeError" and "K" not in s_boom.last_error and "key=" not in s_boom.last_error)
fl_boom = YouTubeDataApiSearcher(api_key="K", http=boom)
check("fetch_license degrades to unknown on HTTP error",
      fl_boom.fetch_license("https://youtu.be/v1") == "unknown")
check("fetch_license error also records last_error (type only)", fl_boom.last_error == "RuntimeError")

# ── pagination is BOUNDED even when CC filtering returns sparse/empty pages with a token ─────────
# (the major review finding: videoLicense=creativeCommon can hand back pages carrying a
#  nextPageToken but few/zero usable ids → an unbounded loop would burn 100-quota calls forever)
def make_runaway_http():
    calls = []
    def http(url):
        calls.append(url)
        return {"items": [], "nextPageToken": "always"}  # empty page that never self-terminates
    return http, calls

hr, rcalls = make_runaway_http()
res_runaway = YouTubeDataApiSearcher(api_key="K", http=hr).search("q", 10)
rsearch = [u for u in rcalls if "/search?" in u]
check("empty-page-with-token paging stops immediately (zero-new-ids guard)", len(rsearch) <= 2,
      f"{len(rsearch)} search calls")
check("a fully-empty runaway search still returns [] cleanly", res_runaway == [])

def make_sparse_http():
    """1 usable id per page + a perpetual token → would page forever without the page cap."""
    calls = []
    seq = iter([f"s{i}" for i in range(50)])
    def http(url):
        calls.append(url)
        p = urlparse(url)
        if p.path.endswith("/search"):
            try:
                return {"items": [{"id": {"videoId": next(seq)}}], "nextPageToken": "more"}
            except StopIteration:
                return {"items": []}
        ids = parse_qs(p.query).get("id", [""])[0].split(",")
        return {"items": [{"id": i, "snippet": {}, "contentDetails": {},
                           "status": {"license": "creativeCommon"}} for i in ids]}
    return http, calls

hs, scalls = make_sparse_http()
res_sparse = YouTubeDataApiSearcher(api_key="K", http=hs).search("q", 10)
ssearch = [u for u in scalls if "/search?" in u]
check("sparse CC pages (1 id/page, perpetual token) are page-capped", len(ssearch) <= 4,
      f"{len(ssearch)} search calls")
check("search always requests maxResults=50 (flat 100-unit cost → fewer pages)",
      all("maxResults=50" in u for u in ssearch))

# ── url-id + duration helpers ──────────────────────────────────────────────────────────────────
check("_video_id watch url", _video_id_from_url("https://www.youtube.com/watch?v=abc123") == "abc123")
check("_video_id youtu.be", _video_id_from_url("https://youtu.be/xyz789") == "xyz789")
check("_video_id shorts", _video_id_from_url("https://www.youtube.com/shorts/sh0rt5") == "sh0rt5")
check("_video_id bare id", _video_id_from_url("rnXWr3yhb4o") == "rnXWr3yhb4o")
check("_video_id junk → ''", _video_id_from_url("https://example.com/no-id") == "")
check("iso8601 PT12M30S", _iso8601_duration_to_s("PT12M30S") == 750.0)
check("iso8601 PT1H2M3S", _iso8601_duration_to_s("PT1H2M3S") == 3723.0)
check("iso8601 PT45S", _iso8601_duration_to_s("PT45S") == 45.0)
check("iso8601 day component P1DT2H30M (≥24h videos)", _iso8601_duration_to_s("P1DT2H30M") == 95400.0)
check("iso8601 P0D (live/upcoming) → 0", _iso8601_duration_to_s("P0D") == 0.0)
check("iso8601 empty/garbage → 0", _iso8601_duration_to_s("") == 0.0 and _iso8601_duration_to_s("12:30") == 0.0)

# ── default_searcher picks the backend by key presence ─────────────────────────────────────────
_saved = {k: os.environ.get(k) for k in ("YOUTUBE_API_KEY", "GOOGLE_API_KEY")}
try:
    os.environ.pop("YOUTUBE_API_KEY", None)
    os.environ.pop("GOOGLE_API_KEY", None)
    check("default_searcher without key → yt-dlp", isinstance(default_searcher(), YtDlpSearcher))
    os.environ["YOUTUBE_API_KEY"] = "K"
    ds = default_searcher()
    check("default_searcher with key → Data API + available",
          isinstance(ds, YouTubeDataApiSearcher) and ds.available is True)
finally:
    for k, v in _saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v

# ── determinism ────────────────────────────────────────────────────────────────────────────────
runs = {tuple((m.video_id, m.license, m.duration_s) for m in
              YouTubeDataApiSearcher(api_key="K", http=make_http()[0]).search("q", 3)) for _ in range(3)}
check("search deterministic x3", len(runs) == 1)

print(f"\n{'ALL PASS' if not fails else 'FAILURES: ' + ', '.join(fails)}  ({len(fails)} failure(s))")
sys.exit(len(fails))

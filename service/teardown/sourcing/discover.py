"""Discovery — turn query templates into VideoMeta rows.

Two real backends, both behind the `Searcher` protocol (real/fake split mirrors SA3/transform):
  • `YtDlpSearcher`     — yt-dlp `ytsearchN:`, NO key, but YouTube reports no license (CC-blind).
  • `YouTubeDataApiSearcher` — the Data API v3; the ONLY backend that does GENUINE Creative-Commons
    filtering (`search.list?videoLicense=creativeCommon` is server-side CC-only) and reads the real
    per-video license. Key-gated; absent key → not `available` → callers degrade to yt-dlp.
`FakeSearcher` backs hermetic tests/dev. `default_searcher()` prefers the Data API when keyed.
"""
from __future__ import annotations

import json as _json
import os
import re
from dataclasses import dataclass, field
from typing import Callable, Optional, Protocol
from urllib import parse as _urlparse, request as _urlrequest

from .posture import map_license


@dataclass
class VideoMeta:
    video_id: str
    url: str = ""
    title: str = ""
    channel: str = ""
    duration_s: float = 0.0
    license: str = "unknown"
    description: str = ""
    tags: list[str] = field(default_factory=list)
    chapters: int = 0
    has_captions: bool = False

    def to_dict(self) -> dict:
        return {
            "video_id": self.video_id, "url": self.url, "title": self.title,
            "channel": self.channel, "duration_s": self.duration_s, "license": self.license,
            "description": self.description, "tags": self.tags, "chapters": self.chapters,
            "has_captions": self.has_captions,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "VideoMeta":
        d = d or {}
        return cls(
            video_id=d.get("video_id", ""), url=d.get("url", ""), title=d.get("title", ""),
            channel=d.get("channel", ""), duration_s=float(d.get("duration_s") or 0.0),
            license=d.get("license", "unknown"), description=d.get("description", ""),
            tags=list(d.get("tags") or []), chapters=int(d.get("chapters") or 0),
            has_captions=bool(d.get("has_captions")),
        )


class Searcher(Protocol):
    def search(self, query: str, max_results: int) -> list[VideoMeta]: ...

    def fetch_license(self, url: str) -> str:
        """The real license for one video (search metadata omits it). 'creativeCommon' |
        'youtube' | 'unknown'."""
        ...


class FakeSearcher:
    """Deterministic in-memory searcher (tests/dev): canned metas keyed by query, optional
    per-url licenses for the license-enrichment path."""

    available = True

    def __init__(self, data: dict[str, list[VideoMeta]] | None = None,
                 licenses: dict[str, str] | None = None) -> None:
        self.data = data or {}
        self.licenses = licenses or {}

    def search(self, query: str, max_results: int) -> list[VideoMeta]:
        return list(self.data.get(query, []))[: max(0, max_results)]

    def fetch_license(self, url: str) -> str:
        return self.licenses.get(url, "unknown")


def _meta_from_entry(e: dict) -> VideoMeta:
    vid = e.get("id") or ""
    subs = e.get("subtitles") or {}
    autos = e.get("automatic_captions") or {}
    return VideoMeta(
        video_id=vid,
        url=e.get("webpage_url") or (f"https://www.youtube.com/watch?v={vid}" if vid else ""),
        title=e.get("title") or "",
        channel=e.get("channel") or e.get("uploader") or "",
        duration_s=float(e.get("duration") or 0.0),
        license=map_license(e.get("license")),
        description=e.get("description") or "",
        tags=list(e.get("tags") or []),
        chapters=len(e.get("chapters") or []),
        has_captions=bool(subs or autos),
    )


class YtDlpSearcher:
    """Real searcher via yt-dlp `ytsearchN:`. Gated on the dep (absent → `available` False)."""

    @property
    def available(self) -> bool:
        import importlib.util
        return importlib.util.find_spec("yt_dlp") is not None

    def search(self, query: str, max_results: int) -> list[VideoMeta]:
        import yt_dlp  # type: ignore

        opts = {"quiet": True, "no_warnings": True, "skip_download": True,
                "noplaylist": True, "ignoreerrors": True}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{max(1, max_results)}:{query}", download=False)
        entries = (info or {}).get("entries") or []
        return [_meta_from_entry(e) for e in entries if e and e.get("id")]

    def fetch_license(self, url: str) -> str:
        """A full per-video extract to read the license (ytsearch metadata omits it). Heavier than
        search (one watch-page fetch per video) → call only when CC-preference actually matters.
        Graceful: any failure → 'unknown'."""
        try:
            import yt_dlp  # type: ignore
            opts = {"quiet": True, "no_warnings": True, "skip_download": True,
                    "noplaylist": True, "ignoreerrors": True}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
            return map_license((info or {}).get("license"))
        except Exception:
            return "unknown"


# ── YouTube Data API v3 — genuine CC filtering ────────────────────────────────────────────────
_YT_API = "https://www.googleapis.com/youtube/v3"


def _http_get_json(url: str, timeout: float = 20.0) -> dict:
    """Default transport: GET url → parsed JSON. Raises on transport/HTTP error (callers degrade).
    Injectable so tests run hermetically with no network."""
    req = _urlrequest.Request(url, headers={"Accept": "application/json"})
    with _urlrequest.urlopen(req, timeout=timeout) as r:  # nosec - fixed googleapis host below
        return _json.loads(r.read().decode("utf-8"))


def _video_id_from_url(url_or_id: str) -> str:
    """Pull a YouTube video id from a watch URL, youtu.be/shorts/embed link, or a bare id."""
    if not url_or_id:
        return ""
    s = url_or_id.strip()
    if "://" not in s and "/" not in s and "?" not in s and "=" not in s:
        return s  # already a bare id
    try:
        u = _urlparse.urlparse(s)
    except Exception:
        return ""
    if u.netloc.endswith("youtu.be"):
        return u.path.lstrip("/").split("/")[0]
    if "youtube" in u.netloc:
        q = _urlparse.parse_qs(u.query)
        if q.get("v"):
            return q["v"][0]
        parts = [p for p in u.path.split("/") if p]
        if len(parts) >= 2 and parts[0] in ("shorts", "embed", "v"):
            return parts[1]
    return ""


def _iso8601_duration_to_s(d: str) -> float:
    """ISO-8601 duration → seconds (0.0 on anything unparseable). The Data API gives durations like
    'PT12M30S'; content ≥24h carries a day component ('P1DT2H30M'), and live/upcoming give 'P0D'."""
    if not d or not d.startswith("P"):
        return 0.0
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", d)
    if not m:
        return 0.0
    days, h, mi, s = (int(x) if x else 0 for x in m.groups())
    return float(days * 86400 + h * 3600 + mi * 60 + s)


class YouTubeDataApiSearcher:
    """Real searcher via the YouTube Data API v3 — the only backend that does GENUINE Creative-Commons
    filtering. `search.list?videoLicense=creativeCommon` returns CC-licensed videos SERVER-SIDE (yt-dlp
    can't — it reports no license for YouTube), and a `videos.list` join reads the real license +
    duration + tags + captions onto every row, so the CC rank-boost applies at discovery time with no
    per-row `fetch_license` pass.

    Key-gated: reads `YOUTUBE_API_KEY` / `GOOGLE_API_KEY` (or an explicit `api_key`); with no key
    `available` is False and `default_searcher()`/the CLI fall back to yt-dlp — graceful, never a crash.
    The HTTP transport is injectable (`http=`) so tests are hermetic. Quota note: a `search.list` costs
    100 units (~100 searches/day on the default 10k quota) → discover sparingly; `videos.list` is cheap.
    """

    def __init__(self, api_key: Optional[str] = None, *, cc_only: bool = True,
                 http: Callable[[str], dict] = _http_get_json) -> None:
        self.api_key = api_key or os.environ.get("YOUTUBE_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
        self.cc_only = cc_only
        self._http = http
        # Sticky signal so a caller can tell "found nothing" from "every request errored" (e.g. an
        # invalid key — `available` is True for any key string, so it never falls back to yt-dlp).
        # ONLY the exception TYPE is stored — never str(e), which could echo the key-bearing URL.
        self.last_error = ""

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _get(self, endpoint: str, params: dict) -> dict:
        q = dict(params)
        q["key"] = self.api_key
        url = f"{_YT_API}/{endpoint}?{_urlparse.urlencode(q)}"
        return self._http(url) or {}

    def search(self, query: str, max_results: int) -> list[VideoMeta]:
        """CC-filtered (when cc_only) video metas for one query, in search-relevance order. Graceful:
        no key or any HTTP error → [] (and `last_error` is set so the caller can tell error from empty)."""
        if not self.available:
            return []
        try:
            ids = self._search_ids(query, max_results)
            if not ids:
                return []
            by_id = {m.video_id: m for m in self._hydrate(ids)}
        except Exception as e:
            self.last_error = type(e).__name__  # type only — never str(e) (would echo the key-bearing URL)
            return []
        return [by_id[i] for i in ids if i in by_id]  # preserve relevance order

    def _search_ids(self, query: str, max_results: int) -> list[str]:
        """Collect up to `max_results` video ids, paging the search.list endpoint. BOUNDED: each page
        is a flat 100-quota call, and `videoLicense=creativeCommon` can return pages that carry a
        nextPageToken but few/zero usable ids — so cap the page count and stop the moment a page adds
        nothing new (the runaway guard). maxResults is always 50 (the cost is flat → fewer pages)."""
        ids: list[str] = []
        page = ""
        want = max(1, max_results)
        max_pages = max(2, (want + 49) // 50 + 2)  # ceil(want/50) + slack; hard backstop vs CC-sparse
        for _ in range(max_pages):
            params = {"part": "snippet", "q": query, "type": "video",
                      "maxResults": 50, "safeSearch": "none"}
            if self.cc_only:
                params["videoLicense"] = "creativeCommon"  # the genuine, server-side CC filter
            if page:
                params["pageToken"] = page
            data = self._get("search", params)
            before = len(ids)
            for it in data.get("items", []):
                vid = (it.get("id") or {}).get("videoId")
                if vid and vid not in ids:
                    ids.append(vid)
            page = data.get("nextPageToken") or ""
            if len(ids) >= want or not page or len(ids) == before:
                break  # enough / end-of-results / a page that added nothing (quota-runaway guard)
        return ids[:want]

    def _hydrate(self, ids: list[str]) -> list[VideoMeta]:
        out: list[VideoMeta] = []
        for i in range(0, len(ids), 50):  # videos.list caps at 50 ids/call
            data = self._get("videos", {"part": "snippet,contentDetails,status",
                                        "id": ",".join(ids[i:i + 50])})
            out.extend(self._meta_from_video(it) for it in data.get("items", []) if it.get("id"))
        return out

    @staticmethod
    def _meta_from_video(it: dict) -> VideoMeta:
        vid = it.get("id") or ""
        sn = it.get("snippet") or {}
        cd = it.get("contentDetails") or {}
        st = it.get("status") or {}
        return VideoMeta(
            video_id=vid,
            url=f"https://www.youtube.com/watch?v={vid}" if vid else "",
            title=sn.get("title") or "",
            channel=sn.get("channelTitle") or "",
            duration_s=_iso8601_duration_to_s(cd.get("duration") or ""),
            license=map_license(st.get("license")),
            description=sn.get("description") or "",
            tags=list(sn.get("tags") or []),
            chapters=0,  # the Data API doesn't expose chapter markers
            has_captions=str(cd.get("caption")).lower() == "true",
        )

    def fetch_license(self, url: str) -> str:
        """The real license for one video via `videos.list?part=status`. Graceful: bad url / no key /
        HTTP error → 'unknown'. (With this backend `search` already populates licenses, so this is
        only the protocol fallback.)"""
        vid = _video_id_from_url(url)
        if not vid or not self.available:
            return "unknown"
        try:
            items = self._get("videos", {"part": "status", "id": vid}).get("items") or []
            if items:
                return map_license((items[0].get("status") or {}).get("license"))
        except Exception as e:
            self.last_error = type(e).__name__  # type only — never str(e) (would echo the key-bearing URL)
        return "unknown"


def default_searcher(*, cc_only: bool = True) -> "Searcher":
    """Prefer the Data-API searcher when a key is configured (genuine CC filtering); else yt-dlp.
    Returns the yt-dlp searcher when unkeyed so callers can still surface its `available` state."""
    api = YouTubeDataApiSearcher(cc_only=cc_only)
    return api if api.available else YtDlpSearcher()

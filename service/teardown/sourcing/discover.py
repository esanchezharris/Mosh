"""Discovery — turn query templates into VideoMeta rows. The real path uses yt-dlp's own
search (`ytsearchN:`) so NO Data API key is needed; a FakeSearcher backs hermetic tests
and dev (the real/fake split mirrors the SA3/transform adapters).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

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


class FakeSearcher:
    """Deterministic in-memory searcher (tests/dev): canned metas keyed by query."""

    available = True

    def __init__(self, data: dict[str, list[VideoMeta]] | None = None) -> None:
        self.data = data or {}

    def search(self, query: str, max_results: int) -> list[VideoMeta]:
        return list(self.data.get(query, []))[: max(0, max_results)]


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

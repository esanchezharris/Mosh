from __future__ import annotations

import importlib.util
import json
import os
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from .scout import TutorialCandidate, TutorialProbe, TutorialTemplate, _extract_chapters


@dataclass(frozen=True)
class YouTubeSearchHit:
    video_id: str
    title: str
    description: str
    channel: str
    url: str
    duration_s: int | None = None
    has_captions: bool = False
    license: str = "unknown"
    tags: tuple[str, ...] = ()

    def to_candidate(self, template_id: str = "", probe: TutorialProbe | None = None) -> TutorialCandidate:
        return TutorialCandidate(
            video_id=self.video_id,
            url=self.url,
            title=self.title,
            channel=self.channel,
            description=self.description,
            duration_s=self.duration_s,
            tags=self.tags,
            license=self.license,
            template_id=template_id,
            chapters=_extract_chapters(self.description),
            has_captions=self.has_captions,
            probe=probe or TutorialProbe(),
            metadata={"source": "youtube"},
        )


class YouTubeDataClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://www.googleapis.com/youtube/v3",
        transport: Callable[[str, Mapping[str, Any]], dict[str, Any]] | None = None,
    ):
        self.api_key = api_key or os.environ.get("YOUTUBE_DATA_API_KEY", "").strip()
        self.base_url = base_url.rstrip("/")
        self.transport = transport

    @property
    def available(self) -> bool:
        return bool(self.api_key) or self.transport is not None

    def _get_json(self, endpoint: str, params: Mapping[str, Any]) -> dict[str, Any]:
        params = dict(params)
        params["key"] = self.api_key
        if self.transport is not None:
            return self.transport(endpoint, params)
        url = f"{self.base_url}/{endpoint}?{urllib.parse.urlencode(params, doseq=True)}"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def search(self, template: TutorialTemplate, *, max_results: int = 5, order: str = "relevance") -> list[dict[str, Any]]:
        if not self.available:
            raise RuntimeError("YOUTUBE_DATA_API_KEY is required for discovery")
        payload = self._get_json(
            "search",
            {
                "part": "snippet",
                "type": "video",
                "maxResults": max(1, min(int(max_results), 25)),
                "q": template.query,
                "order": order,
                "safeSearch": "none",
                "fields": "items(id/videoId,snippet(title,description,channelTitle))",
            },
        )
        return payload.get("items", [])

    def videos(self, video_ids: Iterable[str]) -> list[dict[str, Any]]:
        ids = [video_id for video_id in video_ids if video_id]
        if not ids:
            return []
        payload = self._get_json(
            "videos",
            {
                "part": "snippet,contentDetails,status",
                "id": ",".join(ids[:50]),
                "fields": "items(id,snippet(title,description,channelTitle,tags),contentDetails(duration,caption),status(license))",
            },
        )
        return payload.get("items", [])

    def discover(self, template: TutorialTemplate, *, max_results: int = 5) -> list[YouTubeSearchHit]:
        search_items = self.search(template, max_results=max_results)
        hits: list[YouTubeSearchHit] = []
        for item in search_items:
            snippet = item.get("snippet", {})
            video_id = item.get("id", {}).get("videoId", "")
            if not video_id:
                continue
            title = str(snippet.get("title", ""))
            description = str(snippet.get("description", ""))
            channel = str(snippet.get("channelTitle", ""))
            url = f"https://www.youtube.com/watch?v={video_id}"
            hits.append(
                YouTubeSearchHit(
                    video_id=video_id,
                    title=title,
                    description=description,
                    channel=channel,
                    url=url,
                )
            )
        details = {item.get("id", ""): item for item in self.videos(hit.video_id for hit in hits)}
        enriched: list[YouTubeSearchHit] = []
        for hit in hits:
            detail = details.get(hit.video_id, {})
            snippet = detail.get("snippet", {})
            content_details = detail.get("contentDetails", {})
            status = detail.get("status", {})
            license_name = str(status.get("license", "unknown") or "unknown")
            tags = tuple(str(tag).strip() for tag in snippet.get("tags", []) if str(tag).strip())
            duration_s = None
            duration_text = str(content_details.get("duration", ""))
            if duration_text.startswith("PT"):
                duration_s = _parse_iso8601_duration(duration_text)
            caption_state = str(content_details.get("caption", "")).lower()
            enriched.append(
                YouTubeSearchHit(
                    video_id=hit.video_id,
                    title=str(snippet.get("title", hit.title)),
                    description=str(snippet.get("description", hit.description)),
                    channel=str(snippet.get("channelTitle", hit.channel)),
                    url=hit.url,
                    duration_s=duration_s,
                    has_captions=caption_state == "true",
                    license=license_name,
                    tags=tags,
                )
            )
        return enriched


class YtDlpSearchClient:
    def __init__(self, extractor: Callable[[str, int], Mapping[str, Any]] | None = None):
        self.extractor = extractor

    @property
    def available(self) -> bool:
        return self.extractor is not None or importlib.util.find_spec("yt_dlp") is not None

    def _extract(self, target: str, max_results: int) -> Mapping[str, Any]:
        if self.extractor is not None:
            return self.extractor(target, max_results)
        import yt_dlp

        opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "ignoreerrors": True,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(target, download=False) or {}

    def discover(self, template: TutorialTemplate, *, max_results: int = 5) -> list[YouTubeSearchHit]:
        if not self.available:
            raise RuntimeError("yt-dlp is required for keyless discovery")
        capped = max(1, min(int(max_results), 25))
        payload = self._extract(f"ytsearch{capped}:{template.query}", capped)
        entries = payload.get("entries") or []
        hits = []
        for entry in entries:
            if not isinstance(entry, Mapping):
                continue
            hit = _hit_from_ytdlp_entry(entry)
            if hit is not None:
                hits.append(hit)
            if len(hits) >= capped:
                break
        return hits


def _hit_from_ytdlp_entry(entry: Mapping[str, Any]) -> YouTubeSearchHit | None:
    raw_url = str(entry.get("webpage_url") or entry.get("url") or "")
    video_id = str(entry.get("id") or _video_id_from_url(raw_url)).strip()
    if len(video_id) != 11:
        return None
    url = raw_url if raw_url.startswith("http") else f"https://www.youtube.com/watch?v={video_id}"
    return YouTubeSearchHit(
        video_id=video_id,
        title=str(entry.get("title") or ""),
        description=str(entry.get("description") or ""),
        channel=str(entry.get("channel") or entry.get("uploader") or ""),
        url=url,
        duration_s=_coerce_duration_s(entry.get("duration") or entry.get("duration_string")),
        has_captions=bool(entry.get("subtitles") or entry.get("automatic_captions")),
        license="unknown",
        tags=tuple(str(tag).strip() for tag in entry.get("tags", []) if str(tag).strip()),
    )


def _video_id_from_url(value: str) -> str:
    if not value:
        return ""
    if "://" not in value and "/" not in value and "?" not in value:
        return value
    parsed = urllib.parse.urlparse(value)
    if parsed.netloc.endswith("youtu.be"):
        return parsed.path.lstrip("/").split("/")[0]
    if "youtube" in parsed.netloc:
        query = urllib.parse.parse_qs(parsed.query)
        if query.get("v"):
            return query["v"][0]
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 2 and parts[0] in {"shorts", "embed", "v"}:
            return parts[1]
    return ""


def _coerce_duration_s(value: Any) -> int | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if text.startswith("PT"):
        return _parse_iso8601_duration(text)
    if ":" in text:
        total = 0
        for part in text.split(":"):
            if not part.isdigit():
                return None
            total = total * 60 + int(part)
        return total
    return int(text) if text.isdigit() else None


def _parse_iso8601_duration(value: str) -> int:
    total = 0
    number = ""
    units = {"H": 3600, "M": 60, "S": 1}
    for char in value:
        if char.isdigit():
            number += char
            continue
        if char in units and number:
            total += int(number) * units[char]
            number = ""
    return total

"""Targeted Genius scraper for taste-artist material (FMS lyrics-bench I2b).

Why this exists: the HF dump is a ~mid-2022 snapshot (2023 has 255 rap songs,
2024 has 13) and it dropped some artists outright — Ken Carson has 0 rows while
his scene-mates Destroy Lonely and Yeat have 219 and 280. The golden set is
supposed to be the pens the owner rates, so it needs a targeted pull.

Deliberately narrow and polite:
  * only the named artists' own catalogues (features skipped — the point is
    their pen, not their guest verse on someone else's record);
  * song discovery goes through the OFFICIAL API; only the lyric body comes
    from the page;
  * one request per second, and every page is cached to disk so a re-run costs
    nothing and re-scraping is never accidental.

Scraped rows are `licenseTier: eval-only`, land in the same corpus shards, and
flow through the same segmenter/dedup/split machinery as the dump. The material
stays under the data root — local, personal-research only, never redistributed.
"""
from __future__ import annotations

import gzip
import hashlib
import html as _html
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Dict, List, Optional

from lyrics.bench import paths, segment

API = "https://api.genius.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Mosh-lyrics-bench/1.0"

_CONTAINER = re.compile(
    r'<div[^>]*data-lyrics-container="true"[^>]*>(.*?)</div>\s*(?=<div|</body|$)',
    re.S | re.I)
_BR = re.compile(r"<br\s*/?>", re.I)
_TAG = re.compile(r"<[^>]+>")
# Genius pages carry plenty of non-song entries; these are not lyrics.
# Genius renders a banner INSIDE the first lyrics container — contributor count,
# translation links, the "<Title> Lyrics" heading. It is page chrome, and it was
# landing as the song's opening bar until real scraped output was inspected.
# No word boundaries: the banner arrives glued together as
# "82 ContributorsTranslationsУкраїнськаРусский (Russian)Français".
_CHROME_LINE = re.compile(
    r"^(?:\d+\s+Contributor|.*Translations|Read More$|.*\bLyrics$)", re.I)

_NOT_A_SONG = re.compile(
    r"\b(tracklist|album art|artwork|snippet|unreleased|setlist|credits|"
    r"booklet|interview|annotated|tour dates)\b", re.I)


def parse_lyrics_html(page: str) -> str:
    """Lyric text out of a Genius song page. Everything outside the lyrics
    containers is chrome and is dropped."""
    out: List[str] = []
    for block in _CONTAINER.findall(page or ""):
        # Order matters: newlines in the SOURCE are HTML indentation, not line
        # breaks. Flatten them first, then let <br> be the only real break —
        # otherwise every bar becomes its own stanza and the segmenter reads
        # each one as a section boundary.
        block = re.sub(r"\s*\n\s*", " ", block)
        block = _BR.sub("\n", block)
        block = _TAG.sub("", block)
        out.append(_html.unescape(block))
    text = "\n".join(out)
    cleaned: List[str] = []
    for ln in text.splitlines():
        ln = re.sub(r"[ \t]{2,}", " ", ln).strip()
        if not ln and cleaned and not cleaned[-1]:
            continue           # collapse blank runs, keep stanza breaks
        cleaned.append(ln)
    # Only leading lines can be the banner; a match later in the song is lyrics.
    while cleaned and (not cleaned[0] or _CHROME_LINE.match(cleaned[0])):
        cleaned.pop(0)
    return "\n".join(cleaned).strip()


def wants_song(song: dict, artist_lower: str) -> bool:
    """Keep only this artist's OWN songs, and only real songs."""
    primary = ((song.get("primary_artist") or {}).get("name") or "").lower()
    if primary.strip() != artist_lower.strip():
        return False
    return not _NOT_A_SONG.search(song.get("title") or "")


def to_song(meta: dict, page: str) -> Optional[dict]:
    """API metadata + page HTML → a corpus record, or None if it is not usable."""
    text = parse_lyrics_html(page)
    if not text:
        return None
    rec = segment.make_song(
        song_id=f"gs:{meta.get('id')}",
        source="genius-scrape",
        artist=((meta.get("primary_artist") or {}).get("name") or ""),
        title=meta.get("title") or "",
        genre="rap",
        views=int(((meta.get("stats") or {}).get("pageviews")) or 0),
        license_tier="eval-only",
        raw_text=text,
    )
    year = ((meta.get("release_date_components") or {}).get("year"))
    rec["year"] = int(year) if year else None
    n_lines = sum(len(s["lines"]) for s in rec["sections"])
    from lyrics.bench.ingest import MAX_LINES, MIN_LINES
    if not MIN_LINES <= n_lines <= MAX_LINES:
        return None
    return rec


_META_ACCOUNT = re.compile(r"genius|translat|übersetzung|traduc|lyricfind", re.I)


def rank_recent_artists(songs: List[dict], *, top: int = 100,
                        since: int = 2020, min_median_views: int = 5000) -> List[str]:
    """Who is CURRENT, derived from the corpus rather than guessed.

    The dump knows which artists were active up to its 2022 cutoff; Genius has
    their 2023-2025 material. Ranking on recent song count (not all-time volume,
    which crowns whoever has the longest career) turns the dump into a discovery
    index for the scraper. Ties break alphabetically so the list is stable.
    """
    views: Dict[str, List[int]] = {}
    for s in songs:
        year = s.get("year")
        name = (s.get("artist") or "").strip()
        # "Genius English Translations" and friends are upload accounts, not
        # writers — they top a raw song count and would waste the whole scrape.
        if not name or not year or _META_ACCOUNT.search(name):
            continue
        try:
            if int(year) < since:
                continue
        except (TypeError, ValueError):
            continue
        views.setdefault(name, []).append(int(s.get("views") or 0))
    import statistics
    counts = {a: len(v) for a, v in views.items()
              if statistics.median(v) >= min_median_views}
    ordered = sorted(counts, key=lambda a: (-counts[a], a))
    return ordered[:top]


class RateLimiter:
    """A GLOBAL request budget, honoured across worker threads.

    Measured: serial 1/sec was ~1.4 req/s while 8 concurrent workers sustained
    74 req/s with zero errors — the politeness setting was costing ~50x for no
    reason. Concurrency without a shared limiter would just be a stampede, so
    the budget lives here and every worker takes its slot under the lock.
    """

    def __init__(self, min_interval: float = 1.0, clock=time):
        self.min_interval = min_interval
        self.clock = clock
        self._last = None
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = self.clock.time()
            if self._last is not None:
                gap = self.min_interval - (now - self._last)
                if gap > 0:
                    self.clock.sleep(gap)
                    now = self.clock.time()
            self._last = now


class PageCache:
    """Fetched pages are permanent — a re-run must never re-hit the site."""

    def __init__(self, root: str):
        self.root = root

    def _path(self, url: str) -> str:
        key = hashlib.sha256(url.encode("utf-8")).hexdigest()
        return os.path.join(self.root, key[:2], key + ".html")

    def get(self, url: str, fetch: Callable[[str], str]) -> str:
        p = self._path(url)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return f.read()
        body = fetch(url)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(body)
        return body


# ── impure half (CLI only) ──────────────────────────────────────────────────────

def _token() -> Optional[str]:
    tok = os.environ.get("GENIUS_ACCESS_TOKEN")
    if tok:
        return tok
    for cand in (os.environ.get("MOSH_BRAIN_ENV"),
                 os.path.expanduser("~/Mosh/ui/.env.local")):
        if cand and os.path.exists(cand):
            with open(cand, encoding="utf-8") as f:
                for ln in f:
                    m = re.match(r'\s*(?:export\s+)?GENIUS_ACCESS_TOKEN\s*=\s*"?([^"\n]+)',
                                 ln)
                    if m:
                        return m.group(1).strip()
    return None


def _api(path: str, token: str, **params) -> dict:
    url = API + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token,
                                               "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:  # noqa: S310
        return json.loads(r.read().decode("utf-8"))


def _fetch_page(url: str) -> str:
    # gzip: 383 KB -> 92 KB on the wire and ~2.5x faster, measured.
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=45) as r:  # noqa: S310
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    return raw.decode("utf-8", errors="replace")


def scrape_artists(names: List[str], *, max_per_artist: int = 200,
                   min_year: int = 0, sleep: float = 0.12,
                   workers: int = 6) -> dict:
    """Pull each artist's own catalogue into corpus shards. Idempotent: cached
    pages are reused, so re-running costs nothing."""
    token = _token()
    if not token:
        return {"error": "no GENIUS_ACCESS_TOKEN (env or ui/.env.local)"}

    cache = PageCache(paths.subdir("cache", "genius-pages"))
    limiter = RateLimiter(sleep)
    songs: List[dict] = []
    report: Dict[str, dict] = {}

    for name in names:
        lower = name.lower()
        found = kept = skipped_old = 0
        artist_id = None
        try:
            hits = _api("/search", token, q=name)["response"]["hits"]
        except Exception as e:  # noqa: BLE001
            report[name] = {"error": str(e)[:120]}
            continue
        for h in hits:
            pa = h["result"].get("primary_artist") or {}
            if (pa.get("name") or "").lower() == lower:
                artist_id = pa.get("id")
                break
        if not artist_id:
            report[name] = {"error": "artist not found on Genius"}
            continue

        page_no = 1
        while kept < max_per_artist:
            limiter.wait()
            try:
                data = _api(f"/artists/{artist_id}/songs", token, per_page=50,
                            page=page_no, sort="popularity")
            except Exception as e:  # noqa: BLE001
                report.setdefault(name, {})["error"] = str(e)[:120]
                break
            batch = data["response"]["songs"]
            if not batch:
                break
            wanted = []
            for meta in batch:
                found += 1
                if not wants_song(meta, lower) or not meta.get("url"):
                    continue
                year = ((meta.get("release_date_components") or {}).get("year"))
                if min_year and (not year or int(year) < min_year):
                    skipped_old += 1
                    continue
                wanted.append(meta)
            wanted = wanted[:max(0, max_per_artist - kept)]

            def grab(meta):
                limiter.wait()
                try:
                    return meta, cache.get(meta["url"], _fetch_page)
                except Exception:  # noqa: BLE001 — one dead page is not fatal
                    return meta, None

            if wanted:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    for meta, page in pool.map(grab, wanted):
                        if page is None:
                            continue
                        rec = to_song(meta, page)
                        if rec is not None:
                            songs.append(rec)
                            kept += 1

            if not data["response"].get("next_page"):
                break
            page_no += 1
        report[name] = {"seen": found, "kept": kept, "skippedOld": skipped_old}

    from lyrics.bench.ingest import write_shards
    out_dir = paths.subdir("corpus", "genius-scrape")
    counts = write_shards(songs, out_dir, "scrape")
    return {"artists": report, **counts, "outDir": out_dir, "minYear": min_year,
            "workers": workers, "reqInterval": sleep}

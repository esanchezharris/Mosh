#!/usr/bin/env python3
"""Golden tests for the targeted Genius scraper (FMS lyrics-bench I2b).

The HF dump is a ~mid-2022 snapshot (2023 has 255 rap songs, 2024 has 13) and it
dropped some artists entirely — Ken Carson has 0 rows while his scene-mates
Destroy Lonely (219) and Yeat (280) are present. So golden material for the
owner's taste artists has to come from a targeted pull.

Hermetic: every fetch is injected, the fixture HTML is INVENTED (no real lyrics
in git), and nothing here touches the network or the data root.

Run:  python3 service/lyrics/bench/scrape_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import scrape  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# A Genius song page, structurally faithful, lyrics invented for this test.
PAGE = """<html><body>
<div class="SomeHeader">Fixture Artist - Fixture Song Lyrics</div>
<div data-lyrics-container="true" class="Lyrics__Container">
[Intro]<br/>yeah, uh<br/><br/>[Verse 1]<br/>
<a href="/x"><span>counting up the paper in the </span></a>attic<br/>
never let the pressure make me <i>frantic</i><br/>
</div>
every hour on the clock another bag to handle<br/>
kept the same three numbers when they tried to scramble<br/>
</div>
<div data-lyrics-container="true" class="Lyrics__Container">
[Chorus]<br/>run it up, run it up again<br/>
tell 'em run it up, we did it in the rain<br/>
run it up, no ceiling on the gain<br/>
same ones from the bottom on the plane<br/>
</div>
<div class="RightSidebar">unrelated promo text</div>
</body></html>"""

text = scrape.parse_lyrics_html(PAGE)
check("extracts lyrics from every lyrics container",
      "counting up the paper in the attic" in text and "run it up" in text, repr(text))
check("<br/> becomes a line break",
      "attic\nnever let the pressure" in text, repr(text))
check("nested anchors/spans are unwrapped into flowing text",
      "counting up the paper in the attic" in text)
check("inline emphasis is preserved as text", "frantic" in text)
check("section headers survive for the segmenter",
      "[Verse 1]" in text and "[Chorus]" in text)
check("page chrome outside the containers is dropped",
      "unrelated promo" not in text and "SomeHeader" not in text)
check("html entities are decoded",
      "don't" in scrape.parse_lyrics_html(
          '<div data-lyrics-container="true">don&#x27;t stop</div>'))
check("a page with no lyrics container yields empty, not garbage",
      scrape.parse_lyrics_html("<html><body>nothing here</body></html>") == "")

# Real pages open with a contributors/translations banner INSIDE the lyrics
# container — caught by looking at actual scraped output, not by this fixture.
for chrome in ("82 ContributorsTranslationsУкраїнськаРусский (Russian)Français",
               "12 Contributors", "Fixture Song Lyrics", "Read More"):
    got = scrape.parse_lyrics_html(
        f'<div data-lyrics-container="true">{chrome}<br/><br/>'
        f'[Verse]<br/>the first real bar lands here<br/></div>')
    check(f"page chrome stripped: {chrome[:34]}",
          got.startswith("[Verse]") and "Contributor" not in got
          and "Read More" not in got, repr(got[:60]))
check("a lyric line is never mistaken for chrome",
      scrape.parse_lyrics_html(
          '<div data-lyrics-container="true">I wrote this bar myself<br/>'
          'and this one too<br/></div>').startswith("I wrote this bar myself"))

# ---- which songs to keep ----
check("primary-artist match keeps the song",
      scrape.wants_song({"primary_artist": {"name": "Ken Carson"},
                         "title": "Fighting My Demons"}, "ken carson"))
check("feature-only credits are skipped (we want the artist's own pen)",
      not scrape.wants_song({"primary_artist": {"name": "Some Producer"},
                             "title": "Track (feat. Ken Carson)"}, "ken carson"))
for junk in ("Ken Carson - Unreleased Snippet", "Tracklist + Album Art",
             "Ken Carson Setlist", "Album Artwork"):
    check(f"non-song page skipped: {junk[:28]}",
          not scrape.wants_song({"primary_artist": {"name": "Ken Carson"},
                                 "title": junk}, "ken carson"))
check("a normal title is kept",
      scrape.wants_song({"primary_artist": {"name": "Ken Carson"},
                         "title": "Overseas"}, "ken carson"))

# ---- building the corpus record ----
song = scrape.to_song({"id": 999, "title": "Fixture Song",
                       "primary_artist": {"name": "Fixture Artist"},
                       "release_date_components": {"year": 2023},
                       "stats": {"pageviews": 4242}}, PAGE)
check("record carries scrape provenance, not a fake dataset id",
      song["songId"] == "gs:999" and song["source"] == "genius-scrape", str(song["songId"]))
check("record is eval-only like every third-party lyric",
      song["licenseTier"] == "eval-only")
check("year and views come from the API payload",
      song["year"] == 2023 and song["views"] == 4242)
check("sections parsed through the SAME segmenter as the dump",
      [s["kind"] for s in song["sections"]] == ["intro", "verse", "chorus"],
      str([s["kind"] for s in song["sections"]]))
check("too-short pages are rejected like dump rows",
      scrape.to_song({"id": 1, "title": "t", "primary_artist": {"name": "a"}},
                     '<div data-lyrics-container="true">one line</div>') is None)

# ---- polite fetching: cache + rate limit ----
class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def time(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


clock = FakeClock()
limiter = scrape.RateLimiter(min_interval=1.0, clock=clock)
limiter.wait()
clock.t += 0.2
limiter.wait()
check("rate limiter spaces requests", clock.slept and abs(clock.slept[0] - 0.8) < 1e-6,
      str(clock.slept))

import tempfile  # noqa: E402
with tempfile.TemporaryDirectory() as td:
    calls = {"n": 0}

    def fetch(url):
        calls["n"] += 1
        return f"<html>{url}</html>"

    c = scrape.PageCache(td)
    a = c.get("https://genius.com/a", fetch)
    b = c.get("https://genius.com/a", fetch)
    check("page cache: a scraped page is never fetched twice",
          calls["n"] == 1 and a == b)
    check("page cache: a different url does fetch",
          c.get("https://genius.com/b", fetch) and calls["n"] == 2)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

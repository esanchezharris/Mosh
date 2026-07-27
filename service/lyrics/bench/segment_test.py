#!/usr/bin/env python3
"""Golden tests for Genius-text → normalized song segmentation (FMS lyrics-bench I1).

All fixture text below is INVENTED for these tests — no real lyrics anywhere in git.
Pure stdlib; deterministic (run 3x -> identical).

Run:  python3 service/lyrics/bench/segment_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import segment  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# ---- fixture: headered song with artist-suffixed header, hook, scrape artifacts ----
RAW_HEADERED = """[Intro]
yeah, uh

[Verse 1: MC Fixture]
I was down in the basement counting up the rent
every word in my notebook already paid for
they was laughing at the vision, now they beg for a cent
watch me walk up out the function through the trapdoor

[Hook]
run it back, run it back, run it back again
run it back, run it back, run it back again

[Verse 2]
cold nights taught me how to keep the *flame* lit
You might also like
smart quotes don’t survive the cleaner “intact”
    extra   spaces    collapse   to one
last line of the fixture stays cold144Embed"""

secs = segment.parse_sections(RAW_HEADERED)

check("headered: 4 sections parsed", len(secs) == 4, f"got {len(secs)}: {[s['kind'] for s in secs]}")
check("headered: kinds mapped", [s["kind"] for s in secs] == ["intro", "verse", "hook", "verse"],
      str([s["kind"] for s in secs]))
check("headered: label keeps full bracket text", secs[1]["label"] == "Verse 1: MC Fixture",
      repr(secs[1].get("label")))
check("headered: verse1 has 4 lines", len(secs[1]["lines"]) == 4, str(secs[1]["lines"]))
check("headered: 'You might also like' line dropped",
      all("You might also like" not in ln for s in secs for ln in s["lines"]))
check("headered: Embed suffix stripped",
      secs[3]["lines"][-1] == "last line of the fixture stays cold",
      repr(secs[3]["lines"][-1]))
check("headered: smart quotes normalized",
      secs[3]["lines"][1] == "smart quotes don't survive the cleaner \"intact\"",
      repr(secs[3]["lines"][1]))
check("headered: internal whitespace collapsed",
      secs[3]["lines"][2] == "extra spaces collapse to one", repr(secs[3]["lines"][2]))
check("headered: inline asterisk emphasis preserved",
      secs[3]["lines"][0] == "cold nights taught me how to keep the *flame* lit",
      repr(secs[3]["lines"][0]))

# ---- register preservation: profane/slang line survives byte-identical ----
RAW_REGISTER = """[Verse]
fuck the middleman, I keep the whole check with me
shorty know the drip too cold, hunnid on the fit, gee"""
reg = segment.parse_sections(RAW_REGISTER)
check("register: profane line survives byte-identical",
      reg[0]["lines"][0] == "fuck the middleman, I keep the whole check with me",
      repr(reg[0]["lines"][0]))
check("register: slang line survives byte-identical",
      reg[0]["lines"][1] == "shorty know the drip too cold, hunnid on the fit, gee")

# ---- headerless song: blank-line split, default kind=verse ----
RAW_HEADERLESS = """first stanza opens with a plain line
second line keeps the meter tight

second stanza after a blank line
closing line of the fixture song"""
hl = segment.parse_sections(RAW_HEADERLESS)
check("headerless: 2 sections", len(hl) == 2, str(len(hl)))
check("headerless: default kind verse + empty label",
      all(s["kind"] == "verse" and s["label"] == "" for s in hl))

# ---- stage-direction-only lines dropped; empty sections dropped ----
RAW_STAGE = """[Verse]
*crowd noise*
real line stays here

[Bridge]
*long instrumental*
"""
st = segment.parse_sections(RAW_STAGE)
check("stage directions: *only* lines dropped, section survives",
      len(st) == 1 and st[0]["lines"] == ["real line stays here"], str(st))

# ---- make_song record shape ----
song = segment.make_song(song_id="fx:1", source="fixture", artist="MC Fixture",
                         title="Basement Rent", genre="rap", views=1234,
                         license_tier="eval-only", raw_text=RAW_HEADERED)
check("make_song: identity fields", song["songId"] == "fx:1" and song["artist"] == "MC Fixture"
      and song["licenseTier"] == "eval-only" and song["views"] == 1234)
check("make_song: sections attached", [s["kind"] for s in song["sections"]] ==
      ["intro", "verse", "hook", "verse"])
check("make_song: content hash present + stable",
      song["hash"] == segment.make_song(song_id="fx:1", source="fixture", artist="MC Fixture",
                                        title="Basement Rent", genre="rap", views=1234,
                                        license_tier="eval-only", raw_text=RAW_HEADERED)["hash"]
      and song["hash"].startswith("sha1:"))

# ---- determinism: 3x identical ----
det = all(segment.parse_sections(RAW_HEADERED) == secs for _ in range(3))
check("determinism: parse_sections 3x identical", det)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

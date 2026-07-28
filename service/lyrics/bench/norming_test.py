#!/usr/bin/env python3
"""Golden tests for the norming packet (FMS WS1 / M5d).

Run:  python3 service/lyrics/bench/norming_test.py     (exit 0 = all pass)
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

os.environ["MOSH_LYRICS_BENCH_DIR"] = tempfile.mkdtemp()

from lyrics.bench import norming as N  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def item(n, song="gs:1", li=2):
    return {"itemId": f"v2:rhyme:{song}:s0:l{li}-{n}", "granularity": "rhyme",
            "songId": song, "si": 0, "li": li, "sectionKind": "verse",
            "target": {"text": f"word{n}"},
            "context": {"before": ["window before"], "maskedLine": f"bar {n} ____",
                        "after": ["window after"]},
            "constraints": {"syllables": 1, "syllableTol": 0, "rhymeWith": "mind",
                            "rhymeStrictness": "slant"}}


ITEMS = [item(i, song=f"gs:{i % 7}") for i in range(40)]
SONGS = {f"gs:{i}": {"songId": f"gs:{i}", "sections": [
    {"kind": "verse", "lines": [f"real line {j} of song {i}" for j in range(6)]}]}
    for i in range(7)}

with tempfile.TemporaryDirectory() as td:
    pdir = os.path.join(td, "packet")
    apath = os.path.join(td, "answers.json")
    rep = N.export(ITEMS, SONGS, out_dir=pdir, answers_path=apath, n=12)

    packet = json.load(open(os.path.join(pdir, "packet.json"), encoding="utf-8"))
    answers = json.load(open(apath, encoding="utf-8"))
    txt = open(os.path.join(pdir, "packet.txt"), encoding="utf-8").read()

    check("export: emits the requested number of items", rep["n"] == 12, str(rep["n"]))
    # THE property: the packet must not contain the answers anywhere.
    # Scan BOTH rater-facing artifacts for the answer VALUES, not for known field
    # names: a leak under any other key ("leak", "truth", "gold") would walk past a
    # name-based check, and one did — this is the version that caught it.
    packet_blob = json.dumps(packet, ensure_ascii=False)
    leaked_txt = [a["answer"] for a in answers["answers"] if a["answer"] in txt]
    leaked_json = [a["answer"] for a in answers["answers"]
                   if f'"{a["answer"]}"' in packet_blob]
    check("BLIND: no answer VALUE appears in the rater-facing packet.txt",
          not leaked_txt, str(leaked_txt[:3]))
    check("BLIND: no answer VALUE appears in packet.json either",
          not leaked_json, str(leaked_json[:3]))
    check("BLIND: and no answer-shaped field name is present",
          "answer" not in packet_blob and "target" not in packet_blob)
    check("export: the answer key lives OUTSIDE the packet directory",
          not os.path.abspath(apath).startswith(os.path.abspath(pdir) + os.sep))
    # Fixture adequacy: the answers are non-empty strings that COULD have leaked.
    check("blind fixture: the answers are real strings that could have leaked",
          all(a["answer"] for a in answers["answers"]))

    check("context: the packet uses the FULL section, not the item window",
          all(i["scope"] == "full-section" for i in packet["items"]),
          str({i["scope"] for i in packet["items"]}))
    check("context: the real surrounding lines are present",
          "real line 0 of song" in txt)
    check("stratification: skipped, with the reason recorded",
          packet["stratification"]["applied"] is False
          and "verse" in packet["stratification"]["reason"])
    check("export: an answer sheet is emitted for the rater to fill in",
          os.path.exists(os.path.join(pdir, "ANSWER-SHEET.txt")))

    # determinism: three raters must see the same items
    with tempfile.TemporaryDirectory() as td2:
        p2 = os.path.join(td2, "p")
        N.export(ITEMS, SONGS, out_dir=p2, answers_path=os.path.join(td2, "a.json"), n=12)
        check("determinism: a re-export is byte-identical (raters can be pooled)",
              open(os.path.join(p2, "packet.txt"), encoding="utf-8").read() == txt)

    # refuses to co-locate the answers
    boom = False
    try:
        N.export(ITEMS, SONGS, out_dir=pdir,
                 answers_path=os.path.join(pdir, "answers.json"), n=5)
    except ValueError:
        boom = True
    check("BLIND: writing the key inside the packet dir is REFUSED", boom)

# ---- sheet parsing + scoring ----
ANS = [{"no": 1, "itemId": "a", "answer": "grind"},
       {"no": 2, "itemId": "b", "answer": "shine"},
       {"no": 3, "itemId": "c", "answer": "gold"},
       {"no": 4, "itemId": "d", "answer": "cold"}]
sheet = N.parse_sheet("""
# a comment
1 = grind
2 = money, shine, chrome
3 = wrong
4 =
""")
check("parse: numbers map to comma-separated guesses",
      sheet == {1: ["grind"], 2: ["money", "shine", "chrome"], 3: ["wrong"]}, str(sheet))
sc = N.score(sheet, ANS, rater="owner")
check("score: exact counts only the FIRST guess", sc["exact"] == 1 / 3, str(sc["exact"]))
check("score: top-5 counts any of the guesses", sc["topk"] == 2 / 3, str(sc["topk"]))
check("score: unanswered items are reported as skipped, not scored",
      sc["answered"] == 3 and sc["skipped"] == 1, str(sc))
check("score: an of-all figure is given too, so skipping cannot flatter",
      sc["exactOfAll"] == 1 / 4, str(sc["exactOfAll"]))
check("score: casing and punctuation are normalized like the arms' metrics",
      N.score(N.parse_sheet("1 = Grind!"), ANS[:1])["exact"] == 1.0)

pooled = N.pool([{"exact": 0.30, "topk": 0.5}, {"exact": 0.50, "topk": 0.7},
                 {"exact": 0.40, "topk": 0.6}])
check("pool: reports the mean AND the spread across raters",
      abs(pooled["exactMean"] - 0.4) < 1e-9 and abs(pooled["spread"] - 0.2) < 1e-9,
      str(pooled))
check("pool: names what it replaces", "64.7" in pooled["replaces"])
check("pool: no raters gives None, not a fabricated ceiling",
      N.pool([])["ceiling"] is None)

# ---- give-away detection (found on the first REAL 200-item export) ----
# The synthetic songs above never repeat the answer at a line end, so the whole
# mechanism was invisible to this suite until real data showed 10% of items
# handing the rater the answer. These fixtures carry the case explicitly.
_ctx_give = {"before": ["i was counting up the gold", "nothing ever got me cold"],
             "after": ["and it never got me told"]}
_ctx_mid = {"before": ["the gold was never on my mind"], "after": ["so i had to grind"]}
check("giveaway: flagged when the answer is another line's END word",
      N.is_giveaway("cold", _ctx_give))
check("giveaway: NOT flagged when it merely appears mid-line",
      not N.is_giveaway("gold", _ctx_mid),
      "writing inside your own verse is the normal case; excluding it would "
      "understate the ceiling")
check("giveaway: case and punctuation do not fool it",
      N.is_giveaway("Cold!", _ctx_give))
check("giveaway: empty context is not a give-away",
      not N.is_giveaway("cold", {"before": [], "after": []}))

# It must reach the ANSWER key and never the packet.
with tempfile.TemporaryDirectory() as td:
    # Explicit: each item lives in its OWN song whose line 0 ends on that item's
    # answer, so every drawn item is a give-away by construction. Built this way
    # after a version that relied on the draw happening to pick the right item
    # produced zero of them.
    GITEMS = [dict(item(i, song=f"gv:{i}"), target={"text": f"word{i}"})
              for i in range(6)]
    GSONGS = {f"gv:{i}": {"songId": f"gv:{i}", "sections": [
        {"kind": "verse", "lines": [f"a line ending word{i}", "another one here",
                                    f"third line goes word{i}", "fourth line",
                                    "fifth", "sixth"]}]} for i in range(6)}
    pd = os.path.join(td, "p"); ap = os.path.join(td, "a.json")
    rep = N.export(GITEMS, GSONGS, out_dir=pd, answers_path=ap, n=6)
    ans = json.load(open(ap, encoding="utf-8"))["answers"]
    pk = open(os.path.join(pd, "packet.json"), encoding="utf-8").read()
    check("giveaway: the flag is recorded on the withheld answers",
          all("giveaway" in a for a in ans))
    check("giveaway: the flag NEVER reaches the rater-facing packet",
          "giveaway" not in pk,
          "telling the rater which items are easy is its own contamination")
    check("giveaway: the export reports the rate so a sitting can be judged",
          "giveawayRate" in rep and rep["giveaways"] >= 1, str(rep.get("giveaways")))

# Scoring reports the ceiling BOTH ways.
GA = [{"no": 1, "itemId": "a", "answer": "grind", "giveaway": True},
      {"no": 2, "itemId": "b", "answer": "shine", "giveaway": False},
      {"no": 3, "itemId": "c", "answer": "gold", "giveaway": False}]
sg = N.score(N.parse_sheet("1 = grind\n2 = wrong\n3 = wrong"), GA)
check("score: overall exact includes give-aways", abs(sg["exact"] - 1 / 3) < 1e-9,
      str(sg["exact"]))
check("score: exactExGiveaway excludes them (the honest ceiling)",
      sg["exactExGiveaway"] == 0.0 and sg["giveawayItems"] == 1, str(sg))
check("pool: the ceiling is based on the give-away-excluded figure",
      "give-away" in N.pool([{"exact": 0.9, "exactExGiveaway": 0.4, "topk": 0.5}])["basis"]
      and abs(N.pool([{"exact": 0.9, "exactExGiveaway": 0.4,
                       "topk": 0.5}])["exactMean"] - 0.4) < 1e-9)

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

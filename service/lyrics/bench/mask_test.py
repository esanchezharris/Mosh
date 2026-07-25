#!/usr/bin/env python3
"""Golden tests for the 4 masking policies (FMS lyrics-bench I1).

Hermetic: injected lexicon (never loads cmudict/g2p), synthetic fixture corpus only,
seeded per-item RNG — run 3x -> byte-identical items.

The two directions that make the rhyme policy non-vacuous:
  - a stanza with NO rhyming end-words must yield ZERO rhyme items;
  - a stanza with a clean rhyme group MUST yield rhyme items with the partner recorded.

Run:  python3 service/lyrics/bench/mask_test.py     (exit 0 = all pass)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import mask  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


PRON = make_pron()

with open(os.path.join(HERE, "fixtures", "synthetic_songs.jsonl"), encoding="utf-8") as f:
    SONGS = [json.loads(ln) for ln in f if ln.strip()]
BY_ID = {s["songId"]: s for s in SONGS}

FREQ = mask.build_freq_table(SONGS)
check("freq table: common word has higher df than rare word",
      FREQ.get("the", 0) > FREQ.get("guap", 0), f"the={FREQ.get('the')} guap={FREQ.get('guap')}")


def items_of(song_id, gran=None):
    out = mask.items_for_song(BY_ID[song_id], PRON, FREQ)
    return [i for i in out if gran is None or i["granularity"] == gran]


ALL = [i for s in SONGS for i in mask.items_for_song(s, PRON, FREQ)]

# ---- determinism ----
again = [i for s in SONGS for i in mask.items_for_song(s, PRON, FREQ)]
third = [i for s in SONGS for i in mask.items_for_song(s, PRON, FREQ)]
check("determinism: 3x identical item lists", ALL == again == third,
      f"{len(ALL)} vs {len(again)} vs {len(third)}")
check("corpus yields items of all 4 granularities",
      {i["granularity"] for i in ALL} == {"word", "rhyme", "span", "line"},
      str(sorted({i['granularity'] for i in ALL})))

# ---- word policy ----
words = [i for i in ALL if i["granularity"] == "word"]
check("word: items exist", len(words) > 0, str(len(words)))


def line_tokens(item):
    song = BY_ID[item["songId"]]
    return mask.tokenize(song["sections"][item["si"]]["lines"][item["li"]])


check("word: never masks the line-final token",
      all(i["target"]["tokenIndex"] < len(line_tokens(i)) - 1 for i in words))
check("word: target never a stopword/filler",
      all(i["target"]["text"].lower() not in mask.STOP_AND_FILLER for i in words))
check("word: target length >= 3", all(len(i["target"]["text"]) >= 3 for i in words))
check("word: maskedLine carries the blank",
      all("____" in i["context"]["maskedLine"] for i in words))
check("word: target absent from maskedLine",
      all(i["target"]["text"] not in mask.tokenize(i["context"]["maskedLine"]) for i in words))

# ---- rhyme policy: both directions ----
check("rhyme: no-scheme stanza yields ZERO rhyme items",
      len(items_of("fx:noscheme", "rhyme")) == 0, str(items_of("fx:noscheme", "rhyme")))
g_rhymes = items_of("fx:golden1", "rhyme")
check("rhyme: clean AAAA stanza yields rhyme items", len(g_rhymes) >= 2, str(len(g_rhymes)))
check("rhyme: partner recorded in constraints.rhymeWith",
      all(i["constraints"]["rhymeWith"] for i in g_rhymes))
check("rhyme: target is the line-final token",
      all(i["target"]["tokenIndex"] == len(line_tokens(i)) - 1 for i in g_rhymes))
check("rhyme: partner is a different word from the target",
      all(i["constraints"]["rhymeWith"].lower() != i["target"]["text"].lower()
          for i in g_rhymes))

# ---- span policy ----
spans = [i for i in ALL if i["granularity"] == "span"]
check("span: items exist", len(spans) > 0, str(len(spans)))
check("span: 2-4 tokens, inside the line, never touching the final token",
      all(2 <= i["target"]["tokenSpan"][1] - i["target"]["tokenSpan"][0] <= 4
          and i["target"]["tokenSpan"][1] <= len(line_tokens(i)) - 1 for i in spans))
check("span: blank count matches span length",
      all(i["context"]["maskedLine"].count("____") ==
          i["target"]["tokenSpan"][1] - i["target"]["tokenSpan"][0] for i in spans))

# ---- line policy ----
lines = [i for i in ALL if i["granularity"] == "line"]
check("line: items exist", len(lines) > 0, str(len(lines)))
check("line: context arity >=2 before / >=1 after",
      all(len(i["context"]["before"]) >= 2 and len(i["context"]["after"]) >= 1
          for i in lines))
check("line: maskedLine is None", all(i["context"]["maskedLine"] is None for i in lines))
check("line: chorus sections never emit items (fx:sections)",
      all(i["sectionKind"] != "chorus" for i in items_of("fx:sections")))
check("line: lineSyllableTarget positive",
      all(i["constraints"]["lineSyllableTarget"] >= 1 for i in lines))
gl = items_of("fx:golden1", "line")
check("line: rhymeWith set when truth end-word rhymes with a visible context end-word",
      any(i["constraints"]["rhymeWith"] for i in gl), str([i["constraints"] for i in gl]))
ns_lines = items_of("fx:noscheme", "line")
check("line: rhymeWith None on the no-scheme stanza",
      all(not i["constraints"]["rhymeWith"] for i in ns_lines))

# ---- shared item shape ----
check("itemId embeds policy version + granularity",
      all(i["itemId"].startswith(mask.POLICY_VERSION + ":" + i["granularity"] + ":")
          for i in ALL))
check("phonesSource: lexicon word flagged, OOV flagged none",
      any(i["target"].get("phonesSource") == "lexicon" for i in words)
      and all(i["target"].get("phonesSource") in ("lexicon", "none")
              for i in ALL if i["granularity"] != "line"))
check("every item carries song identity + licenseTier + views",
      all(i["songId"] and "licenseTier" in i and "views" in i for i in ALL))

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

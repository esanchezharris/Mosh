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

# A rhyme item is only a test of RHYME if both ends are real words. Measured on
# the real dev split: 32.2% of rhyme items had a stopword or sub-3-char token at
# one end — the most-tested "rhyme words" were me / yeah / you / it / up. Those
# items ask "can you guess the word 'me'", which is function-word completion, and
# they were silently setting a third of the benchmark the program is about to
# optimize against.
from lyrics.bench.mask import STOP_AND_FILLER  # noqa: E402


def _junk(word):
    w = (word or "").lower()
    return len(w) < 3 or w in STOP_AND_FILLER


# An INLINE stanza, because the hand-authored fixture has no junk endings and
# would pass this check no matter what the policy did. Every line here ends in a
# stopword, and they all rhyme with each other, so a policy that does not filter
# will happily mint rhyme items from it.
JUNK_SONG = {
    "songId": "fx:junkends", "source": "test", "artist": "T", "title": "J",
    "genre": "rap", "views": 1, "licenseTier": "train-ok", "hash": "sha1:junk",
    "sections": [{"kind": "verse", "label": "Verse 1", "lines": [
        "everybody in the room look at me",
        "tell me what you really wanna be",
        "counting up the paper so casually",
        "nothing that they say could bother me",
    ]}],
}
# The stopwords need PHONES, or they are dropped as unpronounceable and the
# check passes for the wrong reason. (The shared fixture lexicon is frozen by the
# item golden, so this Pronouncer is local to the check.)
from phonology.core import Pronouncer  # noqa: E402
from lyrics.bench._testlex import LEX  # noqa: E402

JUNK_PRON = Pronouncer(lexicon={**LEX, "me": [["M", "IY1"]], "be": [["B", "IY1"]],
                                "casually": [["K", "AE1", "ZH", "AH0", "W", "AH0",
                                              "L", "IY0"]]},
                       g2p=lambda w: None)
JUNK_ITEMS = [i for i in mask.items_for_song(JUNK_SONG, JUNK_PRON, FREQ)
              if i["granularity"] == "rhyme"]
check("rhyme: a stanza whose lines all END in stopwords mints NO rhyme items",
      JUNK_ITEMS == [],
      str([(i["target"]["text"], i["constraints"]["rhymeWith"])
           for i in JUNK_ITEMS]))

ALL_RHYME = [i for i in ALL if i["granularity"] == "rhyme"]
check("rhyme: the masked TARGET is never a stopword or a 1-2 char token",
      not any(_junk(i["target"]["text"]) for i in ALL_RHYME),
      str([i["target"]["text"] for i in ALL_RHYME if _junk(i["target"]["text"])]))
check("rhyme: the PARTNER is never a stopword or a 1-2 char token",
      not any(_junk(i["constraints"]["rhymeWith"]) for i in ALL_RHYME),
      str([i["constraints"]["rhymeWith"] for i in ALL_RHYME
           if _junk(i["constraints"]["rhymeWith"])]))
check("rhyme: filtering junk ends does not empty the policy",
      len(ALL_RHYME) >= 2, str(len(ALL_RHYME)))
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


# ---- v3: the ad-lib wall ------------------------------------------------------------
# Ad-libs are a separate vocal layer (doubles, echoes, breath) that is not written to the
# rhyme scheme. Before this filter the frozen-v2 150 carried 8 unanswerable items (5.3%)
# whose ANSWER was an ad-lib — '(Box)' echoing "box", '(Woo-woo)' against partner 'bah'.
#
# FIXTURE ADEQUACY IS THE WHOLE DIFFICULTY HERE. A first version of this fixture used
# ad-lib endings that rhymed with nothing, so those items were already refused for having
# no rhyme partner and BOTH sabotages below passed — a vacuous guard that looked green.
# So every ad-lib ending here RHYMES with a real neighbour, i.e. each one WOULD mint an
# item if the wall were absent:
#   'sole' (parenthesised) is a perfect rhyme for the real 'whole';
#   'shine' (a pure ad-lib line) is a perfect rhyme for the real 'line', and is that
#   line's ONLY rhyming neighbour — so if ad-lib lines can donate partners, 'line'
#   mints an item with partner 'shine'.
ADLIB_SONG = {
    "songId": "fx:adlib", "source": "test", "artist": "T", "title": "A",
    "genre": "rap", "views": 1, "licenseTier": "train-ok", "hash": "sha1:adlib",
    "sections": [{"kind": "verse", "label": "Verse 1", "lines": [
        "we out here counting up the gold",       # 0 real ending: gold
        "i keep the paper in the whole",          # 1 real ending: whole (rhymes gold)
        "i had to let it go (sole)",              # 2 TRAILING ECHO, rhymes 'whole'
        "(shine)",                                # 3 pure ad-lib line, rhymes 'line'
        "everybody stepping on the line",         # 4 real, but its ONLY rhyming
                                                  #   neighbour is the ad-lib 'shine'
    ]}],
}
ADLIB_ITEMS = [i for i in mask.items_for_song(ADLIB_SONG, PRON, FREQ)
               if i["granularity"] == "rhyme"]
_ends = {i["target"]["text"].lower() for i in ADLIB_ITEMS}
_partners = {(i["constraints"]["rhymeWith"] or "").lower() for i in ADLIB_ITEMS}

check("adlib: a parenthesised END WORD mints no rhyme item (target wall)",
      "sole" not in _ends and "shine" not in _ends, str(sorted(_ends)))
check("adlib: an ad-lib line never donates the rhyme PARTNER (partner wall)",
      "shine" not in _partners and "sole" not in _partners, str(sorted(_partners)))
# Adequacy: with the walls removed these must APPEAR, or the two checks above are
# passing on an empty tree rather than on suppression.
check("adlib: FIXTURE ADEQUACY — the clean rhyme pair still mints items",
      _ends == {"gold", "whole"}, str(sorted(_ends)))
check("adlib: is_adlib_token discriminates trailing echo from leading ad-lib",
      mask.is_adlib_token("i had to let it go (sole)", 6)
      and not mask.is_adlib_token("(ay, ay) every single story getting told", 6),
      f"trailing={mask.is_adlib_token('i had to let it go (sole)', 6)} "
      f"leading={mask.is_adlib_token('(ay, ay) every single story getting told', 6)}")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)

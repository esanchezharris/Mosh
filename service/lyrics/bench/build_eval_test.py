#!/usr/bin/env python3
"""Golden tests for dedup + split assignment (FMS lyrics-bench I1).

The validity spine of the whole program lives here:
  - golden-artist songs appear in NO other split;
  - a near-duplicate of a golden song (cover/remix/re-release, even by ANOTHER
    artist) is QUARANTINED out of train/dev — the leak the fixture remix exercises;
  - exact dups collapse; synthetic-source songs can never enter golden;
  - split assignment is salted-hash-derived: same salt ⇒ identical 3x, and the
    salt never appears in the manifest (only its sha).

Run:  python3 service/lyrics/bench/build_eval_test.py     (exit 0 = all pass)
"""
import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, SERVICE)

from lyrics.bench import build_eval, dedup, mask  # noqa: E402
from lyrics.bench._testlex import make_pron  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


with open(os.path.join(HERE, "fixtures", "synthetic_songs.jsonl"), encoding="utf-8") as f:
    FIXTURES = [json.loads(ln) for ln in f if ln.strip()]

# ---- a wider synthetic population so train/dev fractions are exercised ----
_A = ["ledger", "winter", "pocket", "mirror", "engine", "corner", "静ic".replace("静", "stat"),
      "signal", "harbor", "circuit"]
_B = ["holding", "counting", "folding", "carving", "guarding", "trading",
      "molding", "sorting", "braiding", "shading"]


def synth_song(n):
    lines = [f"{_A[n % 10]} number {n} is {_B[(n + i) % 10]} the quiet route {i}"
             for i in range(4)]
    return {
        "songId": f"pop:{n:03d}", "source": "genius-fixture", "artist": f"Pop Artist {n % 7}",
        "title": f"Population Song {n}", "genre": "rap", "views": 100 + n,
        "licenseTier": "eval-only",
        "sections": [{"kind": "verse", "label": "Verse", "lines": lines}],
        "hash": f"sha1:pop{n:03d}",
    }


POP = [synth_song(n) for n in range(40)]
SONGS = FIXTURES + POP

GOLDEN_SPEC = {
    "version": 1,
    "artists": ["golden fixture"],          # case-insensitive match expected
    "songs": [{"artist": "Arrange Fixture", "title": "Three Rooms"}],
    "ownSources": [],
    "notes": "test spec",
}

SALT = "test-salt-1"
splits, report = build_eval.assign_splits(SONGS, GOLDEN_SPEC, salt=SALT, dev_frac=0.25)

# ---- golden matching ----
check("golden: artist match is case-insensitive",
      splits.get("fx:golden1") == "golden", str(splits.get("fx:golden1")))
check("golden: (artist,title) song match works",
      splits.get("fx:sections") == "golden", str(splits.get("fx:sections")))
check("golden: golden songs appear in NO other split",
      all(splits[sid] == "golden" for sid in ("fx:golden1", "fx:sections")))

# ---- the leak guard: remix of a golden song by ANOTHER artist ----
check("leak: 90%-overlap remix by another artist is quarantined",
      splits.get("fx:golden1-rmx") == "quarantined", str(splits.get("fx:golden1-rmx")))
check("leak: quarantined songs listed in the report",
      "fx:golden1-rmx" in report["quarantined"], str(report["quarantined"]))

# ---- exact-dup collapse ----
dup = copy.deepcopy(next(s for s in SONGS if s["songId"] == "fx:basement"))
dup["songId"] = "fx:zz-basement-copy"
splits2, report2 = build_eval.assign_splits(SONGS + [dup], GOLDEN_SPEC, salt=SALT,
                                            dev_frac=0.25)
check("exact dup: identical content hash collapses (later id dropped)",
      splits2.get("fx:zz-basement-copy") == "dropped"
      and splits2.get("fx:basement") not in (None, "dropped"),
      f"copy={splits2.get('fx:zz-basement-copy')} orig={splits2.get('fx:basement')}")

# ---- collab credits: "A & B" carries the golden artist's verses and must be
# golden; substring lookalikes ("Nick Drake" vs "Drake") must NOT match ----
def named(artist, sid, content_src="fx:basement"):
    s = copy.deepcopy(next(x for x in SONGS if x["songId"] == content_src))
    s["songId"], s["artist"] = sid, artist
    s["hash"] = "sha1:" + sid
    return s


# The lookalike gets DISTINCT content (fx:noscheme) so this isolates the artist
# matcher — same-content lookalikes are (correctly) caught by containment anyway.
collab_songs = SONGS + [named("Future Fixture & Golden Fixture", "cb:duo"),
                        named("Golden Fixture feat. Somebody Else", "cb:feat"),
                        named("Nick Golden Fixtureman", "cb:lookalike",
                              content_src="fx:noscheme")]
splits_cb, _ = build_eval.assign_splits(collab_songs, GOLDEN_SPEC, salt=SALT,
                                        dev_frac=0.25)
check("collab: 'A & golden-artist' credit is golden",
      splits_cb.get("cb:duo") == "golden", str(splits_cb.get("cb:duo")))
check("collab: 'golden-artist feat. X' credit is golden",
      splits_cb.get("cb:feat") == "golden", str(splits_cb.get("cb:feat")))
check("collab: substring lookalike artist is NOT golden",
      splits_cb.get("cb:lookalike") in ("train", "dev"),
      str(splits_cb.get("cb:lookalike")))

# ---- the golden-dup hole: an exact-content re-scrape of a golden song under a
# lexicographically EARLIER id whose artist string the spec does NOT match must
# not smuggle golden content into train/dev (review finding #2) ----
rescrape = copy.deepcopy(next(s for s in SONGS if s["songId"] == "fx:golden1"))
rescrape["songId"] = "aa:rescrape"                       # sorts before fx:golden1
rescrape["artist"] = "Golden Fixture feat. Somebody"     # spec doesn't match this
splits_rs, rep_rs = build_eval.assign_splits(SONGS + [rescrape], GOLDEN_SPEC,
                                             salt=SALT, dev_frac=0.25)
check("golden dup: exact twin of a golden song never lands in train/dev",
      splits_rs.get("aa:rescrape") not in ("train", "dev"),
      f"rescrape={splits_rs.get('aa:rescrape')}")
# With the collab matcher, "feat." credits ALSO spec-match, so either copy may
# be the kept one — the invariant is: exactly one survives, as golden, and the
# other is a dropped dup.
kept_pair = sorted([splits_rs.get("fx:golden1"), splits_rs.get("aa:rescrape")])
check("golden dup: one copy kept as golden, the other dropped",
      kept_pair == ["dropped", "golden"], str(kept_pair))

# ---- synthetic source never golden ----
synth = copy.deepcopy(next(s for s in SONGS if s["songId"] == "fx:golden1"))
synth["songId"], synth["source"], synth["hash"] = "syn:golden-clone", "synthetic", "sha1:synclone"
synth["sections"] = [{"kind": "verse", "label": "Verse",
                      "lines": ["completely different synthetic content here",
                                "second synthetic line with new words",
                                "third synthetic line keeps it moving",
                                "fourth synthetic line wraps the test"]}]
splits3, _ = build_eval.assign_splits(SONGS + [synth], GOLDEN_SPEC, salt=SALT, dev_frac=0.25)
check("synthetic source: never assigned to golden even when the artist matches",
      splits3.get("syn:golden-clone") in ("train", "dev"), str(splits3.get("syn:golden-clone")))

# ---- salted split behavior ----
pop_splits = {sid: sp for sid, sp in splits.items() if sid.startswith("pop:")}
check("population lands in both train and dev",
      "train" in pop_splits.values() and "dev" in pop_splits.values(),
      str(sorted(set(pop_splits.values()))))
same = all(build_eval.assign_splits(SONGS, GOLDEN_SPEC, salt=SALT, dev_frac=0.25)[0] == splits
           for _ in range(3))
check("determinism: same salt ⇒ identical splits 3x", same)
other_splits, _ = build_eval.assign_splits(SONGS, GOLDEN_SPEC, salt="different-salt",
                                           dev_frac=0.25)
other_pop = {sid: sp for sid, sp in other_splits.items() if sid.startswith("pop:")}
check("different salt ⇒ different train/dev partition", other_pop != pop_splits)

# ---- unmatched golden entries reported loudly ----
spec_typo = dict(GOLDEN_SPEC, artists=["golden fixture", "No Such Artist"])
_, rep_typo = build_eval.assign_splits(SONGS, spec_typo, salt=SALT, dev_frac=0.25)
check("unmatched golden artist reported", "no such artist" in
      [a.lower() for a in rep_typo["unmatchedArtists"]], str(rep_typo["unmatchedArtists"]))

# ---- items inherit split + manifest shape ----
pron = make_pron()
items, manifest = build_eval.build_items(SONGS, splits, pron,
                                         golden_spec=GOLDEN_SPEC, salt=SALT)
check("items: every item tagged with its song's split",
      all(i["split"] == splits[i["songId"]] for i in items))
check("items: no items from quarantined/dropped songs",
      all(i["split"] in ("train", "dev", "golden") for i in items))
check("manifest: policyVersion + goldenSpecSha + counts, salt NOT present",
      manifest["policyVersion"] == mask.POLICY_VERSION
      and len(manifest["goldenSpecSha"]) == 64
      and manifest["counts"]["golden"] > 0
      and SALT not in json.dumps(manifest)
      and len(manifest["saltSha"]) == 64)

# ---- dedup primitives ----
g1 = next(s for s in SONGS if s["songId"] == "fx:golden1")
rmx = next(s for s in SONGS if s["songId"] == "fx:golden1-rmx")
other = next(s for s in SONGS if s["songId"] == "fx:basement")
c_same = dedup.containment(dedup.shingles(rmx), dedup.build_pool_index([g1]))
c_diff = dedup.containment(dedup.shingles(other), dedup.build_pool_index([g1]))
check("dedup: remix containment high, unrelated containment low",
      c_same >= 0.5 > c_diff, f"remix={c_same:.2f} unrelated={c_diff:.2f}")

print(f"\n{len(fails)} failing" if fails else "\nall green")
sys.exit(1 if fails else 0)
